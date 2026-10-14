import { describe, expect, it } from "vitest";
import { logFromText } from "../../src/collectors/build-logs.js";
import { parseRuntime } from "../../src/parsers/runtime.js";
import { stripLogcatPrefix } from "../../src/parsers/types.js";
import { runAnalyze } from "../../src/pipeline.js";
import { groupJsExceptions } from "../../src/rules/common/runtime-rules.js";
import { EMPTY_ENV, NO_PROJECT, logFixture } from "../helpers/fixtures.js";

const analyze = (name: string) =>
  runAnalyze([logFixture(name)], { cwd: NO_PROJECT, env: EMPTY_ENV });

describe("logcat runtime parsing", () => {
  it("reads the process id from threadtime and brief formats", () => {
    expect(stripLogcatPrefix("10-15 00:59:27.007  4653  4760 E ReactNativeJS: boom")).toEqual({
      tag: "ReactNativeJS",
      pid: "4653",
      message: "boom",
    });
    expect(stripLogcatPrefix("E/ReactNativeJS( 4653): boom")).toMatchObject({ pid: "4653" });
  });

  it("shows only lines from the crashing process in a noisy logcat", () => {
    const report = analyze("real-logcat-js-startup-crash.log");
    const js = report.findings.find((f) => f.ruleId === "runtime.javascript-exception")!;
    const excerpt = js.evidence[0]!.excerpt!;
    const pids = new Set(excerpt.split("\n").map((l) => stripLogcatPrefix(l).pid));
    expect([...pids]).toEqual(["4653"]);
    expect(excerpt).not.toContain("PackageWatchdog");
    expect(js.evidence[0]!.detail).toContain("Only lines from process 4653");
  });

  it("reports follow-on errors as evidence of the first error, not as separate findings", () => {
    const report = analyze("real-logcat-js-startup-crash.log");
    const js = report.findings.filter((f) => f.ruleId === "runtime.javascript-exception");
    expect(js).toHaveLength(1);
    expect(js[0]!.title).toContain("API_URL is not configured");
    const followOns = js[0]!.evidence.filter((e) => e.detail?.startsWith("Follow-on error"));
    expect(followOns.map((e) => e.detail)).toEqual([
      expect.stringContaining("has not been registered"),
      expect.stringContaining("Global was not installed"),
    ]);
  });

  it("keeps a follow-on error separate when it comes from another process", () => {
    const doc = logFromText(
      "x.log",
      [
        "10-15 00:00:01.000  100  100 E ReactNativeJS: Error: first app failed",
        '10-15 00:00:02.000  200  200 E ReactNativeJS: Invariant Violation: "Other" has not been registered.',
      ].join("\n"),
    );
    const groups = groupJsExceptions(parseRuntime(doc).jsExceptions);
    expect(groups.map((g) => g.followOns.length)).toEqual([0, 0]);
  });

  it("keeps an unrelated later error as its own finding", () => {
    const doc = logFromText(
      "x.log",
      [
        "10-15 00:00:01.000  100  100 E ReactNativeJS: Error: first",
        "10-15 00:00:02.000  100  100 E ReactNativeJS: TypeError: undefined is not a function",
      ].join("\n"),
    );
    expect(groupJsExceptions(parseRuntime(doc).jsExceptions)).toHaveLength(2);
  });
});

describe("iOS linker formats", () => {
  it("names the library for the classic ld64 message", () => {
    const f = analyze("ios-linker.log").findings.find((x) => x.ruleId === "ios.linker-error")!;
    expect(f.title).toBe("Linker could not find library 'Pods-MyApp'");
    expect(f.nextSteps.join(" ")).toContain(".xcworkspace");
  });

  it("names the library for the Xcode 15+ linker message", () => {
    const f = analyze("real-xcode26-linker-library-not-found.log").findings.find(
      (x) => x.ruleId === "ios.linker-error",
    )!;
    expect(f.title).toBe("Linker could not find library 'rnbdmissing'");
    expect(f.nextSteps.join(" ")).not.toContain("pod deintegrate");
  });
});

describe("successful runs", () => {
  it("recognizes a successful react-native bundle", () => {
    const f = analyze("real-rn086-metro-bundle-success.log").findings[0]!;
    expect(f.title).toBe("The log shows a successful build");
    expect(f.explanation).toContain("JavaScript bundle");
  });
});
