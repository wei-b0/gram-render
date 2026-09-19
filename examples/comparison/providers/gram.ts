/**
 * gram-render + JEV side of the comparison: compose a spec from the shared
 * fixture while capturing every observable event with wall-clock timestamps
 * relative to t0.
 *
 * Instrumentation is entirely external to the package — zero core changes:
 *  - the injected Evaluator is wrapped to record each JEV round trip
 *    (state, questions, answers, usage, wall-clock bounds);
 *  - composeSpec's generator is pulled in a loop, timestamping each step /
 *    complete event (the events themselves carry only internal durations).
 *
 * The final spec is validated with the same shared gate as the LLM side.
 */

import {
  composeSpec,
  type EvaluateArgs,
  type EvaluationResult,
  type Evaluator,
} from "../../../src/index.js";
import type { ComparisonFixture } from "../fixture.js";
import { gateValue, type GateResult } from "../gate.js";
import type { GramEvent, GramSide, JevCall } from "../types.js";

export interface GramRunContext {
  fixture: ComparisonFixture;
  /** Epoch-relative clock: milliseconds since t0. */
  atMs: () => number;
  /**
   * Evaluator to inject (tests pass scripted evaluators; the live run passes a
   * pre-constructed createEvaluator()). Not defaulted here so this module
   * never touches the network.
   */
  evaluate: Evaluator;
  /**
   * composeSpec's calibration floor: JEV choices below this confidence are
   * dropped (e.g. the uncertain standard-button proposals). Pinned in the
   * trace meta.
   */
  minConfidence?: number;
}

export async function runGramRenderSide(ctx: GramRunContext): Promise<GramSide> {
  const calls: JevCall[] = [];
  const events: GramEvent[] = [];
  let firstPullMs: number | null = null;

  const wrapped: Evaluator = async (args: EvaluateArgs): Promise<EvaluationResult> => {
    const startedMs = ctx.atMs();
    const result = await ctx.evaluate(args);
    const endedMs = ctx.atMs();
    calls.push({
      index: calls.length,
      startedMs,
      endedMs,
      state: structuredClone(args.state),
      questions: structuredClone(args.questions),
      answers: structuredClone(result.answers),
      usage: result.usage ? { inputTokens: result.usage.inputTokens } : undefined,
      model: result.model,
    });
    return result;
  };

  let firstUiMs: number | null = null;
  let firstValidMs: number | null = null;
  let finalGate: GateResult = { ok: false, stage: "parse", issues: ["no spec produced"], normalized: false };
  let error: string | undefined;

  try {
    const iterator = composeSpec({
      prompt: ctx.fixture.prompt,
      context: ctx.fixture.context,
      evaluate: wrapped,
      ...(ctx.minConfidence !== undefined ? { minConfidence: ctx.minConfidence } : {}),
    });
    // Timestamped immediately before the first pull so deriveMs (first JEV
    // call start − first pull) approximates the synchronous derivation time.
    firstPullMs = ctx.atMs();
    for await (const event of iterator) {
      const atMs = ctx.atMs();
      if (event.type === "step") {
        events.push({ type: "step", atMs, spec: event.spec, step: { ...event.step } });
        const gate = gateValue(event.spec);
        if (firstUiMs === null && gate.ok) firstUiMs = atMs;
      } else {
        events.push({
          type: "complete",
          atMs,
          spec: event.spec,
          stopReason: event.stopReason,
          calls: event.calls,
          elapsedMs: event.elapsedMs,
          inputTokens: event.inputTokens,
          warnings: [...event.warnings],
        });
        if (event.spec) {
          finalGate = gateValue(event.spec);
          if (finalGate.ok) firstValidMs = atMs;
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const firstCall = calls[0];
  return {
    deriveMs: firstPullMs !== null && firstCall !== undefined ? firstCall.startedMs - firstPullMs : null,
    calls,
    events,
    firstUiMs,
    firstValidMs,
    finalGate,
    error,
  };
}
