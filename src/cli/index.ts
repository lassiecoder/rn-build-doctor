import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { buildAiRequest, checkExplanation } from "../ai/explain.js";
import { AiError, DEFAULT_ANTHROPIC_MODEL } from "../ai/provider.js";
import { allRuleMeta } from "../engine/registry.js";
import { EXIT, UsageError } from "../errors.js";
import { makeRedactor, runAnalyze, runScan } from "../pipeline.js";
import {
  loadReport,
  loadSavedReports,
  mergeReports,
  saveReport,
  toMarkdown,
} from "../reports/export.js";
import type { Report, Severity } from "../reports/schema.js";
import { VERSION } from "../version.js";
import { formatAiExplanation, formatCatalog, formatReport } from "./formatters/terminal.js";

type FailOn = Severity | "none";
const FAIL_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function parseFailOn(value: string): FailOn {
  if (!["error", "warning", "info", "none"].includes(value)) {
    throw new InvalidArgumentError("expected one of: error, warning, info, none");
  }
  return value as FailOn;
}

function parsePositive(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("expected a positive number");
  return n;
}

function exitCodeFor(report: Report, failOn: FailOn): number {
  if (failOn === "none") return EXIT.ok;
  return report.findings.some((f) => FAIL_ORDER[f.severity] <= FAIL_ORDER[failOn])
    ? EXIT.findings
    : EXIT.ok;
}

interface OutputOptions {
  json?: boolean;
  save: boolean;
  failOn: FailOn;
  verbose?: boolean;
  cwd: string;
}

