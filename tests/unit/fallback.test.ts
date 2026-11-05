import { describe, expect, it } from "vitest";
import { logFromText } from "../../src/collectors/build-logs.js";
import { runRules } from "../../src/engine/runner.js";
import { parseLog } from "../../src/parsers/index.js";

const analyze = (text: string) =>
  runRules({ logs: [parseLog(logFromText("build.log", text))] }, { logs: true });

describe("no-supported-diagnosis excerpts", () => {
  it("shows the error before 'Command … failed' and puts the summary line last", () => {
    const [f] = analyze(
      [
        "** BUILD FAILED **",
        "Running script 'Upload source maps'",
        "upload-sourcemaps: unknown flag --strict",
        "Command PhaseScriptExecution failed with a nonzero exit code",
      ].join("\n"),
    );
    expect(f?.ruleId).toBe("common.no-supported-diagnosis");
    const excerpts = f!.evidence.map((e) => e.excerpt ?? "");
    expect(excerpts[0]).toContain("upload-sourcemaps: unknown flag --strict");
    expect(excerpts.at(-1)).toContain("** BUILD FAILED **");
  });

  it("treats a CMake error as a failure line", () => {
    const [f] = analyze(
      "CMake Error at CMakeLists.txt:3 (project):\n  No CMAKE_CXX_COMPILER could be found.",
    );
    expect(f?.ruleId).toBe("common.no-supported-diagnosis");
    expect(f!.evidence[0]!.excerpt).toContain("CMake Error");
  });
});
