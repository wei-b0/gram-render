import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { createEvaluator } from "../../src/index.js";
import { ORDER_FIXTURE } from "../../examples/comparison/fixture.js";
import { runGramRenderSide } from "../../examples/comparison/providers/gram.js";
import { runLlmSide } from "../../examples/comparison/providers/llm.js";
import { buildComparisonTrace } from "../../examples/comparison/trace.js";
import { ComparisonTraceSchema } from "../../examples/comparison/types.js";

/**
 * Real-LLM + real-JEV integration test. Skipped unless BOTH keys are set —
 * cost-bearing tests stay opt-in (mirrors jev.test.ts; .env is deliberately
 * not loaded here). Run with:
 *
 *   OPENROUTER_API_KEY=… npm run test:integration   # or OPENAI_API_KEY=…
 */

const OPENROUTER_KEY = process.env["OPENROUTER_API_KEY"];
const OPENAI_KEY = process.env["OPENAI_API_KEY"];
const USE_OPENROUTER = Boolean(OPENROUTER_KEY);

const HAS_KEYS =
  (Boolean(OPENROUTER_KEY) || Boolean(OPENAI_KEY)) &&
  Boolean(process.env["TYPESAFE_API_KEY"] ?? process.env["GRAM_RENDER_API_KEY"]);

describe.skipIf(!HAS_KEYS)("comparison live", () => {
  it(
    "produces valid GramSpecs on both sides under a shared t0",
    { timeout: 120_000 },
    async () => {
      const t0Epoch = Date.now();
      const perfT0 = performance.now();
      const atMs = (): number => performance.now() - perfT0;
      const model =
        process.env["COMPARISON_MODEL"] ?? (USE_OPENROUTER ? "openai/gpt-6-astra" : "gpt-6-astra");
      const client = new OpenAI({
        apiKey: USE_OPENROUTER ? OPENROUTER_KEY : OPENAI_KEY,
        maxRetries: 0,
        ...(USE_OPENROUTER ? { baseURL: "https://openrouter.ai/api/v1" } : {}),
      });

      const [llmSettled, gramSettled] = await Promise.allSettled([
        runLlmSide({ fixture: ORDER_FIXTURE, atMs, client, model, maxOutputTokens: 4096 }),
        runGramRenderSide({ fixture: ORDER_FIXTURE, atMs, evaluate: createEvaluator(), minConfidence: 0.7 }),
      ]);
      expect(llmSettled.status).toBe("fulfilled");
      expect(gramSettled.status).toBe("fulfilled");
      if (llmSettled.status !== "fulfilled" || gramSettled.status !== "fulfilled") return;

      const trace = buildComparisonTrace({
        fixture: ORDER_FIXTURE,
        model,
        provider: USE_OPENROUTER ? "openrouter" : "openai",
        llm: llmSettled.value,
        gram: gramSettled.value,
        t0Epoch,
        runIndex: 1,
        runsPlanned: 1,
        warm: false, // no warmup in tests — recorded as a cold run
        openaiVersion: "test",
        baseUrl: USE_OPENROUTER ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
        maxOutputTokens: 4096,
        jevModel: process.env["TYPESAFE_DEFAULT_MODEL"] ?? "jev-latest",
        jevBaseUrl: (process.env["TYPESAFE_BASE_URL"] ?? "https://api.typesafe.ai").replace(/\/+$/, ""),
        minConfidence: 0.7,
      });

      // Strict structured output on this fixture is expected to be valid; a
      // failure here is a real signal (recorded honestly in the trace).
      expect(trace.summary.llmValidMs).not.toBeNull();
      expect(trace.summary.gramValidMs).not.toBeNull();
      expect(ComparisonTraceSchema.safeParse(trace).success).toBe(true);
    },
  );
});
