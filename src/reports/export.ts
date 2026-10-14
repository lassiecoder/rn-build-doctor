import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../errors.js";
import { finalize } from "../engine/runner.js";
import { VERSION } from "../version.js";
import { REDACTION_NOTICE, type Redactor } from "./redact.js";
import {
  REPORT_SCHEMA_VERSION,
  ReportSchema,
  formatZodError,
  type Finding,
  type ProjectSummary,
  type Report,
  type ReportInput,
} from "./schema.js";

export const REPORT_DIR = ".rn-build-doctor";

export interface BuildReportInput {
  command: Report["command"];
  project?: ProjectSummary;
  inputs: ReportInput[];
  findings: Finding[];
  redactor: Redactor;
  now?: Date;
}

/** Builds a validated report. Every string in it passes through the redactor. */
export function buildReport(input: BuildReportInput): Report {
  const raw = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "rn-build-doctor", version: VERSION },
    command: input.command,
    generatedAt: (input.now ?? new Date()).toISOString(),
    ...(input.project ? { project: input.project } : {}),
    inputs: input.inputs,
    findings: input.findings,
    summary: {
      errors: input.findings.filter((f) => f.severity === "error").length,
      warnings: input.findings.filter((f) => f.severity === "warning").length,
      infos: input.findings.filter((f) => f.severity === "info").length,
    },
  };
  const { value, replacements } = input.redactor.redactDeep(raw);
  return ReportSchema.parse({
    ...value,
    redaction: { applied: true, replacements, notice: REDACTION_NOTICE },
  });
}

export function parseReport(text: string, source: string): Report {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const result = ReportSchema.safeParse(json);
  if (!result.success) {
    throw new UsageError(
      `${source} is not a valid rn-build-doctor report (schema ${REPORT_SCHEMA_VERSION}):\n${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function loadReport(path: string): Report {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UsageError(
      code === "ENOENT"
        ? `Report not found: ${path}`
        : `Unable to read report ${path}: ${(error as Error).message}`,
    );
  }
  return parseReport(text, path);
}

/** Saves a report under <root>/.rn-build-doctor/<command>.json and keeps the folder out of git. */
export function saveReport(root: string, report: Report): string {
  const dir = join(root, REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "# Created by rn-build-doctor: reports stay local.\n*\n");
  const file = join(dir, `${report.command}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/** Loads the saved scan and analyze reports in a directory, in a stable order. */
export function loadSavedReports(root: string): { path: string; report: Report }[] {
  const dir = join(root, REPORT_DIR);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f === "scan.json" || f === "analyze.json")
      .sort()
      .reverse();
  } catch {
    return [];
  }
  return files.map((f) => ({ path: join(dir, f), report: loadReport(join(dir, f)) }));
}

/** Combines reports into one, renumbering finding ids. */
export function mergeReports(reports: Report[], redactor: Redactor, now?: Date): Report {
  if (reports.length === 1) return reports[0]!;
  const findings = finalize(reports.flatMap((r) => r.findings.map(({ id: _id, ...rest }) => rest)));
  const project = reports.find((r) => r.project)?.project;
  return buildReport({
    command: "merged",
    ...(project ? { project } : {}),
    inputs: reports.flatMap((r) => r.inputs),
    findings,
    redactor,
    ...(now ? { now } : {}),
  });
}

// --- Markdown --------------------------------------------------------------------------------

const ICON: Record<Finding["severity"], string> = { error: "🛑", warning: "⚠️", info: "ℹ️" };

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}text\n${text}\n${ticks}`;
}

function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]<>|])/g, "\\$1");
}

export function toMarkdown(report: Report): string {
  const out: string[] = [];
  out.push(`# RN Build Doctor report`, "");
  out.push(
    `Generated ${report.generatedAt} by rn-build-doctor ${report.tool.version} (\`${report.command}\`, report schema ${report.schemaVersion}).`,
    "",
  );
  out.push(
    `> ${report.redaction.notice} (${report.redaction.replacements} replacement${report.redaction.replacements === 1 ? "" : "s"}.)`,
    "",
  );
  out.push(
    `**Summary:** ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.infos} info.`,
    "",
  );

  if (report.project) {
    const p = report.project;
    out.push(
      "## Project",
      "",
      `- Type: ${p.kind}`,
      `- Package manager: ${p.packageManager ?? "unknown"}${p.lockfiles.length ? ` (${p.lockfiles.join(", ")})` : ""}`,
    );
    out.push(
      `- Native folders: android ${p.hasAndroid ? "yes" : "no"}, ios ${p.hasIos ? "yes" : "no"}`,
    );
    for (const [k, v] of Object.entries(p.versions))
      out.push(`- ${escapeInline(k)}: ${escapeInline(v)}`);
    for (const [k, v] of Object.entries(p.environment ?? {}))
      out.push(`- ${escapeInline(k)} (this machine): ${escapeInline(v)}`);
    for (const n of p.notes) out.push(`- Note: ${escapeInline(n)}`);
    out.push("");
  }
  if (report.inputs.length) {
    out.push("## Inputs", "");
    for (const i of report.inputs) {
      const extra = [
        i.detectedFormats.length ? `formats: ${i.detectedFormats.join(", ")}` : undefined,
        i.lineCount !== undefined ? `${i.lineCount} lines` : undefined,
        i.truncated ? "truncated (middle omitted)" : undefined,
        i.encoding && i.encoding !== "utf-8" ? i.encoding : undefined,
      ].filter(Boolean);
      out.push(`- ${i.kind}: \`${i.path}\`${extra.length ? ` (${extra.join("; ")})` : ""}`);
    }
    out.push("");
  }

  out.push("## Findings", "");
  if (!report.findings.length) out.push("No findings.", "");
  for (const f of report.findings) {
    out.push(`### ${ICON[f.severity]} ${f.id}: ${escapeInline(f.title)}`, "");
    out.push(
      `- Rule: \`${f.ruleId}\``,
      `- Severity: ${f.severity}`,
      `- Confidence: ${f.confidence}`,
      `- Platforms: ${f.platforms.join(", ")}`,
      "",
    );
    out.push(f.explanation, "");
    if (f.evidence.length) {
      out.push("**Evidence**", "");
      for (const e of f.evidence) {
        const loc = [e.file, e.line].filter((x) => x !== undefined).join(":");
        out.push(
          `- ${e.source}${loc ? ` \`${loc}\`` : ""}${e.detail ? `: ${escapeInline(e.detail)}` : ""}`,
        );
        if (e.excerpt)
          out.push(
            "",
            fence(e.excerpt)
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n"),
            "",
          );
      }
      out.push("");
    }
    out.push("**Next steps**", "", ...f.nextSteps.map((s, i) => `${i + 1}. ${s}`), "");
    if (f.verification) out.push(`**Verify:** ${f.verification}`, "");
    if (f.limitations.length)
      out.push("**Limitations**", "", ...f.limitations.map((l) => `- ${l}`), "");
    if (f.references.length)
      out.push("**References**", "", ...f.references.map((r) => `- <${r}>`), "");
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
