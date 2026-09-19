import { describe, expect, it } from "vitest";
import type { EvaluateArgs, EvaluationResult, Evaluator } from "../../src/index.js";
import { ORDER_FIXTURE } from "../../examples/comparison/fixture.js";
import { runGramRenderSide } from "../../examples/comparison/providers/gram.js";
import { GramSideSchema } from "../../examples/comparison/types.js";

/**
 * Network-free tests for the gram-render-side capture: a scripted evaluator
 * picks the first criteria key of every question (and "yes" for the
 * fulfillable gate), so the full derive → select → layout → complete flow runs
 * deterministically without touching the TypeSafe API.
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

/** Fake clock: each read advances 7 ms so event ordering is observable. */
function fakeClock(): { atMs: () => number; now: () => number } {
  let now = 0;
  return { atMs: () => (now += 7), now: () => now };
}

describe("gram-render side capture", () => {
  it("captures JEV calls, timestamped events, and gate results end-to-end", async () => {
    const clock = fakeClock();
    const side = await runGramRenderSide({
      fixture: ORDER_FIXTURE,
      atMs: clock.atMs,
      evaluate: firstCriteriaEvaluator(),
    });

    expect(side.error).toBeUndefined();
    expect(side.calls.length).toBeGreaterThanOrEqual(1);
    expect(side.calls.length).toBeLessThanOrEqual(2);
    expect(side.deriveMs).not.toBeNull();

    const stepEvents = side.events.filter((event) => event.type === "step");
    expect(stepEvents.length).toBe(side.calls.length);
    const complete = side.events.find((event) => event.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type === "complete") {
      expect(complete.stopReason).toBe("finish");
    }

    // Events are strictly ordered in time.
    for (let i = 1; i < side.events.length; i++) {
      expect(side.events[i]!.atMs).toBeGreaterThan(side.events[i - 1]!.atMs);
    }

    // A step spec exists, passes the shared gate, and produced firstUiMs.
    expect(side.firstUiMs).not.toBeNull();
    expect(side.firstValidMs).not.toBeNull();
    expect(side.finalGate.ok).toBe(true);
    expect(side.finalGate.stage).toBe("ok");

    // The captured side validates against the trace schema.
    expect(GramSideSchema.safeParse(side).success).toBe(true);
  });

  it("records evaluator errors instead of throwing, keeping partial capture", async () => {
    const failing: Evaluator = async () => {
      throw new Error("jev unreachable");
    };
    const clock = fakeClock();
    const side = await runGramRenderSide({
      fixture: ORDER_FIXTURE,
      atMs: clock.atMs,
      evaluate: failing,
    });

    expect(side.error).toContain("jev unreachable");
    expect(side.firstValidMs).toBeNull();
    expect(side.finalGate.ok).toBe(false);
    expect(side.events.some((event) => event.type === "complete")).toBe(false);
    expect(GramSideSchema.safeParse(side).success).toBe(true);
  });
});
