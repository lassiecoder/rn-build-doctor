import { z } from "zod";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** What the AI is asked to return. Validated again locally, whatever the provider guarantees. */
export const AiExplanationSchema = z.object({
  summary: z.string().describe("Two or three sentences describing the observed failure."),
  likelyCauses: z
    .array(
      z.object({
        cause: z.string(),
        explanation: z.string(),
        likelihood: z.enum(["likely", "possible", "unlikely"]),
        supportingFindingIds: z
          .array(z.string())
          .describe(
            "Ids of report findings (F1, F2, ...) whose evidence supports this cause. Empty if none.",
          ),
      }),
    )
    .describe("Ranked from most to least likely."),
  missingInformation: z.array(z.string()).describe("Evidence that would narrow the diagnosis."),
  suggestedChecks: z.array(z.string()).describe("Read-only checks the developer can run next."),
  proposedCommands: z.array(
    z.object({
      command: z.string(),
      purpose: z.string(),
      risk: z
        .string()
        .describe("What the command changes and how to undo it; 'read-only' if nothing."),
    }),
  ),
  uncertainty: z.string().describe("What cannot be concluded from the evidence."),
});

export type AiExplanation = z.infer<typeof AiExplanationSchema>;

export interface AiRequest {
  system: string;
  user: string;
}

export interface AiResult {
  explanation: AiExplanation;
  provider: string;
  model: string;
  /** Set when the provider served the answer with a different model than requested. */
  servedBy?: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Where data is sent, shown to the user before anything leaves the machine. */
  readonly destination: string;
  explain(request: AiRequest, options: { timeoutMs: number }): Promise<AiResult>;
}

export class AiError extends Error {
  override name = "AiError";
}
