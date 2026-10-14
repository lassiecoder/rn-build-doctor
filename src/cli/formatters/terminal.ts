import pc from "picocolors";
import type { CheckedExplanation } from "../../ai/explain.js";
import type { RuleMeta } from "../../engine/rule.js";
import type { Finding, Report } from "../../reports/schema.js";

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  error: pc.red(pc.bold("ERROR")),
  warning: pc.yellow(pc.bold("WARN ")),
  info: pc.cyan(pc.bold("INFO ")),
};

const MAX_EXCERPT_LINES = 10;

function indent(text: string, prefix = "    "): string {
  return text
    .split("\n")
    .map((l) => `${prefix}${l}`)
    .join("\n");
}

function excerpt(text: string): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, MAX_EXCERPT_LINES);
  if (lines.length > MAX_EXCERPT_LINES)
    shown.push(pc.dim(`… ${lines.length - MAX_EXCERPT_LINES} more line(s) in the report`));
  return shown.join("\n");
}

export function formatFinding(f: Finding, verbose = false): string {
  const out: string[] = [];
  out.push(`${SEVERITY_LABEL[f.severity]} ${pc.bold(f.id)} ${f.title}`);
  out.push(pc.dim(`      ${f.ruleId} · confidence ${f.confidence} · ${f.platforms.join(", ")}`));
  out.push(indent(f.explanation, "      "));
  const evidence = verbose ? f.evidence : f.evidence.slice(0, 3);
  if (evidence.length) {
    out.push(pc.bold("      Evidence:"));
    for (const e of evidence) {
      const loc = [e.file, e.line].filter((x) => x !== undefined).join(":");
      out.push(
        `      - ${pc.dim(e.source)}${loc ? ` ${pc.underline(loc)}` : ""}${e.detail ? ` ${e.detail}` : ""}`,
      );
      if (e.excerpt) out.push(pc.gray(indent(excerpt(e.excerpt), "        │ ")));
    }
    if (f.evidence.length > evidence.length)
      out.push(
        pc.dim(
          `      … ${f.evidence.length - evidence.length} more evidence item(s) in the report`,
        ),
      );
  }
  out.push(pc.bold("      Next steps:"));
  f.nextSteps.forEach((s, i) => out.push(`      ${i + 1}. ${s}`));
  if (f.verification) out.push(`      ${pc.bold("Verify:")} ${f.verification}`);
  for (const l of f.limitations) out.push(pc.dim(`      Limitation: ${l}`));
  if (verbose) for (const r of f.references) out.push(pc.dim(`      Ref: ${r}`));
  return out.join("\n");
}

