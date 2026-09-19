import { GramRenderError } from "../errors.js";
import { createEvaluator } from "../evaluate/typesafe.js";
import { batchCompose } from "./batch.js";
import { createUsageTracker } from "./call.js";
import { editCompose } from "./edit.js";
import type { CompositionEvent, ComposeOptions, RenderResult } from "./options.js";
import { DEFAULT_LIMITS, type Limits } from "./tree.js";

/** Maximum prompt length accepted (JEV state budget headroom). */
const MAX_PROMPT_CHARS = 4000;

/**
 * Compose a Telegram UI spec, streaming validated intermediate specs as
 * `step` events and finishing with one `complete` event.
 *
 * New specs (no `initialSpec`) use the batched two-call algorithm; editing an
 * existing spec runs the sequential operation loop. Errors reject the
 * generator — keep the last `step` snapshot for partial UI.
 */
export async function* composeSpec(options: ComposeOptions): AsyncGenerator<CompositionEvent> {
  if (!options.prompt || options.prompt.trim().length === 0) {
    throw new GramRenderError("A non-empty prompt is required.");
  }
  if (options.prompt.length > MAX_PROMPT_CHARS) {
    throw new GramRenderError(`Prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
  }
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const evaluate = options.evaluate ?? createEvaluator({});
  const tracker = createUsageTracker();
  const warnings: string[] = [];
  const stepCounter = { value: 0 };

  if (options.initialSpec) {
    yield* editCompose(options, limits, evaluate, tracker, warnings, stepCounter);
  } else {
    yield* batchCompose(options, limits, evaluate, tracker, warnings, stepCounter);
  }
}

/** One-shot composition: runs {@link composeSpec} to completion and returns the final result. */
export async function render(options: ComposeOptions): Promise<RenderResult> {
  for await (const event of composeSpec(options)) {
    if (event.type === "complete") {
      return {
        spec: event.spec,
        stopReason: event.stopReason,
        calls: event.calls,
        elapsedMs: event.elapsedMs,
        inputTokens: event.inputTokens,
        warnings: event.warnings,
        steps: event.steps,
      };
    }
  }
  // Unreachable: composeSpec always ends with a complete event (or throws).
  throw new GramRenderError("Composition ended without a complete event.");
}