function emit(report: Report, options: OutputOptions): number {
  const savedTo = options.save ? saveReport(resolve(options.cwd), report) : undefined;
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else
    process.stdout.write(
      `${formatReport(report, { ...(options.verbose ? { verbose: true } : {}), ...(savedTo ? { savedTo } : {}) })}\n`,
    );
  return exitCodeFor(report, options.failOn);
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

/**
 * Reads all of stdin. Uses the stream API rather than readFileSync(0), which throws EAGAIN when
 * stdin is a pipe from a process that is still writing (e.g. `./gradlew build 2>&1 | ...`).
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

export function buildProgram(): Command {
  const program = new Command();
  // Set before subcommands are created so they inherit it (usage errors must exit 2, not 1).
  program.exitOverride();
  program
    .name("rn-build-doctor")
    .description(
      "Evidence-based diagnostics for React Native and Expo build, release, and startup failures.\nRuns locally; nothing leaves your machine unless you run `explain` (or `scan --expo-doctor`).",
    )
    .version(VERSION, "-v, --version")
    .showHelpAfterError("(run with --help for usage)")
    .addHelpText(
      "after",
      `
Exit codes: 0 completed · 1 findings at or above --fail-on · 2 invalid input or usage · 3 internal error · 4 AI provider failure

Examples:
  $ rn-build-doctor scan
  $ rn-build-doctor analyze ./android-build.log
  $ npx eas build:view --json ... | rn-build-doctor analyze -
  $ rn-build-doctor report --output report.md`,
    );

  const common = (cmd: Command) =>
    cmd
      .option("--cwd <dir>", "project directory", process.cwd())
      .option("--json", "print the report as JSON")
      .option("--no-save", "don't save the report under .rn-build-doctor/")
      .addOption(
        new Option("--fail-on <severity>", "exit 1 when a finding at or above this severity exists")
          .argParser(parseFailOn)
          .default("none"),
      )
      .option("--redact <value>", "extra literal value to redact (repeatable)", collect, [])
      .option("--verbose", "show all evidence and references");

  common(program.command("scan"))
    .description("inspect the project and environment and run supported checks (offline)")
    .option("--no-java-probe", "don't run `java -version` to detect the JDK")
    .option("--expo-doctor", "also run `npx expo-doctor` (downloads it; needs network access)")
    .action((opts) => {
      const report = runScan({
        cwd: resolve(opts.cwd),
        redact: opts.redact,
        probeJava: opts.javaProbe,
        expoDoctor: !!opts.expoDoctor,
      });
      process.exitCode = emit(report, opts);
    });

  common(program.command("analyze"))
    .description("analyze build logs, device logs, or crash reports (use - for stdin)")
    .argument("<logs...>", "log files to analyze")
    .addOption(
      new Option(
        "--max-log-mb <n>",
        "read at most this many MB per log (beginning and end are kept)",
      )
        .argParser(parsePositive)
        .default(32),
    )
    .action(async (logs: string[], opts) => {
      const stdinText = logs.includes("-") ? await readStdin() : undefined;
      const report = runAnalyze(logs, {
        cwd: resolve(opts.cwd),
        redact: opts.redact,
        maxLogBytes: Math.floor(opts.maxLogMb * 1024 * 1024),
        ...(stdinText !== undefined ? { stdinText } : {}),
      });
      process.exitCode = emit(report, opts);
    });

  program
    .command("report")
    .description("export saved findings (from scan/analyze) as Markdown or JSON")
    .option("--cwd <dir>", "project directory", process.cwd())
    .option(
      "--input <file>",
      "report JSON file to use instead of the saved ones (repeatable)",
      collect,
      [],
    )
    .addOption(
      new Option("--format <format>", "output format").choices(["md", "json"]).default("md"),
    )
    .option("--output <file>", "write to a file instead of stdout")
    .action((opts) => {
      const cwd = resolve(opts.cwd);
      const reports: Report[] = opts.input.length
        ? (opts.input as string[]).map((f) => loadReport(resolve(cwd, f)))
        : loadSavedReports(cwd).map((r) => r.report);
      if (!reports.length) {
        throw new UsageError(
          "No saved findings. Run `rn-build-doctor scan` or `rn-build-doctor analyze <log>` first, or pass --input.",
        );
      }
      const merged = mergeReports(reports, makeRedactor({ cwd }));
      const text =
        opts.format === "json" ? `${JSON.stringify(merged, null, 2)}\n` : toMarkdown(merged);
      if (opts.output) {
        writeFileSync(resolve(cwd, opts.output), text);
        process.stderr.write(
          `Wrote ${opts.output}. Review it before sharing; redaction is best-effort.\n`,
        );
      } else process.stdout.write(text);
    });

  program
    .command("explain")
    .description(
      "optional: ask an AI provider to explain saved findings (sends the redacted report)",
    )
    .option("--cwd <dir>", "project directory", process.cwd())
    .option("--input <file>", "report JSON to explain (default: saved reports)")
    .option("--model <id>", "Anthropic model id", DEFAULT_ANTHROPIC_MODEL)
    .addOption(
      new Option("--timeout <seconds>", "request timeout").argParser(parsePositive).default(120),
    )
    .option("--dry-run", "print exactly what would be sent, and send nothing")
    .option("-y, --yes", "send without the confirmation prompt")
    .option("--json", "print the AI result as JSON")
    .action(async (opts) => {
      const cwd = resolve(opts.cwd);
      const reports = opts.input
        ? [loadReport(resolve(cwd, opts.input))]
        : loadSavedReports(cwd).map((r) => r.report);
      if (!reports.length)
        throw new UsageError(
          "No saved findings to explain. Run `scan` or `analyze` first, or pass --input.",
        );
      const redactor = makeRedactor({ cwd });
      const report = mergeReports(reports, redactor);
      const request = buildAiRequest(report, redactor);
      if (opts.dryRun) {
        process.stdout.write(
          `--- system ---\n${request.system}\n\n--- user ---\n${request.user}\n`,
        );
        return;
      }
      // Loaded lazily so offline commands never load the AI SDK.
      const { AnthropicProvider } = await import("../ai/anthropic.js");
      const provider = new AnthropicProvider(opts.model);
      const size = Buffer.byteLength(request.system + request.user);
      process.stderr.write(
        `This sends ${report.findings.length} redacted finding(s) (${Math.ceil(size / 1024)} KB) to ${provider.destination} using model ${provider.model}.\nUse --dry-run to inspect the exact content first. No files are modified and no commands are run.\n`,
      );
      if (!opts.yes) {
        if (!process.stdin.isTTY)
          throw new UsageError(
            "Refusing to send without confirmation in a non-interactive shell. Pass --yes to confirm.",
          );
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const answer = await rl.question("Send? [y/N] ");
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          process.stderr.write("Cancelled. Nothing was sent.\n");
          return;
        }
      }
      const result = await provider.explain(request, { timeoutMs: opts.timeout * 1000 });
      const checked = checkExplanation(result.explanation, report);
      const { value } = redactor.redactDeep(checked);
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ provider: result.provider, model: result.model, servedBy: result.servedBy, unverified: true, explanation: value }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`${formatAiExplanation(value, result)}\n`);
      }
    });

  program
    .command("doctor")
    .description("list supported checks, inputs, and limitations")
    .option("--json", "print the rule catalog as JSON")
    .action((opts) => {
      const rules = allRuleMeta();
      process.stdout.write(
        opts.json ? `${JSON.stringify(rules, null, 2)}\n` : `${formatCatalog(rules)}\n`,
      );
    });

  // picocolors reads --no-color and NO_COLOR itself; accept the flag everywhere.
  for (const cmd of [program, ...program.commands])
    cmd.option("--no-color", "disable colored output");
  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === "number" ? process.exitCode : EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.code === "commander.help"
      )
        return EXIT.ok;
      return EXIT.usage;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`rn-build-doctor: ${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof AiError) {
      process.stderr.write(`rn-build-doctor explain: ${error.message}\n`);
      return 4;
    }
    process.stderr.write(
      `rn-build-doctor: internal error: ${(error as Error)?.stack ?? String(error)}\nPlease report this issue.\n`,
    );
    return EXIT.internal;
  }
}
