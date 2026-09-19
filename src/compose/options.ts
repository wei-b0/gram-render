import type { GramSpec } from "../spec/schema.js";
import type { Evaluator } from "../evaluate/types.js";
import type { Limits } from "./tree.js";

/** Per-phase nudges forwarded to the evaluator inside `state.guidance`. */
export interface Guidance {
  /** Steers the select phase (which blocks/buttons to include). */
  select?: string;
  /** Steers the layout phase (ordering, grouping, rows). */
  layout?: string;
  /** Steers edit mode (which operations to apply). */
  edit?: string;
}

export interface ComposeOptions {
  /** What the UI should express. The main signal for selection decisions. */
  prompt: string;
  /** Structured data to display. Strings are used as-is; no prose is invented. */
  context?: Record<string, unknown>;
  /** Existing spec to edit instead of composing from scratch. */
  initialSpec?: GramSpec;
  /** Custom evaluator (TypeSafe by default; see createEvaluator). */
  evaluate?: Evaluator;
  guidance?: Guidance;
  limits?: Partial<Limits>;
  /** Propagated to every evaluator call. */
  signal?: AbortSignal;
  /**
   * Optional confidence gate: when set (0–1), a fulfillability answer below it
   * stops composition with `stopReason: "unavailable"`. Default: off.
   */
  minConfidence?: number;
}

export type StopReason = "finish" | "limit" | "unavailable";

export interface CompositionStep {
  /** 1-based decision index within the composition. */
  index: number;
  kind: "select" | "layout" | "edit";
  /** Human-readable summary of the decision. */
  description: string;
  /** Lowest confidence among the answers of this step (0–1), when available. */
  confidence?: number;
  /** Raw evaluator answers for this step. */
  answers?: Record<string, { choice: string; confidence?: number; probabilities?: Record<string, number> }>;
  elapsedMs: number;
  inputTokens: number | null;
}

export type CompositionEvent =
  | { type: "step"; spec: GramSpec; step: CompositionStep }
  | {
      type: "complete";
      spec: GramSpec | null;
      stopReason: StopReason;
      steps: CompositionStep[];
      calls: number;
      elapsedMs: number;
      inputTokens: number | null;
      warnings: string[];
    };

export interface RenderResult {
  spec: GramSpec | null;
  stopReason: StopReason;
  /** Evaluator calls made. */
  calls: number;
  elapsedMs: number;
  inputTokens: number | null;
  warnings: string[];
  steps: CompositionStep[];
}
