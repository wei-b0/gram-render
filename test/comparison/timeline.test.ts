import { describe, expect, it } from "vitest";
import {
  computeTimeline,
  dateChipText,
  elapsedMs,
  LLM_TIME_SCALE,
  sentAtText,
} from "../../examples/comparison/video/timeline.js";
import type { ComparisonTrace } from "../../examples/comparison/types.js";

/**
 * The timeline is pure frame math: same trace + fps ⇒ identical frames.
 * A synthetic trace keeps the assertions concrete.
 *
 * Speeds: the right side (gram-render + JEV) plays 1:1; the left side (LLM)
 * is a timelapse at LLM_TIME_SCALE — its trace timestamps map to earlier
 * frames so the finished right side visibly waits on it.
 */

const gate = { ok: true, stage: "ok" as const, issues: [] as string[], normalized: true };

function syntheticTrace(llmValidMs: number | null, gramValidMs: number | null): ComparisonTrace {
  const meta = {
    schemaVersion: 1 as const,
    runIndex: 1,
    runsPlanned: 1,
    warm: true,
    startedAtIso: "2026-09-19T00:00:00.000Z",
    gitSha: "test",
    nodeVersion: "test",
    fixtureId: "order-1842",
    prompt: "p",
    promptSha256: "0".repeat(64),
    contextSha256: "0".repeat(64),
    llm: {
      provider: "openai" as const,
      model: "test-model",
      api: "responses" as const,
      textFormat: "json_schema" as const,
      schemaSha256: "0".repeat(64),
      openaiVersion: "6.49.0",
      baseUrl: "https://api.openai.com/v1",
    },
    jev: { model: "jev-latest", baseUrl: "https://api.typesafe.ai" },
  };
  const llm = {
    deltas: [],
    checks: [],
    partialRenders: [{ atMs: 900, spec: { version: 1, root: "m1", elements: {} } }],
    attempts: [],
    firstTokenMs: 120,
    firstValidMs: llmValidMs,
    finalText: "",
    finalSpec: null,
    finalGate: gate,
  };
  const gramRender = {
    deriveMs: 2,
    calls: [],
    events: [],
    firstUiMs: 500,
    firstValidMs: gramValidMs,
    finalGate: gate,
  };
  const summary = {
    llmValidMs,
    gramValidMs,
    llmFirstUiMs: 900,
    gramFirstUiMs: 500,
    winner: "none" as const,
  };
  return { meta, t0Epoch: 0, llm, gramRender, summary };
}

describe("computeTimeline", () => {
  it("plays the right side 1:1 and the LLM side as a timelapse", () => {
    const timeline = computeTimeline(syntheticTrace(3000, 1000), 30);
    expect(timeline.introEnd).toBe(45); // 1.5 s × 30 fps
    // Right side: real time.
    expect(timeline.gramFirstUiFrame).toBe(45 + Math.ceil(0.5 * 30));
    expect(timeline.gramFirstValidFrame).toBe(45 + 30); // 1000 ms
    // Left side: warped — 900 ms of trace at 2.5× lands before 500 ms real time.
    expect(timeline.llmFirstUiFrame).toBe(45 + Math.ceil(((0.9 * 30) / LLM_TIME_SCALE)));
    expect(timeline.llmFirstValidFrame).toBe(45 + Math.ceil(((3 * 30) / LLM_TIME_SCALE))); // 36
    expect(timeline.bothDone).toBe(45 + Math.ceil(((3 * 30) / LLM_TIME_SCALE))); // the slower side
    // 45 + 36 + 90 = 171, but the 8 s minimum (240) floors it.
    expect(timeline.durationInFrames).toBe(240);
  });

  it("enforces a minimum duration of 8 s", () => {
    const timeline = computeTimeline(syntheticTrace(100, 100), 30);
    expect(timeline.durationInFrames).toBe(240); // 8 s × 30 fps
  });

  it("handles sides that never validate (nulls)", () => {
    const timeline = computeTimeline(syntheticTrace(null, 2000), 30);
    expect(timeline.llmFirstValidFrame).toBeNull();
    expect(timeline.gramFirstValidFrame).toBe(45 + 60);
    expect(timeline.bothDone).toBe(45 + 60);
  });

  it("squeezes a long LLM run under its real-time duration", () => {
    // 10.6 s of LLM trace must land at ~4.2 s of video — before bothDone +
    // hold would put a 1:1 run (≥ 10.6 s + 3 s hold).
    const timeline = computeTimeline(syntheticTrace(10618.76, 763.29), 30);
    const llmVideoSeconds = (timeline.llmFirstValidFrame! - timeline.introEnd) / 30;
    expect(llmVideoSeconds).toBeGreaterThan(4);
    expect(llmVideoSeconds).toBeLessThan(4.5);
    // Total = 1.5 s intro + 4.25 s race + 3 s hold = 263 frames (8.8 s).
    expect(timeline.durationInFrames).toBe(263);
  });

  it("is deterministic — identical output across repeated calls", () => {
    const trace = syntheticTrace(3123, 1877);
    expect(computeTimeline(trace, 30)).toEqual(computeTimeline(trace, 30));
    expect(computeTimeline(trace, 60).durationInFrames).toBe(computeTimeline(trace, 60).durationInFrames);
  });

  it("maps frames back to race-clock milliseconds symmetrically", () => {
    const fps = 30;
    const introEnd = 45;
    expect(elapsedMs(0, fps, introEnd)).toBe(0);
    expect(elapsedMs(introEnd, fps, introEnd)).toBe(0);
    expect(elapsedMs(introEnd + fps, fps, introEnd)).toBeCloseTo(1000, 6);
    expect(elapsedMs(introEnd + fps / 2, fps, introEnd)).toBeCloseTo(500, 6);
  });
});

// The date chip and in-bubble timestamps are trace-derived wall-clock strings,
// formatted UTC-only so frames stay byte-identical on any machine. The canonical
// run started at 2026-09-19T15:27:38.554Z (t0Epoch 1789831658554).
describe("trace-derived wall-clock strings", () => {
  const T0 = 1789831658554;

  it("formats the date chip from the run-start epoch", () => {
    expect(dateChipText(T0)).toBe("19 September");
    expect(dateChipText(Date.UTC(2027, 0, 5))).toBe("5 January");
  });

  it("formats in-bubble timestamps as UTC HH:MM", () => {
    // Canonical first-UI instants: LLM +4548.48 ms, gram-render +367.54 ms —
    // both land in the same UTC minute, which is the real data.
    expect(sentAtText(T0, 4548.4837769999995)).toBe("15:27");
    expect(sentAtText(T0, 367.54376199999933)).toBe("15:27");
  });

  it("pads and wraps hours/minutes at UTC day boundaries", () => {
    expect(sentAtText(0, 0)).toBe("00:00");
    expect(sentAtText(0, 3_600_000)).toBe("01:00");
    expect(sentAtText(0, 86_399_999)).toBe("23:59");
  });

  it("omits the timestamp when a side never materialized", () => {
    expect(sentAtText(T0, null)).toBeNull();
  });

  it("is deterministic across repeated calls", () => {
    expect(dateChipText(T0)).toBe(dateChipText(T0));
    expect(sentAtText(T0, 4741.762651)).toBe(sentAtText(T0, 4741.762651));
  });
});
