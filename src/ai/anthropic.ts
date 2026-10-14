import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  AiError,
  AiExplanationSchema,
  DEFAULT_ANTHROPIC_MODEL,
  type AiProvider,
  type AiRequest,
  type AiResult,
} from "./provider.js";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly destination = "Anthropic API (api.anthropic.com, or ANTHROPIC_BASE_URL if set)";
  private readonly client: Anthropic;

  constructor(
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    client?: Anthropic,
  ) {
    // Credentials resolve from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login`.
    this.client = client ?? new Anthropic({ maxRetries: 2 });
  }

  async explain(request: AiRequest, options: { timeoutMs: number }): Promise<AiResult> {
    let response;
    try {
      response = await this.client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: 16000,
          // Re-run on a fallback model chosen by the API if the request is declined by a safety classifier.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium", format: betaZodOutputFormat(AiExplanationSchema) },
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        },
        { timeout: options.timeoutMs },
      );
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new AiError(
          "Anthropic rejected the credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.",
        );
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new AiError("Anthropic rate limit reached. Try again later.");
      }
      if (error instanceof Anthropic.APIConnectionTimeoutError) {
        throw new AiError(
          `The AI request timed out after ${Math.round(options.timeoutMs / 1000)}s.`,
        );
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new AiError(`Could not reach the Anthropic API: ${error.message}`);
      }
      if (error instanceof Anthropic.APIError) {
        throw new AiError(`Anthropic API error ${error.status ?? ""}: ${error.message}`.trim());
      }
      throw new AiError(`AI request failed: ${(error as Error).message}`);
    }
    if (response.stop_reason === "refusal") {
      throw new AiError(
        "The model declined to answer this request. Deterministic findings are unaffected.",
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiError("The AI response was cut off before it was complete; nothing was shown.");
    }
    const parsed = AiExplanationSchema.safeParse(response.parsed_output);
    if (!parsed.success) {
      throw new AiError("The AI response did not match the expected structure; nothing was shown.");
    }
    return {
      explanation: parsed.data,
      provider: this.name,
      model: this.model,
      ...(response.model && response.model !== this.model ? { servedBy: response.model } : {}),
    };
  }
}