export function formatReport(
  report: Report,
  options: { verbose?: boolean; savedTo?: string } = {},
): string {
  const out: string[] = [];
  const p = report.project;
  if (p) {
    const versions = Object.entries(p.versions)
      .slice(0, 6)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    out.push(
      `${pc.bold("Project:")} ${p.kind}${p.packageManager ? ` · ${p.packageManager}` : ""}${p.hasAndroid ? " · android/" : ""}${p.hasIos ? " · ios/" : ""}`,
    );
    if (versions) out.push(pc.dim(`         ${versions}`));
    const environment = Object.entries(p.environment ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    if (environment) out.push(pc.dim(`         this machine: ${environment}`));
  }
  for (const input of report.inputs.filter((i) => i.kind === "log")) {
    out.push(
      `${pc.bold("Log:")} ${input.path} ${pc.dim(`(${input.lineCount ?? "?"} lines${input.detectedFormats.length ? `; ${input.detectedFormats.join(", ")}` : "; no known format"}${input.truncated ? "; middle omitted" : ""})`)}`,
    );
  }
  out.push("");
  if (!report.findings.length) out.push(pc.green("No findings."), "");
  for (const f of report.findings) out.push(formatFinding(f, options.verbose), "");
  const s = report.summary;
  out.push(
    `${pc.bold("Summary:")} ${s.errors ? pc.red(`${s.errors} error(s)`) : "0 errors"}, ${s.warnings ? pc.yellow(`${s.warnings} warning(s)`) : "0 warnings"}, ${s.infos} info`,
  );
  if (report.redaction.replacements)
    out.push(
      pc.dim(`Redacted ${report.redaction.replacements} value(s) that looked like secrets.`),
    );
  if (options.savedTo)
    out.push(
      pc.dim(`Saved ${options.savedTo}. Run \`rn-build-doctor report\` to export Markdown.`),
    );
  return out.join("\n");
}

export function formatCatalog(rules: RuleMeta[]): string {
  const out: string[] = [];
  const groups = new Map<string, RuleMeta[]>();
  for (const r of rules) {
    const key = r.scope === "project" ? "Project checks (scan)" : "Log analysis (analyze)";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [group, list] of groups) {
    out.push(pc.bold(group));
    for (const r of list) {
      out.push(`  ${pc.cyan(r.id.padEnd(42))} ${r.title}`);
      out.push(
        pc.dim(
          `  ${"".padEnd(42)} ${r.platforms.join(", ")} · ${r.versionScope} · verified ${r.lastVerified}`,
        ),
      );
    }
    out.push("");
  }
  out.push(pc.bold("Supported inputs"));
  out.push(
    "  Projects: Expo (managed and with native folders), React Native CLI. Monorepo roots: point --cwd at the app.",
  );
  out.push(
    "  Logs: Gradle, Metro/Expo CLI, xcodebuild/xcpretty/EAS, CocoaPods, adb logcat, iOS crash reports (.crash text and .ips).",
  );
  out.push("");
  out.push(pc.bold("Limitations"));
  out.push(
    "  - Diagnoses only patterns listed above; anything else is reported as 'no supported diagnosis' with excerpts.",
  );
  out.push(
    "  - Cannot see EAS/CI environment variables, cloud build logs, or devices unless you supply logs.",
  );
  out.push("  - Does not run builds and never modifies project files.");
  out.push("  - Redaction is best-effort; review reports before sharing.");
  return out.join("\n");
}

export function formatAiExplanation(
  e: CheckedExplanation,
  meta: { provider: string; model: string; servedBy?: string },
): string {
  const out: string[] = [];
  out.push(pc.magenta(pc.bold("AI suggestions — unverified, generated by a language model")));
  out.push(
    pc.dim(
      `Provider ${meta.provider}, model ${meta.model}${meta.servedBy ? ` (served by ${meta.servedBy})` : ""}. These don't change the deterministic findings.`,
    ),
  );
  out.push("", pc.bold("Summary"), indent(e.summary, "  "), "");
  out.push(pc.bold("Possible causes"));
  e.likelyCauses.forEach((c, i) => {
    const support = c.unsupported
      ? pc.yellow("not supported by any report finding")
      : `supported by ${c.supportingFindingIds.join(", ")}`;
    out.push(`  ${i + 1}. [${c.likelihood}] ${c.cause} ${pc.dim(`(${support})`)}`);
    out.push(indent(c.explanation, "     "));
    if (c.invalidReferences.length)
      out.push(
        pc.yellow(
          `     Ignored references to non-existent findings: ${c.invalidReferences.join(", ")}`,
        ),
      );
  });
  if (e.missingInformation.length)
    out.push("", pc.bold("Missing information"), ...e.missingInformation.map((m) => `  - ${m}`));
  if (e.suggestedChecks.length)
    out.push("", pc.bold("Suggested checks"), ...e.suggestedChecks.map((m) => `  - ${m}`));
  if (e.proposedCommands.length) {
    out.push("", pc.bold("Proposed commands (not executed — review before running)"));
    for (const c of e.proposedCommands)
      out.push(`  $ ${c.command}`, pc.dim(`    ${c.purpose} · risk: ${c.risk}`));
  }
  out.push("", pc.bold("Uncertainty"), indent(e.uncertainty, "  "));
  return out.join("\n");
}
