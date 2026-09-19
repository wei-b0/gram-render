/**
 * Typed error hierarchy for gram-render.
 *
 * All errors extend {@link GramRenderError} so consumers can catch a single
 * type. Evaluator and composition failures reject the generator (partial
 * results remain available via the last emitted `step` event); `unavailable`
 * and `limit` are normal outcomes, not errors.
 */

export class GramRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GramRenderError";
  }
}

/** The JEV evaluator could not be reached or returned a malformed response. */
export class EvaluatorError extends GramRenderError {
  readonly status?: number;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options);
    this.name = "EvaluatorError";
    this.status = options?.status;
  }
}

/** The evaluator returned an answer the composer cannot use (out of criteria, wrong shape). */
export class CompositionError extends GramRenderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompositionError";
  }
}

/** A spec, candidate, or compiled message violates the schema, tree, or Telegram constraints. */
export class ValidationError extends GramRenderError {
  readonly code: ValidationCode;
  readonly elementId?: string;
  constructor(
    code: ValidationCode,
    message: string,
    options?: { elementId?: string; cause?: unknown },
  ) {
    super(message, options);
    this.name = "ValidationError";
    this.code = code;
    this.elementId = options?.elementId;
  }
}

export type ValidationCode =
  | "invalid_spec"
  | "unknown_type"
  | "slot_violation"
  | "dangling_ref"
  | "shared_element"
  | "root_missing"
  | "depth_exceeded"
  | "element_limit"
  | "text_too_long"
  | "block_limit"
  | "too_many_buttons"
  | "callback_data_too_long"
  | "button_target_missing"
  | "button_target_conflict"
  | "payload_not_serializable";
