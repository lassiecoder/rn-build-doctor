import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { logFixture, projectFixture } from "../helpers/fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BIN = join(ROOT, "dist/cli/bin.js");
const NO_NETWORK = join(ROOT, "tests/helpers/no-network.cjs");

/** Minimal environment that still lets Node run on every OS (no user secrets passed through). */
function baseEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "Path",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  return Object.fromEntries(
    keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
}

function cli(
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(process.execPath, ["--require", NO_NETWORK, BIN, ...args], {
    cwd: options.cwd ?? ROOT,
    input: options.input ?? "",
    encoding: "utf8",
    env: { ...baseEnv(), NO_COLOR: "1", ...options.env },
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rnbd-cli-"));
  cpSync(projectFixture(name), dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  if (!existsSync(BIN))
    execFileSync("npm", ["run", "build"], {
      cwd: ROOT,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
});

describe("CLI", () => {
  it("prints help and version", () => {
    const help = cli(["--help"]);
    expect(help.code).toBe(0);
    for (const cmd of ["scan", "analyze", "report", "explain", "doctor"])
      expect(help.stdout).toContain(cmd);
    const version = cli(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
    );
  });

  it("uses exit code 2 for usage errors and missing inputs", () => {
    expect(cli(["frobnicate"]).code).toBe(2);
    expect(cli(["analyze"]).code).toBe(2);
    const missing = cli(["analyze", "does-not-exist.log", "--no-save"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Log file not found");
    expect(cli(["scan", "--fail-on", "fatal"]).code).toBe(2);
  });

  it("analyzes a log offline and honors --fail-on", () => {
    const dir = mkdtempSync(join(tmpdir(), "rnbd-empty-"));
    const ok = cli(["analyze", logFixture("android-agp-jdk.log"), "--no-save"], { cwd: dir });
    expect(ok.code).toBe(0);
    expect(ok.stderr).not.toContain("NETWORK ATTEMPT");
    expect(ok.stdout).toContain("android.agp-requires-newer-jdk");
    expect(
      cli(["analyze", logFixture("android-agp-jdk.log"), "--no-save", "--fail-on", "error"], {
        cwd: dir,
      }).code,
    ).toBe(1);
    expect(
      cli(["analyze", logFixture("android-success.log"), "--no-save", "--fail-on", "warning"], {
        cwd: dir,
      }).code,
    ).toBe(0);
  });

  it("reads logs from stdin", () => {
    const dir = mkdtempSync(join(tmpdir(), "rnbd-empty-"));
    const res = cli(["analyze", "-", "--json", "--no-save"], {
      cwd: dir,
      input: readFileSync(logFixture("ios-signing-team.log"), "utf8"),
    });
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.findings[0].ruleId).toBe("ios.code-signing");
    expect(report.findings[0].evidence[0].file).toBe("<stdin>");
  });

  it("reads stdin piped from a process that is still writing", async () => {
    // A live build pipes output slowly; readFileSync(0) used to fail with EAGAIN here.
    const log = readFileSync(logFixture("ios-signing-team.log"), "utf8");
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `const t=${JSON.stringify(log)};process.stdout.write(t.slice(0,40));setTimeout(()=>process.stdout.write(t.slice(40)),700);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const reader = spawn(
      process.execPath,
      ["--require", NO_NETWORK, BIN, "analyze", "-", "--json", "--no-save"],
      {
        cwd: mkdtempSync(join(tmpdir(), "rnbd-pipe-")),
        env: { ...baseEnv(), NO_COLOR: "1" },
        stdio: [writer.stdout, "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    reader.stdout.on("data", (d: Buffer) => (stdout += d));
    reader.stderr.on("data", (d: Buffer) => (stderr += d));
    const code = await new Promise<number | null>((done) => reader.on("close", done));
    expect(stderr).not.toContain("EAGAIN");
    expect(code).toBe(0);
    expect(JSON.parse(stdout).findings[0].ruleId).toBe("ios.code-signing");
  });

  it("scans offline, saves reports locally, and exports Markdown without secrets", () => {
    const dir = tempProject("expo-env-missing-in-eas");
    const scan = cli(["scan", "--no-java-probe"], { cwd: dir });
    expect(scan.code).toBe(0);
    expect(scan.stderr).not.toContain("NETWORK ATTEMPT");
    expect(existsSync(join(dir, ".rn-build-doctor/scan.json"))).toBe(true);
    expect(readFileSync(join(dir, ".rn-build-doctor/.gitignore"), "utf8")).toContain("*");

    writeFileSync(
      join(dir, "crash.log"),
      readFileSync(logFixture("runtime-missing-supabase-url.log")),
    );
    expect(cli(["analyze", "crash.log"], { cwd: dir }).code).toBe(0);

    const md = cli(["report"], { cwd: dir });
    expect(md.code).toBe(0);
    expect(md.stdout).toContain("expo.env-file-not-available-in-eas");
    expect(md.stdout).toContain("runtime.missing-configuration-suspected");
    // .env values are never read into the report.
    expect(md.stdout).not.toContain("abcd.supabase.co");

    const out = cli(["report", "--format", "json", "--output", "out.json"], { cwd: dir });
    expect(out.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).command).toBe("merged");
  });

  it("rejects corrupt reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "rnbd-empty-"));
    writeFileSync(join(dir, "bad.json"), '{"schemaVersion":"1.0","findings":"nope"}');
    const res = cli(["report", "--input", "bad.json"], { cwd: dir });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("not a valid rn-build-doctor report");
    expect(cli(["report"], { cwd: dir }).code).toBe(2);
  });

  it("explain --dry-run shows the redacted payload and sends nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rnbd-empty-"));
    cli(["analyze", logFixture("secrets.log")], { cwd: dir });
    const res = cli(["explain", "--dry-run"], { cwd: dir });
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain("NETWORK ATTEMPT");
    expect(res.stdout).toContain("--- user ---");
    expect(res.stdout).not.toContain("ghp_1234567890");
    expect(res.stdout).not.toContain("hunter2hunter2");
  });

  it("explain refuses to send without confirmation in non-interactive shells", () => {
    const dir = mkdtempSync(join(tmpdir(), "rnbd-empty-"));
    cli(["analyze", logFixture("android-agp-jdk.log")], { cwd: dir });
    const res = cli(["explain"], { cwd: dir });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--yes");
    expect(res.stderr).not.toContain("NETWORK ATTEMPT");
  });

  it("lists checks", () => {
    const res = cli(["doctor", "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).length).toBeGreaterThan(20);
  });

  it("handles unsupported layouts without crashing", () => {
    for (const name of ["not-a-project", "monorepo-root", "invalid-package-json"]) {
      const res = cli(["scan", "--no-save"], { cwd: projectFixture(name) });
      expect(res.code, name).toBe(0);
      expect(res.stdout).toContain("common.project-not-detected");
    }
  });
});
