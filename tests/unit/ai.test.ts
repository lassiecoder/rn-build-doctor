import { describe, expect, it } from "vitest";
import { buildAiRequest, checkExplanation } from "../../src/ai/explain.js";
import { AiExplanationSchema, type AiExplanation } from "../../src/ai/provider.js";
import { runAnalyze } from "../../src/pipeline.js";
import { Redactor } from "../../src/reports/redact.js";
import { EMPTY_ENV, NO_PROJECT, logFixture } from "../helpers/fixtures.js";

const report = runAnalyze([logFixture("secrets.log")], { cwd: NO_PROJECT, env: EMPTY_ENV });

const explanation: AiExplanation = {
  summary: "s",
  likelyCauses: [
    { cause: "real", explanation: "x", likelihood: "likely", supportingFindingIds: ["F1"] },
    { cause: "made up", explanation: "x", likelihood: "likely", supportingFindingIds: ["F99"] },
    { cause: "background", explanation: "x", likelihood: "possible", supportingFindingIds: [] },
  ],
  missingInformation: [],
  suggestedChecks: [],
  proposedCommands: [
    { command: "rm -rf node_modules", purpose: "reinstall", risk: "deletes node_modules" },
  ],
  uncertainty: "u",
};

describe("AI layer", () => {
  it("sends only redacted content", () => {
    const req = buildAiRequest(report, new Redactor({ env: EMPTY_ENV }));
    expect(req.user).not.toContain("ghp_1234567890");
    expect(req.user).not.toContain("hunter2hunter2");
    expect(req.system).toMatch(/not instructions/);
  });

  it("labels causes without valid evidence as unsupported and drops invented references", () => {
    const checked = checkExplanation(explanation, report);
    expect(checked.likelyCauses[0]).toMatchObject({
      unsupported: false,
      supportingFindingIds: ["F1"],
    });
    expect(checked.likelyCauses[1]).toMatchObject({
      unsupported: true,
      supportingFindingIds: [],
      invalidReferences: ["F99"],
    });
    expect(checked.likelyCauses[2]?.unsupported).toBe(true);
  });

  it("rejects malformed provider output", () => {
    expect(AiExplanationSchema.safeParse({ summary: "only" }).success).toBe(false);
    expect(
      AiExplanationSchema.safeParse({
        ...explanation,
        likelyCauses: [{ cause: "x", likelihood: "certain" }],
      }).success,
    ).toBe(false);
  });
});

describe("AnthropicProvider failure handling", async () => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { AnthropicProvider } = await import("../../src/ai/anthropic.js");
  const fake = (impl: () => Promise<unknown>) =>
    ({ beta: { messages: { parse: impl } } }) as unknown as InstanceType<typeof Anthropic>;
  const req = { system: "s", user: "u" };

  it("reports timeouts without crashing", async () => {
    const p = new AnthropicProvider(
      "claude-opus-5-5",
      fake(() => Promise.reject(new Anthropic.APIConnectionTimeoutError())),
    );
    await expect(p.explain(req, { timeoutMs: 1000 })).rejects.toThrow(/timed out/);
  });

  it("explains how to configure missing credentials", async () => {
    const p = new AnthropicProvider(
      "claude-opus-5-5",
      fake(() =>
        Promise.reject(
          new Error("Could not resolve authentication method. Expected one of apiKey"),
        ),
      ),
    );
    await expect(p.explain(req, { timeoutMs: 1000 })).rejects.toThrow(/Set ANTHROPIC_API_KEY/);
  });

  it("reports refusals and truncated output", async () => {
    const refused = new AnthropicProvider(
      "m",
      fake(() => Promise.resolve({ stop_reason: "refusal", parsed_output: null, model: "m" })),
    );
    await expect(refused.explain(req, { timeoutMs: 1000 })).rejects.toThrow(/declined/);
    const cut = new AnthropicProvider(
      "m",
      fake(() => Promise.resolve({ stop_reason: "max_tokens", parsed_output: null, model: "m" })),
    );
    await expect(cut.explain(req, { timeoutMs: 1000 })).rejects.toThrow(/cut off/);
  });

  it("rejects responses that don't match the schema", async () => {
    const bad = new AnthropicProvider(
      "m",
      fake(() =>
        Promise.resolve({ stop_reason: "end_turn", parsed_output: { summary: 1 }, model: "m" }),
      ),
    );
    await expect(bad.explain(req, { timeoutMs: 1000 })).rejects.toThrow(/expected structure/);
  });

  it("returns validated explanations", async () => {
    const ok = new AnthropicProvider(
      "m",
      fake(() =>
        Promise.resolve({ stop_reason: "end_turn", parsed_output: explanation, model: "m" }),
      ),
    );
    await expect(ok.explain(req, { timeoutMs: 1000 })).resolves.toMatchObject({
      explanation: { summary: "s" },
    });
  });
});
