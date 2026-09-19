/**
 * Trace schema for the LLM vs gram-render+JEV comparison benchmark.
 *
 * One `ComparisonTrace` JSON file fully describes a single real benchmark run
 * — raw stream deltas, partial-UI states, JEV call evidence, spec snapshots,
 * timings, and environment pins — so the Remotion composition can replay the
 * run with zero API calls. Everything on screen in the video comes from here.
 */

import { z } from "zod";
import { GramSpecSchema } from "../../src/spec/schema.js";

/** Where a gated value failed: JSON parse, zod schema, Telegram wire checks, or not at all. */
export const GateStageSchema = z.enum(["parse", "schema", "wire", "ok"]);

export const GateResultSchema = z.object({
  ok: z.boolean(),
  stage: GateStageSchema,
  /** Error messages at the failure stage; empty when ok. */
  issues: z.array(z.string()),
  /** Whether the null-strip normalization ran before schema validation. */
  normalized: z.boolean(),
});

// ---------------------------------------------------------------------------
// LLM side
// ---------------------------------------------------------------------------

/** One streamed text delta, timestamped relative to t0. */
export const LlmDeltaSchema = z.object({
  atMs: z.number(),
  text: z.string(),
  /** Which request attempt produced this delta (0-based; retries increment). */
  attemptIndex: z.number(),
});

/** A throttled mid-stream validity probe (including failures). */
export const LlmCheckSchema = z.object({ atMs: z.number(), gate: GateResultSchema });

/** A gated partial-UI state: only fully-settled elements, render-safe. */
export const LlmPartialSchema = z.object({ atMs: z.number(), spec: GramSpecSchema });

/** One request window. Retries get their own attempt; t0 never resets. */
export const LlmAttemptSchema = z.object({
  startedMs: z.number(),
  endedMs: z.number(),
  responseId: z.string().optional(),
  firstTokenMs: z.number().nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  finalGate: GateResultSchema,
  error: z.string().optional(),
});

export const LlmSideSchema = z.object({
  deltas: z.array(LlmDeltaSchema),
  checks: z.array(LlmCheckSchema),
  partialRenders: z.array(LlmPartialSchema),
  attempts: z.array(LlmAttemptSchema),
  /** First streamed token, relative to t0. */
  firstTokenMs: z.number().nullable(),
  /** TIME TO VALID GRAMSPEC — first gate pass on the complete parse. */
  firstValidMs: z.number().nullable(),
  finalText: z.string(),
  finalSpec: GramSpecSchema.nullable(),
  finalGate: GateResultSchema,
  modelReported: z.string().optional(),
});

// ---------------------------------------------------------------------------
// gram-render side
// ---------------------------------------------------------------------------

export const EvaluationAnswerSchema = z.object({
  choice: z.string(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});

export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()),
});

/** One JEV round trip, captured by wrapping the injected Evaluator. */
export const JevCallSchema = z.object({
  index: z.number(),
  startedMs: z.number(),
  endedMs: z.number(),
  state: z.record(z.string(), z.unknown()),
  questions: z.record(z.string(), ChoiceQuestionSchema),
  answers: z.record(z.string(), EvaluationAnswerSchema),
  usage: z.object({ inputTokens: z.number().optional() }).optional(),
  model: z.string().optional(),
});

export const CompositionStepSchema = z.object({
  index: z.number(),
  kind: z.enum(["select", "layout", "edit"]),
  description: z.string(),
  confidence: z.number().optional(),
  answers: z.record(z.string(), EvaluationAnswerSchema).optional(),
  elapsedMs: z.number(),
  inputTokens: z.number().nullable(),
});

/** A composeSpec generator pull, timestamped relative to t0. */
export const GramEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("step"),
    atMs: z.number(),
    spec: GramSpecSchema,
    step: CompositionStepSchema,
  }),
  z.object({
    type: z.literal("complete"),
    atMs: z.number(),
    spec: GramSpecSchema.nullable(),
    stopReason: z.string(),
    calls: z.number(),
    elapsedMs: z.number(),
    inputTokens: z.number().nullable(),
    warnings: z.array(z.string()),
  }),
]);

export const GramSideSchema = z.object({
  /** Approximate derivation time (first JEV call start − first pull). */
  deriveMs: z.number().nullable(),
  calls: z.array(JevCallSchema),
  events: z.array(GramEventSchema),
  /** First gate-passing step spec (the select-step snapshot). */
  firstUiMs: z.number().nullable(),
  /** TIME TO VALID GRAMSPEC — gate-passing complete spec. */
  firstValidMs: z.number().nullable(),
  finalGate: GateResultSchema,
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Trace envelope
// ---------------------------------------------------------------------------

export const TraceMetaSchema = z.object({
  schemaVersion: z.literal(1),
  runIndex: z.number(),
  runsPlanned: z.number(),
  warm: z.boolean(),
  startedAtIso: z.string(),
  gitSha: z.string(),
  nodeVersion: z.string(),
  fixtureId: z.string(),
  prompt: z.string(),
  promptSha256: z.string(),
  contextSha256: z.string(),
  llm: z.object({
    /** Where the Responses API call went: OpenAI directly, or via OpenRouter. */
    provider: z.enum(["openai", "openrouter"]),
    model: z.string(),
    api: z.literal("responses"),
    textFormat: z.literal("json_schema"),
    schemaSha256: z.string(),
    openaiVersion: z.string(),
    baseUrl: z.string(),
    /** Output token cap sent with each request (budget-limited keys). */
    maxOutputTokens: z.number(),
  }),
  jev: z.object({ model: z.string(), baseUrl: z.string() }),
  /** composeSpec calibration floor for the gram-render side (optional). */
  minConfidence: z.number().optional(),
  warmupMs: z.object({ llm: z.number(), jev: z.number() }).optional(),
});

export const TraceSummarySchema = z.object({
  llmValidMs: z.number().nullable(),
  gramValidMs: z.number().nullable(),
  llmFirstUiMs: z.number().nullable(),
  gramFirstUiMs: z.number().nullable(),
  winner: z.enum(["llm", "gramRender", "tie", "none"]),
});

export const ComparisonTraceSchema = z.object({
  meta: TraceMetaSchema,
  /** Epoch ms when t0 was taken (wall-clock anchor; all atMs are relative). */
  t0Epoch: z.number(),
  llm: LlmSideSchema,
  gramRender: GramSideSchema,
  summary: TraceSummarySchema,
});

export type GateStage = z.infer<typeof GateStageSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;
export type LlmDelta = z.infer<typeof LlmDeltaSchema>;
export type LlmCheck = z.infer<typeof LlmCheckSchema>;
export type LlmPartial = z.infer<typeof LlmPartialSchema>;
export type LlmAttempt = z.infer<typeof LlmAttemptSchema>;
export type LlmSide = z.infer<typeof LlmSideSchema>;
export type JevCall = z.infer<typeof JevCallSchema>;
export type CompositionStepTrace = z.infer<typeof CompositionStepSchema>;
export type GramEvent = z.infer<typeof GramEventSchema>;
export type GramSide = z.infer<typeof GramSideSchema>;
export type TraceMeta = z.infer<typeof TraceMetaSchema>;
export type TraceSummary = z.infer<typeof TraceSummarySchema>;
export type ComparisonTrace = z.infer<typeof ComparisonTraceSchema>;
