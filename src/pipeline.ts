import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readLog, logFromText, type LogDocument } from "./collectors/build-logs.js";
import { collectEnvironment, type EnvironmentSnapshot } from "./collectors/environment.js";
import { detectProject, summarizeProject, type ProjectContext } from "./detection/project-type.js";
import { finalize, runRules } from "./engine/runner.js";
import { parseLog } from "./parsers/index.js";
import { logEvidence } from "./parsers/types.js";
import { buildReport } from "./reports/export.js";
import { Redactor } from "./reports/redact.js";
import type { DraftFinding, Finding, Report, ReportInput } from "./reports/schema.js";

export interface CommonOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  redact?: string[];
  now?: Date;
}

export function makeRedactor(options: CommonOptions): Redactor {
  return new Redactor({
    ...(options.env ? { env: options.env } : {}),
    literals: options.redact ?? [],
  });
}

export interface ScanOptions extends CommonOptions {
  probeJava?: boolean;
  /** Run `npx expo-doctor` (network access) and include its output. */
  expoDoctor?: boolean;
}

export function runScan(options: ScanOptions): Report {
  const project = detectProject(options.cwd);
  const env = collectEnvironment({
    ...(options.env ? { env: options.env } : {}),
    probeJava: options.probeJava !== false && project.hasAndroid,
  });
  let findings = runRules({ project, env, logs: [] }, { project: true });
  if (options.expoDoctor && project.kind === "expo") {
    findings = finalize([
      ...findings.map(({ id: _id, ...f }) => f),
      runExpoDoctor(project, options.env),
    ]);
  }
  return buildReport({
    command: "scan",
    project: summarizeProject(project),
    inputs: [{ kind: "project", path: project.root, detectedFormats: [], truncated: false }],
    findings,
    redactor: makeRedactor(options),
    ...(options.now ? { now: options.now } : {}),
  });
}

export interface AnalyzeOptions extends CommonOptions {
  maxLogBytes?: number;
  /** Text read from stdin when a path is "-". */
  stdinText?: string;
}

export function runAnalyze(paths: string[], options: AnalyzeOptions): Report {
  const docs: LogDocument[] = paths.map((p) =>
    p === "-"
      ? logFromText("<stdin>", options.stdinText ?? "")
      : readLog(
          resolve(options.cwd, p),
          options.maxLogBytes ? { maxBytes: options.maxLogBytes } : {},
        ),
  );
  // Keep the path as supplied for readable evidence.
  docs.forEach((d, i) => {
    if (paths[i] !== "-") d.path = paths[i]!;
  });
  const project = detectProject(options.cwd);
  // Project context only helps (and is only shown) for Expo / React Native CLI projects.
  const usableProject: ProjectContext | undefined =
    project.kind === "expo" || project.kind === "react-native-cli" ? project : undefined;
  const env: EnvironmentSnapshot = collectEnvironment({
    ...(options.env ? { env: options.env } : {}),
    probeJava: false,
  });
  const logs = docs.map(parseLog);
  const findings: Finding[] = runRules(
    { ...(usableProject ? { project: usableProject } : {}), env, logs },
    { logs: true },
  );
  const inputs: ReportInput[] = logs.map((l) => ({
    kind: "log",
    path: l.doc.path,
    detectedFormats: l.formats,
    lineCount: l.doc.totalLines,
    truncated: l.doc.truncated,
    encoding: l.doc.encoding,
  }));
  return buildReport({
    command: "analyze",
    ...(usableProject ? { project: summarizeProject(usableProject) } : {}),
    inputs,
    findings,
    redactor: makeRedactor(options),
    ...(options.now ? { now: options.now } : {}),
  });
}

function runExpoDoctor(project: ProjectContext, env?: NodeJS.ProcessEnv): DraftFinding {
  const result = spawnSync("npx", ["--yes", "expo-doctor@latest"], {
    cwd: project.root,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...(env ?? process.env) },
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const base = {
    ruleId: "expo.expo-doctor",
    platforms: ["expo" as const],
    references: ["https://docs.expo.dev/develop/tools/#expo-doctor"],
  };
  if (result.error || result.status === null) {
    return {
      ...base,
      title: "Expo Doctor could not be run",
      severity: "info",
      confidence: "high",
      explanation: `Running \`npx expo-doctor\` failed: ${result.error?.message ?? "timed out"}. It requires network access to download and to fetch compatibility data.`,
      evidence: [],
      nextSteps: ["Run `npx expo-doctor` manually and include its output with this report."],
    };
  }
  const doc = logFromText("expo-doctor output", output);
  const passed = result.status === 0;
  return {
    ...base,
    title: passed ? "Expo Doctor checks passed" : "Expo Doctor reported problems",
    severity: passed ? "info" : "warning",
    confidence: "high",
    explanation: passed
      ? "Expo's official doctor found no problems."
      : "Expo's official doctor reported failed checks. Its output is included verbatim (redacted). These results come from Expo's tool, not from rn-build-doctor rules.",
    evidence: doc.lines.length
      ? [
          {
            ...logEvidence(doc, { start: 0, end: Math.min(doc.lines.length - 1, 60) }),
            source: "environment",
          },
        ]
      : [],
    nextSteps: passed
      ? ["No action needed for Expo Doctor's checks."]
      : ["Follow the advice printed by Expo Doctor for each failed check."],
  };
}
