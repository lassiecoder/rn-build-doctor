import { describe, expect, it } from "vitest";
import { logFromText } from "../../src/collectors/build-logs.js";
import { parseRuntime } from "../../src/parsers/runtime.js";
import { stripLogcatPrefix } from "../../src/parsers/types.js";
import { runAnalyze } from "../../src/pipeline.js";
import { groupJsExceptions } from "../../src/rules/common/runtime-rules.js";
import { EMPTY_ENV, NO_PROJECT, logFixture, projectFixture } from "../helpers/fixtures.js";

const analyze = (name: string) =>
  runAnalyze([logFixture(name)], { cwd: NO_PROJECT, env: EMPTY_ENV });

describe("logcat runtime parsing", () => {
  it("reads the process id from threadtime and brief formats", () => {
    expect(stripLogcatPrefix("10-15 00:59:27.007  4653  4760 E ReactNativeJS: boom")).toEqual({
      tag: "ReactNativeJS",
      pid: "4653",
      tid: "4760",
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
    expect(js.evidence[0]!.detail).toContain("Only lines from thread 4760 of process 4653");
  });

  it("shows only lines from the exception's thread when other threads of the app interleave", () => {
    const report = analyze("real-logcat-bridgeless-js-abort.log");
    const js = report.findings.find((f) => f.ruleId === "runtime.javascript-exception")!;
    const excerpt = js.evidence[0]!.excerpt!;
    const tids = new Set(excerpt.split("\n").map((l) => stripLogcatPrefix(l).tid));
    expect([...tids]).toEqual(["5158"]);
    expect(excerpt).toContain("handleHostException");
    expect(excerpt).not.toContain("GIF decoder");
    expect(js.evidence[0]!.detail).toContain("Only lines from thread 5158 of process 5134");
  });

  it("reports that an uncaught exception killed the process (bridgeless SIGABRT)", () => {
    const report = analyze("real-logcat-bridgeless-js-abort.log");
    const js = report.findings.find((f) => f.ruleId === "runtime.javascript-exception")!;
    expect(js.explanation).toContain("the app crashed");
    expect(js.explanation).toContain("SIGABRT");
    const signal = js.evidence.find((e) => e.detail?.startsWith("The process was then killed"))!;
    expect(signal.detail).toBe("The process was then killed by SIGABRT on thread mqt_v_js");
    expect(signal.excerpt).toContain("Fatal signal 6 (SIGABRT)");
  });

  it("doesn't claim a crash when the JS error isn't followed by a fatal signal", () => {
    const report = analyze("real-logcat-js-startup-crash.log");
    const js = report.findings.find((f) => f.ruleId === "runtime.javascript-exception")!;
    expect(js.explanation).not.toContain("crashed");
    expect(js.evidence.some((e) => e.detail?.includes("killed by"))).toBe(false);
  });

  it("ignores a fatal signal on another thread or in another process", () => {
    const doc = logFromText(
      "x.log",
      [
        "10-15 00:00:01.000   100   101 E ReactNativeJS: Error: boom",
        "10-15 00:00:01.100   100   107 F libc    : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0 in tid 107 (RenderThread), pid 100 (com.myapp)",
        "10-15 00:00:01.200   200   201 F libc    : Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE) in tid 201 (mqt_v_js), pid 200 (com.other)",
      ].join("\n"),
    );
    expect(parseRuntime(doc).jsExceptions[0]!.termination).toBeUndefined();
  });

  it("tags the missing-configuration finding with expo only for Expo projects", () => {
    const run = (project: string) =>
      runAnalyze([logFixture("real-logcat-bridgeless-js-abort.log")], {
        cwd: projectFixture(project),
        env: EMPTY_ENV,
      }).findings.find((f) => f.ruleId === "runtime.missing-configuration-suspected")!;
    expect(run("rn-cli-clean").platforms).toEqual(["javascript"]);
    expect(run("expo-clean").platforms).toEqual(["javascript", "expo"]);
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

describe("wording for real-world variants", () => {
  it("names CocoaPods when a pod install succeeded", () => {
    const f = analyze("real-cocoapods-install-success.log").findings[0]!;
    expect(f.ruleId).toBe("common.no-failure-detected");
    expect(f.explanation).toContain("CocoaPods install");
  });

  it("calls a javac-only failure a Java error", () => {
    const f = analyze("real-rn087-gradle-java-error.log").findings[0]!;
    expect(f.explanation).toMatch(
      /^The Java compiler reported 1 error, so :app:compileDebugJavaWithJavac failed\./,
    );
  });

  it("points to gradle.properties instead of listing every possible source", () => {
    const report = runAnalyze([logFixture("real-gradle93-jvm-maxpermsize.log")], {
      cwd: projectFixture("rn-cli-old-permgen"),
      env: EMPTY_ENV,
    });
    const f = report.findings[0]!;
    expect(f.explanation).toContain(
      "set by org.gradle.jvmargs in android/gradle.properties (line 3).",
    );
    expect(f.explanation).not.toContain("GRADLE_OPTS");
  });

  it("gives React Native CLI advice for missing configuration in a CLI project", () => {
    const report = runAnalyze([logFixture("real-logcat-js-startup-crash.log")], {
      cwd: projectFixture("rn-cli-clean"),
      env: EMPTY_ENV,
    });
    const f = report.findings.find((x) => x.ruleId === "runtime.missing-configuration-suspected")!;
    const steps = f.nextSteps.join(" ");
    expect(steps).toContain("react-native-config");
    expect(steps).not.toContain("eas env:list");
  });
});
