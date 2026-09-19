/**
 * Pure frame math for the comparison timeline — no React, no clocks, no
 * randomness. The same trace + fps always produce the same frames.
 *
 * Layout in time: 1.5 s intro (panels/labels fade in) → the race → 3 s hold,
 * never shorter than 8 s total.
 *
 * The race is played at different speeds per side:
 *  - RIGHT (gram-render + JEV) plays 1:1 — a trace timestamp of `atMs` maps to
 *    frame `introEnd + ceil(atMs/1000·fps)`.
 *  - LEFT (LLM) is a 2.5× timelapse — its 10–12 s of trace time is squeezed
 *    into ~4–5 s of video so the right side visibly finishes first and waits.
 *    Every on-screen number is still a recorded trace value: the left clock
 *    displays real trace milliseconds (ticking 2.5× faster), never video time.
 *    This warp is a presentation choice and is documented in the README.
 */

import type { ComparisonTrace } from "../types.js";

export const LLM_TIME_SCALE = 2.5;

export interface Timeline {
  fps: number;
  /** Frame the intro ends at — the race clock starts here. */
  introEnd: number;
  /** First gated partial render per side (null if one never materialized). */
  llmFirstUiFrame: number | null;
  gramFirstUiFrame: number | null;
  /** First valid GramSpec per side — the metric (LLM frame is warped). */
  llmFirstValidFrame: number | null;
  gramFirstValidFrame: number | null;
  /** Frame both sides have finished (timers frozen on both). */
  bothDone: number;
  durationInFrames: number;
}

const INTRO_SECONDS = 1.5;
const HOLD_SECONDS = 3;
const MIN_SECONDS = 8;

/** Frame → race clock, in video ms since t0 (clamped at 0 before the intro ends). */
export function elapsedMs(frame: number, fps: number, introEnd: number): number {
  return Math.max(0, ((frame - introEnd) / fps) * 1000);
}

export function computeTimeline(trace: ComparisonTrace, fps: number): Timeline {
  const introEnd = Math.ceil(INTRO_SECONDS * fps);
  const rel = (ms: number | null, scale: number): number | null =>
    ms === null ? null : Math.ceil(((ms / 1000) * fps) / scale);
  const llmFirstUiFrame = rel(trace.llm.partialRenders[0]?.atMs ?? null, LLM_TIME_SCALE);
  const gramFirstUiFrame = rel(trace.gramRender.firstUiMs, 1);
  const llmFirstValidFrame = rel(trace.summary.llmValidMs, LLM_TIME_SCALE);
  const gramFirstValidFrame = rel(trace.summary.gramValidMs, 1);
  // Frames above are relative to introEnd — convert to absolute.
  const abs = (relative: number | null): number | null =>
    relative === null ? null : introEnd + relative;
  const bothDone = Math.max(
    llmFirstValidFrame === null ? introEnd : introEnd + llmFirstValidFrame,
    gramFirstValidFrame === null ? introEnd : introEnd + gramFirstValidFrame,
  );
  const durationInFrames = Math.max(
    Math.ceil(MIN_SECONDS * fps),
    bothDone + Math.ceil(HOLD_SECONDS * fps),
  );
  return {
    fps,
    introEnd,
    llmFirstUiFrame: abs(llmFirstUiFrame),
    gramFirstUiFrame: abs(gramFirstUiFrame),
    llmFirstValidFrame: abs(llmFirstValidFrame),
    gramFirstValidFrame: abs(gramFirstValidFrame),
    bothDone,
    durationInFrames,
  };
}

// -- Trace-derived wall-clock strings -----------------------------------------
// The date chip and in-bubble timestamps are real captured instants: the
// trace's t0Epoch plus a recorded atMs. Formatting is UTC-only with a pinned
// month-name table — no Intl, no locale, no Date.now — so the same trace
// renders byte-identical frames on any machine.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Telegram's centered date chip, e.g. "19 September". */
export function dateChipText(t0Epoch: number): string {
  const d = new Date(t0Epoch);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]!}`;
}

/** "HH:MM" for a message that first appeared `atMs` after t0 (null-safe). */
export function sentAtText(t0Epoch: number, atMs: number | null): string | null {
  if (atMs === null) return null;
  const d = new Date(t0Epoch + atMs);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
