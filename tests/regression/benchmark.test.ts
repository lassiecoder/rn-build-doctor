import { describe, expect, it } from "vitest";
import { runAnalyze, runScan } from "../../src/pipeline.js";
import type { Report } from "../../src/reports/schema.js";
import { join } from "node:path";
import {
  EMPTY_ENV,
  FIXED_NOW,
  FIXTURES,
  NO_PROJECT,
  logFixture,
  projectFixture,
} from "../helpers/fixtures.js";
import { CASES, type Case } from "./cases.js";

function run(c: Case): Report {
  if (c.kind === "project") {
    return runScan({
      cwd: projectFixture(c.input),
      env: c.javaHome ? { JAVA_HOME: join(FIXTURES, "jdks", c.javaHome) } : EMPTY_ENV,
      probeJava: false,
      now: FIXED_NOW,
    });
  }
  return runAnalyze([logFixture(c.input)], {
    cwd: c.cwd ? projectFixture(c.cwd) : NO_PROJECT,
    env: EMPTY_ENV,
    now: FIXED_NOW,
  });
}

const actionable = (r: Report) => [
  ...new Set(r.findings.filter((f) => f.severity !== "info").map((f) => f.ruleId)),
];

describe("labeled regression cases", () => {
  for (const c of CASES) {
    it(`${c.kind}: ${c.name}`, () => {
      const report = run(c);
      expect(actionable(report).sort()).toEqual([...c.expect].sort());
      const all = report.findings.map((f) => f.ruleId);
      for (const id of c.info ?? []) expect(all).toContain(id);
      for (const id of c.forbid ?? []) expect(all).not.toContain(id);
      expect(all).not.toContain("internal.rule-error");
      // Every non-informational finding carries evidence.
      for (const f of report.findings.filter((x) => x.severity !== "info"))
        expect(f.evidence.length).toBeGreaterThan(0);
      if (c.mustMention?.length) {
        const target = report.findings.filter((f) => f.ruleId === c.expect[0]);
        const text = JSON.stringify(target);
        for (const needle of c.mustMention) expect(text).toContain(needle);
      }
    });
  }

  it("is deterministic: the same input produces identical reports", () => {
    for (const c of CASES) expect(JSON.stringify(run(c))).toEqual(JSON.stringify(run(c)));
  });

  it("meets the release thresholds on this benchmark", () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const c of CASES) {
      const got = new Set(actionable(run(c)));
      const want = new Set(c.expect);
      for (const id of got) {
        if (want.has(id)) tp++;
        else fp++;
      }
      for (const id of want) if (!got.has(id)) fn++;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    console.log(
      `benchmark: ${CASES.length} cases, TP ${tp}, FP ${fp}, FN ${fn}, precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}%`,
    );
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(fp).toBe(0);
  });
});
