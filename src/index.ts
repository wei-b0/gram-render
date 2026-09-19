/**
 * gram-render — JEV-powered generative UI spec generation for Telegram bots.
 *
 * Prompt + context in, validated Telegram UI JSON spec out. The Telegram UI
 * catalog ships inside this package; consumers never register components, and
 * never execute actions — the spec describes them, the consumer's bot owns
 * them. No transport, no tokens, no Telegram API calls.
 */

// Composition
export { render, composeSpec } from "./compose/compose.js";
export type {
  ComposeOptions,
  RenderResult,
  CompositionEvent,
  CompositionStep,
  Guidance,
  StopReason,
} from "./compose/options.js";
export type { Limits } from "./compose/tree.js";

// Evaluator
export { createEvaluator } from "./evaluate/typesafe.js";
export type { Evaluator, EvaluateArgs, EvaluationResult, EvaluationAnswer, ChoiceQuestion } from "./evaluate/types.js";
export type { EvaluatorOptions } from "./evaluate/typesafe.js";

// Spec
export {
  GramSpecSchema,
  GramElementSchema,
  parseGramSpec,
  COMPONENT_TYPES,
  StatusLevel,
  ButtonStyle,
  TableProps,
  NoteProps,
} from "./spec/schema.js";
export type { GramSpec, GramElement, ComponentType } from "./spec/schema.js";

// Catalog (read-only metadata for tooling)
export { CATALOG, MESSAGE_CHILD_TYPES, SECTION_CHILD_TYPES } from "./catalog/components.js";
export type { ComponentDef } from "./catalog/components.js";
export { describeElement } from "./catalog/describe.js";

// Candidate derivation (advanced: pre-compute and inspect what JEV would choose among)
export { deriveCandidates } from "./derive/candidates.js";
export type { Candidate, CandidateElement, DerivedQuestion, DerivedOption, DeriveResult, DeriveOptions } from "./derive/candidates.js";

// Compilation & Telegram checks
export { compileClassicMessage, inspectClassicMessage, serializeCallbackData, escapeHtml } from "./compile/classic.js";
export type { ClassicMessage, ClassicInlineButton, CompileDiagnostics, CompileDiagnostic } from "./compile/classic.js";
export { compileRichMessage, inspectRichMessage, RICH_LIMITS } from "./compile/rich.js";
export type {
  RichMessagePayload,
  RichMessageInput,
  RichBlockJson,
  RichText,
  RichTextEntity,
  RichButtonJson,
  RichTableCellJson,
} from "./compile/rich.js";
export { telegramDiagnostics } from "./validate/telegram.js";

// Errors
export { GramRenderError, EvaluatorError, CompositionError, ValidationError } from "./errors.js";
export type { ValidationCode } from "./errors.js";
