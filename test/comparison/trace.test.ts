import { describe, expect, it } from "vitest";
import type { EvaluateArgs, EvaluationResult, Evaluator } from "../../src/index.js";
import { ORDER_FIXTURE } from "../../examples/comparison/fixture.js";
import { runGramRenderSide } from "../../examples/comparison/providers/gram.js";
import { runLlmSide } from "../../examples/comparison/providers/llm.js";
import type { LlmStreamClient, LlmStreamEvent } from "../../examples/comparison/providers/llm.js";
import { buildComparisonTrace, buildTraceSummary, RunSummarySchema, sha256, statsOf, summarizeRuns } from "../../examples/comparison/trace.js";
import type { GateResult, GramSide, LlmSide } from "../../examples/comparison/types.js";
import { ComparisonTraceSchema } from "../../examples/comparison/types.js";
import { VALID_ORDER_SPEC_WIRE_TEXT } from "./order-spec.js";

/**
 * Trace assembly and aggregates, network-free: both capture modules run
 * against scripted fakes, the resulting trace zod-round-trips, and the
 * summary math (winner, stats) is pinned.
 */

function firstCriteriaEvaluator(): Evaluator {
  return async (args: EvaluateArgs): Promise<EvaluationResult> => {
    const answers: EvaluationResult["answers"] = {};
    for (const [name, question] of Object.entries(args.questions)) {
      const choice = name === "fulfillable" ? "yes" : (Object.keys(question.criteria)[0] as string);
      answers[name] = { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
    }
    return { answers, usage: { inputTokens: 120 }, model: "fake" };
  };
}

function fakeClock(): { atMs: () => number; now: () => number } {
  let now = 0;
  return { atMs: () => (now += 7), now: () => now };
}

const SPEC_CHUNKS = VALID_ORDER_SPEC_WIRE_TEXT.match(/.{1,12}/gs) ?? [];

function scriptedClient(): LlmStreamClient {
  return {
    responses: {
      stream: (): AsyncIterable<LlmStreamEvent> =>
        (async function* () {
          for (const chunk of SPEC_CHUNKS) {
            yield { type: "response.output_text.delta", delta: chunk };
          }
          yield {
            type: "response.completed",
            response: { id: "resp_1", model: "test-model", usage: { input_tokens: 10, output_tokens: 5 } },
          };
        })(),
    },
  };
}

function gateOk(): GateResult {
  return { ok: true, stage: "ok", issues: [], normalized: true };
}

function llmSideWith(validMs: number | null): LlmSide {
  return {
    deltas: [],
    checks: [],
    partialRenders: [],
    attempts: [],
    firstTokenMs: null,
    firstValidMs: validMs,
    finalText: "",
    finalSpec: null,
    finalGate: gateOk(),
  };
}

function gramSideWith(validMs: number | null): GramSide {
  return {
    deriveMs: null,
    calls: [],
    events: [],
    firstUiMs: null,
    firstValidMs: validMs,
    finalGate: gateOk(),
  };
}

const TRACE_INPUTS = {
  fixture: ORDER_FIXTURE,
  model: "test-model",
  provider: "openai" as const,
  t0Epoch: 1_758_000_000_000,
  runIndex: 1,
  runsPlanned: 1,
  warm: true,
  warmupMs: { llm: 500, jev: 300 },
  openaiVersion: "6.49.0",
  baseUrl: "https://api.openai.com/v1",
  maxOutputTokens: 4096,
  jevModel: "jev-latest",
  jevBaseUrl: "https://api.typesafe.ai",
  gitSha: "deadbeef",
  nodeVersion: "v26.8.2",
};

describe("trace assembly", () => {
  it("builds a zod-valid trace from real capture-module output", async () => {
    const clock = fakeClock();
    const llm = await runLlmSide({
      fixture: ORDER_FIXTURE,
      atMs: clock.atMs,
      client: scriptedClient(),
      model: "test-model",
      probeIntervalMs: 0,
    });
    const gram = await runGramRenderSide({
      fixture: ORDER_FIXTURE,
      atMs: clock.atMs,
      evaluate: firstCriteriaEvaluator(),
    });

    const trace = buildComparisonTrace({ ...TRACE_INPUTS, llm, gram });

    expect(ComparisonTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.meta.promptSha256).toBe(sha256(ORDER_FIXTURE.prompt));
    expect(trace.meta.llm.schemaSha256).toHaveLength(64);
    expect(trace.meta.startedAtIso).toBe(new Date(TRACE_INPUTS.t0Epoch).toISOString());
    expect(trace.meta.warmupMs).toEqual({ llm: 500, jev: 300 });

    // Winner is consistent with the recorded firstValidMs values.
    const { llmValidMs, gramValidMs, winner } = trace.summary;
    if (llmValidMs === null && gramValidMs === null) expect(winner).toBe("none");
    else if (gramValidMs === null) expect(winner).toBe("llm");
    else if (llmValidMs === null) expect(winner).toBe("gramRender");
    else expect(winner).toBe(llmValidMs < gramValidMs ? "llm" : gramValidMs < llmValidMs ? "gramRender" : "tie");
  });

  it("derives the winner from firstValidMs exactly", () => {
    expect(buildTraceSummary(llmSideWith(100), gramSideWith(200)).winner).toBe("llm");
    expect(buildTraceSummary(llmSideWith(200), gramSideWith(100)).winner).toBe("gramRender");
    expect(buildTraceSummary(llmSideWith(150), gramSideWith(150)).winner).toBe("tie");
    expect(buildTraceSummary(llmSideWith(null), gramSideWith(150)).winner).toBe("gramRender");
    expect(buildTraceSummary(llmSideWith(150), gramSideWith(null)).winner).toBe("llm");
    expect(buildTraceSummary(llmSideWith(null), gramSideWith(null)).winner).toBe("none");
  });

  it("reports the LLM's first partial render as its first UI", () => {
    const llm = llmSideWith(500);
    llm.partialRenders.push({ atMs: 42, spec: { version: 1, root: "m1", elements: {} } });
    expect(buildTraceSummary(llm, gramSideWith(100)).llmFirstUiMs).toBe(42);
    expect(buildTraceSummary(llmSideWith(100), gramSideWith(100)).llmFirstUiMs).toBeNull();
  });
});

describe("run aggregates", () => {
  it("computes nearest-rank stats", () => {
    expect(statsOf([30, 10, 20])).toEqual({ n: 3, min: 10, median: 20, p90: 30, max: 30 });
    expect(statsOf([10, 20, 30, 40])!.median).toBe(25);
    expect(statsOf([])).toBeNull();
  });

  it("aggregates warm runs only and counts winners", async () => {
    const warm = buildComparisonTrace({
      ...TRACE_INPUTS,
      llm: llmSideWith(100),
      gram: gramSideWith(50),
    });
    warm.summary.winner = "gramRender";
    const cold = buildComparisonTrace({
      ...TRACE_INPUTS,
      runIndex: 2,
      runsPlanned: 2,
      warm: false,
      warmupMs: undefined,
      llm: llmSideWith(200),
      gram: gramSideWith(null),
    });
    cold.summary.winner = "llm";

    const summary = RunSummarySchema.parse(summarizeRuns([warm, cold]));
    expect(summary.warmRuns).toBe(1);
    expect(summary.coldRuns).toBe(1);
    expect(summary.winnerCounts).toEqual({ llm: 0, gramRender: 1, tie: 0, none: 0 });
    expect(summary.gramRender.validMs).toEqual({ n: 1, min: 50, median: 50, p90: 50, max: 50 });
    expect(summary.llm.validMs).toEqual({ n: 1, min: 100, median: 100, p90: 100, max: 100 });
  });
});
