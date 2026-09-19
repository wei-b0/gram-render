import { describe, expect, it } from "vitest";
import { ORDER_FIXTURE } from "../../examples/comparison/fixture.js";
import { runLlmSide } from "../../examples/comparison/providers/llm.js";
import type { LlmStreamClient, LlmStreamEvent } from "../../examples/comparison/providers/llm.js";
import { LlmSideSchema } from "../../examples/comparison/types.js";
import { VALID_ORDER_SPEC_TEXT } from "./order-spec.js";

/**
 * Network-free tests for the LLM-side capture: a scripted client emits
 * Responses-API-shaped stream events so deltas, throttled probes, partial
 * renders, retries, and gate results can be observed deterministically.
 */

/** Fake clock: each read advances 7 ms so event ordering is observable. */
function fakeClock(): { atMs: () => number; now: () => number } {
  let now = 0;
  return { atMs: () => (now += 7), now: () => now };
}

const SPEC_CHUNKS = VALID_ORDER_SPEC_TEXT.match(/.{1,12}/gs) ?? [];

function* deltaStream(chunks: string[]): Generator<LlmStreamEvent> {
  for (const chunk of chunks) {
    yield { type: "response.output_text.delta", delta: chunk };
  }
  yield {
    type: "response.completed",
    response: { id: "resp_ok", model: "gpt-6-astra", usage: { input_tokens: 4213, output_tokens: 388 } },
  };
}

function* failingStream(): Generator<LlmStreamEvent> {
  yield { type: "response.output_text.delta", delta: '{"version":1' };
  yield { type: "response.output_text.delta", delta: ',"root":"m1"' };
  throw new Error("connection reset");
}

/** A client whose successive stream() calls run the given generator factories. */
function scriptedClient(scripts: Array<() => Generator<LlmStreamEvent>>): LlmStreamClient {
  let call = 0;
  return {
    responses: {
      stream: (): AsyncIterable<LlmStreamEvent> => {
        const script = scripts[Math.min(call, scripts.length - 1)]!;
        call++;
        return (async function* () {
          yield* script();
        })();
      },
    },
  };
}

describe("LLM side capture", () => {
  it("captures deltas, usage, partial renders, and validity end-to-end", async () => {
    const clock = fakeClock();
    const side = await runLlmSide({
      fixture: ORDER_FIXTURE,
      atMs: clock.atMs,
      client: scriptedClient([() => deltaStream(SPEC_CHUNKS)]),
      model: "gpt-6-astra",
      probeIntervalMs: 0, // probe on every delta so partial states are exercised
    });

    expect(side.attempts).toHaveLength(1);
    expect(side.firstTokenMs).not.toBeNull();
    expect(side.firstValidMs).not.toBeNull();
    expect(side.finalGate.ok).toBe(true);
    expect(side.finalGate.stage).toBe("ok");
    expect(side.finalSpec).not.toBeNull();
    expect(side.modelReported).toBe("gpt-6-astra");
    expect(side.attempts[0]!.usage).toEqual({ inputTokens: 4213, outputTokens: 388 });
    expect(side.attempts[0]!.responseId).toBe("resp_ok");

    // Deltas concatenate back to the spec text, timestamped in order.
    expect(side.deltas.map((delta) => delta.text).join("")).toBe(VALID_ORDER_SPEC_TEXT);
    for (let i = 1; i < side.deltas.length; i++) {
      expect(side.deltas[i]!.atMs).toBeGreaterThan(side.deltas[i - 1]!.atMs);
    }
    expect(side.firstValidMs!).toBeGreaterThan(side.firstTokenMs!);

    // Gated partial UI materialized mid-stream, strictly before validity.
    expect(side.partialRenders.length).toBeGreaterThan(0);
    expect(side.partialRenders[side.partialRenders.length - 1]!.atMs).toBeLessThan(side.firstValidMs!);

    // The captured side validates against the trace schema.
    expect(LlmSideSchema.safeParse(side).success).toBe(true);
  });

  it("retries after a mid-stream failure, keeping both attempts' deltas", async () => {
    const clock = fakeClock();
    const side = await runLlmSide({
      fixture: ORDER_FIXTURE,
      atMs: clock.atMs,
      client: scriptedClient([() => failingStream(), () => deltaStream(SPEC_CHUNKS)]),
      model: "gpt-6-astra",
      probeIntervalMs: 0,
    });

    expect(side.attempts).toHaveLength(2);
    expect(side.attempts[0]!.error).toBe("connection reset");
    expect(side.attempts[0]!.firstTokenMs).not.toBeNull();
    expect(side.attempts[1]!.error).toBeUndefined();

    const attemptIndices = [...new Set(side.deltas.map((delta) => delta.attemptIndex))];
    expect(attemptIndices).toEqual([0, 1]);
    // Side-level firstTokenMs comes from the first attempt.
    expect(side.firstTokenMs).toBe(side.attempts[0]!.firstTokenMs);
    // The valid attempt still lands.
    expect(side.finalGate.ok).toBe(true);
    expect(side.finalSpec).not.toBeNull();
    expect(side.firstValidMs).not.toBeNull();
  });

  it("does not retry a parseable but schema-invalid completion", async () => {
    const clock = fakeClock();
    const invalid = '{"version":1,"root":"x","elements":{"x":{"type":"Bogus","props":{}}}}';
    const side = await runLlmSide({
      fixture: ORDER_FIXTURE,
      atMs: clock.atMs,
      client: scriptedClient([() => deltaStream([invalid])]),
      model: "gpt-6-astra",
      probeIntervalMs: 0,
    });

    expect(side.attempts).toHaveLength(1); // honest outcome, no retry
    expect(side.finalGate.ok).toBe(false);
    expect(side.finalGate.stage).toBe("schema");
    expect(side.firstValidMs).toBeNull();
    expect(side.finalSpec).toBeNull();
    expect(side.modelReported).toBe("gpt-6-astra");
  });

  it("retries unparseable output up to maxAttempts", async () => {
    const clock = fakeClock();
    const side = await runLlmSide({
      fixture: ORDER_FIXTURE,
      atMs: clock.atMs,
      client: scriptedClient([() => deltaStream(['{"broken":'])]),
      model: "gpt-6-astra",
      probeIntervalMs: 0,
      maxAttempts: 3,
    });

    expect(side.attempts).toHaveLength(3);
    expect(side.attempts.every((attempt) => attempt.finalGate.stage === "parse")).toBe(true);
    expect(side.firstValidMs).toBeNull();
    expect(side.finalSpec).toBeNull();
    // Deltas from all three attempts are kept; finalText is the last window.
    expect(side.deltas.every((delta) => delta.text === '{"broken":')).toBe(true);
    expect(side.finalText).toBe('{"broken":');
  });
});
