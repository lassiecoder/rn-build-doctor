import { z } from "zod";

export const REPORT_SCHEMA_VERSION = "1.0";

export const SeveritySchema = z.enum(["error", "warning", "info"]);
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export const PlatformSchema = z.enum(["android", "ios", "expo", "javascript", "common"]);

export type Severity = z.infer<typeof SeveritySchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type Platform = z.infer<typeof PlatformSchema>;

export const EvidenceSchema = z
  .object({
    /** Where the evidence came from. */
    source: z.enum(["log", "project", "environment"]),
    /** Path of the log or project file, relative to the project root when possible. */
    file: z.string().min(1).optional(),
    /** 1-based line number in the original file. */
    line: z.number().int().positive().optional(),
    /** Verbatim (redacted) excerpt of the file or log. */
    excerpt: z.string().optional(),
    /** Structured detail such as a version, a variable name, or a package name. */
    detail: z.string().optional(),
  })
  .strict()
  .refine((e) => e.excerpt !== undefined || e.detail !== undefined, {
    message: "Evidence must include an excerpt or a detail",
  });

export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z
  .object({
    /** Sequential identifier inside a report (F1, F2, ...), assigned after sorting. */
    id: z.string().regex(/^F\d+$/),
    ruleId: z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/),
    title: z.string().min(1),
    severity: SeveritySchema,
    confidence: ConfidenceSchema,
    platforms: z.array(PlatformSchema).min(1),
    explanation: z.string().min(1),
    evidence: z.array(EvidenceSchema),
    nextSteps: z.array(z.string().min(1)).min(1),
    references: z.array(z.url()),
    verification: z.string().optional(),
    /** Things this finding cannot establish from the available evidence. */
    limitations: z.array(z.string()).default([]),
  })
  .strict()
  .refine((f) => f.severity === "info" || f.evidence.length > 0, {
    message: "Error and warning findings must include at least one piece of evidence",
    path: ["evidence"],
  });

export type Finding = z.infer<typeof FindingSchema>;

/** A finding before the engine assigns its report-level id. */
export type DraftFinding = Omit<Finding, "id" | "limitations"> & { limitations?: string[] };

export const ProjectSummarySchema = z
  .object({
    root: z.string(),
    kind: z.enum(["expo", "react-native-cli", "monorepo-root", "unknown"]),
    packageManager: z.string().optional(),
    lockfiles: z.array(z.string()),
    hasAndroid: z.boolean(),
    hasIos: z.boolean(),
    versions: z.record(z.string(), z.string()),
    notes: z.array(z.string()),
  })
  .strict();

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const InputSchema = z
  .object({
    kind: z.enum(["project", "log"]),
    path: z.string(),
    detectedFormats: z.array(z.string()).default([]),
    lineCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean().default(false),
    encoding: z.string().optional(),
  })
  .strict();

export type ReportInput = z.infer<typeof InputSchema>;

export const ReportSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    tool: z.object({ name: z.literal("rn-build-doctor"), version: z.string() }).strict(),
    command: z.enum(["scan", "analyze", "merged"]),
    generatedAt: z.iso.datetime(),
    project: ProjectSummarySchema.optional(),
    inputs: z.array(InputSchema),
    findings: z.array(FindingSchema),
    summary: z
      .object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        infos: z.number().int().nonnegative(),
      })
      .strict(),
    redaction: z
      .object({
        applied: z.boolean(),
        replacements: z.number().int().nonnegative(),
        notice: z.string(),
      })
      .strict(),
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `  - ${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
}
