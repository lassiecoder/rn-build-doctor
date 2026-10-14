import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lineNumber, normalizeLine, readLog } from "../../src/collectors/build-logs.js";
import { UsageError } from "../../src/errors.js";
import { runAnalyze } from "../../src/pipeline.js";
import { EMPTY_ENV, NO_PROJECT } from "../helpers/fixtures.js";

const dir = mkdtempSync(join(tmpdir(), "rnbd-logs-"));
const write = (name: string, data: string | Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

describe("normalizeLine", () => {
  it("strips ANSI codes, CI timestamps, and carriage-return overwrites", () => {
    expect(normalizeLine("\u001b[31mBUILD FAILED\u001b[0m")).toBe("BUILD FAILED");
    expect(normalizeLine("2026-10-12T09:14:02.1234567Z > Task :app:x")).toBe("> Task :app:x");
    expect(normalizeLine("progress 10%\rprogress 100%")).toBe("progress 100%");
    expect(normalizeLine("line\r")).toBe("line");
  });
});

describe("readLog", () => {
  it("reads UTF-16LE logs written by PowerShell redirection", () => {
    const text = "﻿line one\r\nSDK location not found. Define a valid SDK location\r\n";
    const p = write("ps.log", Buffer.from(text, "utf16le"));
    const doc = readLog(p);
    expect(doc.encoding).toBe("utf-16le");
    expect(doc.lines).toEqual(["line one", "SDK location not found. Define a valid SDK location"]);
  });

  it("rejects binary files and missing files with usage errors", () => {
    const p = write("bin.log", Buffer.from([0, 1, 2, 3, 0, 0, 5, 6, 0, 0, 1, 2]));
    expect(() => readLog(p)).toThrow(UsageError);
    expect(() => readLog(join(dir, "nope.log"))).toThrow(/not found/);
    expect(() => readLog(dir)).toThrow(UsageError);
  });

  it("handles empty logs", () => {
    const report = runAnalyze([write("empty.log", "")], { cwd: NO_PROJECT, env: EMPTY_ENV });
    expect(report.findings.map((f) => f.ruleId)).toEqual(["common.no-failure-detected"]);
  });

  it("keeps original line numbers when the middle of a huge log is omitted", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 200_000; i++) lines.push(`> Task :app:task${i} UP-TO-DATE`);
    lines.push(
      "FAILURE: Build failed with an exception.",
      "",
      "* What went wrong:",
      "SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.",
      "",
      "* Try:",
    );
    const p = write("huge.log", `${lines.join("\n")}\n`);
    const doc = readLog(p, { maxBytes: 256 * 1024 });
    expect(doc.truncated).toBe(true);
    expect(doc.totalLines).toBe(lines.length);
    const idx = doc.lines.findIndex((l) => l.startsWith("SDK location not found"));
    expect(lineNumber(doc, idx)).toBe(200_004);
    expect(doc.lines[0]).toBe("> Task :app:task1 UP-TO-DATE");
    expect(lineNumber(doc, doc.gapIndex - 1)).toBe(doc.gapIndex);

    const report = runAnalyze([p], { cwd: NO_PROJECT, env: EMPTY_ENV, maxLogBytes: 256 * 1024 });
    const f = report.findings.find((x) => x.ruleId === "android.sdk-location-not-found");
    expect(f?.evidence[0]?.line).toBe(200_004);
    expect(report.inputs[0]?.truncated).toBe(true);
  });

  it("keeps line numbers correct for truncated UTF-16 logs", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1}`);
    const p = write(
      "huge16.log",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join("\n") + "\n", "utf16le")]),
    );
    const doc = readLog(p, { maxBytes: 64 * 1024 });
    expect(doc.truncated).toBe(true);
    for (const i of [0, doc.gapIndex - 1, doc.gapIndex, doc.lines.length - 1]) {
      expect(doc.lines[i]).toBe(`line ${lineNumber(doc, i)}`);
    }
  });

  it("keeps line numbers correct for truncated UTF-8 logs", () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `ligne ${i + 1} — é`);
    const p = write("huge8.log", lines.join("\n") + "\n");
    const doc = readLog(p, { maxBytes: 100 * 1024 });
    for (const i of [0, doc.gapIndex - 1, doc.gapIndex, doc.lines.length - 1]) {
      expect(doc.lines[i]).toBe(`ligne ${lineNumber(doc, i)} — é`);
    }
    expect(doc.totalLines).toBe(50_000);
  });
});
