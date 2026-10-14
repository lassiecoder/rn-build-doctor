import { describe, expect, it } from "vitest";
import { finalize } from "../../src/engine/runner.js";
import { UsageError } from "../../src/errors.js";
import { mergeReports, parseReport, toMarkdown } from "../../src/reports/export.js";
import { Redactor } from "../../src/reports/redact.js";
import { FindingSchema, type DraftFinding } from "../../src/reports/schema.js";
import { runAnalyze, runScan } from "../../src/pipeline.js";
import {
  EMPTY_ENV,
  FIXED_NOW,
  NO_PROJECT,
  logFixture,
  projectFixture,
} from "../helpers/fixtures.js";

const draft = (over: Partial<DraftFinding> = {}): DraftFinding => ({
  ruleId: "test.rule",
  title: "t",
  severity: "error",
  confidence: "high",
  platforms: ["common"],
  explanation: "e",
  evidence: [{ source: "log", detail: "d" }],
  nextSteps: ["n"],
  references: [],
  ...over,
});

describe("finding schema", () => {
  it("requires evidence for errors and warnings", () => {
    expect(
      FindingSchema.safeParse({ ...draft({ evidence: [] }), id: "F1", limitations: [] }).success,
    ).toBe(false);
    expect(
      FindingSchema.safeParse({
        ...draft({ severity: "info", evidence: [] }),
        id: "F1",
        limitations: [],
      }).success,
    ).toBe(true);
  });

  it("turns invalid rule output into an internal finding instead of emitting it", () => {
    const [f] = finalize([draft({ evidence: [] })]);
    expect(f?.ruleId).toBe("internal.rule-error");
  });

  it("deduplicates and sorts by severity then confidence", () => {
    const out = finalize([
      draft({ ruleId: "b.info", severity: "info", evidence: [] }),
      draft({ ruleId: "a.warn", severity: "warning", confidence: "low" }),
      draft({ ruleId: "a.err", confidence: "medium" }),
      draft({ ruleId: "a.err", confidence: "medium" }),
    ]);
    expect(out.map((f) => [f.id, f.ruleId])).toEqual([
      ["F1", "a.err"],
      ["F2", "a.warn"],
      ["F3", "b.info"],
    ]);
  });
});

describe("report files", () => {
  const report = runAnalyze([logFixture("android-agp-jdk.log")], {
    cwd: NO_PROJECT,
    env: EMPTY_ENV,
    now: FIXED_NOW,
  });

  it("round-trips through JSON", () => {
    expect(parseReport(JSON.stringify(report), "r.json")).toEqual(report);
  });

  it("rejects corrupt or foreign reports with clear errors", () => {
    expect(() => parseReport("{not json", "r.json")).toThrow(UsageError);
    expect(() => parseReport(JSON.stringify({ hello: 1 }), "r.json")).toThrow(
      /not a valid rn-build-doctor report/,
    );
    const tampered = JSON.parse(JSON.stringify(report));
    tampered.findings[0].severity = "fatal";
    expect(() => parseReport(JSON.stringify(tampered), "r.json")).toThrow(/findings\.0\.severity/);
    expect(() =>
      parseReport(JSON.stringify({ ...report, schemaVersion: "9.9" }), "r.json"),
    ).toThrow(UsageError);
  });

  it("merges scan and analyze reports with renumbered ids", () => {
    const scan = runScan({
      cwd: projectFixture("expo-env-missing-in-eas"),
      env: EMPTY_ENV,
      probeJava: false,
      now: FIXED_NOW,
    });
    const merged = mergeReports([scan, report], new Redactor({ env: EMPTY_ENV }), FIXED_NOW);
    expect(merged.command).toBe("merged");
    expect(merged.findings.length).toBe(scan.findings.length + report.findings.length);
    expect(merged.findings.map((f) => f.id)).toEqual(merged.findings.map((_, i) => `F${i + 1}`));
    expect(merged.summary.errors).toBe(1);
  });

  it("renders Markdown with evidence and fenced excerpts", () => {
    const md = toMarkdown(report);
    expect(md).toContain("# RN Build Doctor report");
    expect(md).toContain("android.agp-requires-newer-jdk");
    expect(md).toMatch(/```text\n/);
    expect(md).toContain("**Next steps**");
  });
});
