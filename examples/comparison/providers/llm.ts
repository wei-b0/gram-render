/**
 * LLM side of the comparison: OpenAI Responses API streaming with native
 * structured output, captured raw — every delta, throttled validity probes,
 * gated partial-UI states, and per-attempt windows.
 *
 * The client is injected (structural `LlmStreamClient`, satisfied by a real
 * `OpenAI` instance) so tests run network-free; run.ts passes a real client.
 *
 * Retry policy: only transport/stream failures and unparseable final text are
 * retried (up to `maxAttempts` request windows; t0 never resets). A parseable
 * but schema-invalid output is recorded as the honest outcome, not retried.
 */

import { parse as parsePartial, Allow } from "partial-json";
import type { GramSpec } from "../../../src/spec/schema.js";
import type { ComparisonFixture } from "../fixture.js";
import { gateJsonTextDetailed, gateValueDetailed } from "../gate.js";
import type { GateResult, LlmSide } from "../types.js";
import { GRAM_SPEC_WIRE_SCHEMA } from "./gram-spec-schema.js";
import { buildSystemPrompt, buildUserMessage } from "./llm-prompt.js";

const DEFAULT_PROBE_INTERVAL_MS = 80;
const DEFAULT_MAX_ATTEMPTS = 3;

/** Minimal structural surface of the OpenAI client this module consumes. */
export interface LlmStreamClient {
  responses: {
    stream(params: {
      model: string;
      input: Array<{ role: "system" | "user"; content: string }>;
      text: {
        format: { type: "json_schema"; name: string; strict: boolean; schema: { [key: string]: unknown } };
      };
      max_output_tokens?: number;
    }): AsyncIterable<LlmStreamEvent>;
  };
}

/** The subset of Responses stream events this module reacts to. */
export interface LlmStreamEvent {
  type: string;
  delta?: string;
  response?: {
    id?: string;
    model?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
  } | null;
}

export interface LlmRunContext {
  fixture: ComparisonFixture;
  atMs: () => number;
  client: LlmStreamClient;
  model: string;
  /**
   * Output token cap passed to the API (recorded in the trace). Set for
   * budget-limited keys: providers pre-authorize worst-case cost, so the SDK
   * default (65536) can be rejected outright. Far above the fixture's need.
   */
  maxOutputTokens?: number;
  /** Minimum spacing between mid-stream validity probes. Default 80 ms. */
  probeIntervalMs?: number;
  /** Total request windows allowed (1 initial + retries). Default 3. */
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Partial-UI tracking
// ---------------------------------------------------------------------------

/**
 * Settled-element rule: an element counts as materialized only when it is
 * present and JSON-identical across two consecutive parses — a still-streaming
 * element changes between parses, a finished one does not.
 */
export class SettledTracker {
  private previous = new Map<string, unknown>();

  /** Feed one parse's elements; returns the ids settled as of this parse. */
  update(elements: Map<string, unknown>): Set<string> {
    const settled = new Set<string>();
    for (const [id, element] of elements) {
      const before = this.previous.get(id);
      if (before !== undefined && JSON.stringify(before) === JSON.stringify(element)) {
        settled.add(id);
      }
    }
    this.previous = elements;
    return settled;
  }
}

/** Pull the flat elements map out of a (possibly partial) parsed value. */
export function collectElements(value: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (typeof value === "object" && value !== null) {
    const elements = (value as { elements?: unknown }).elements;
    if (Array.isArray(elements)) {
      // Wire form: each element carries its own `id` key.
      for (const item of elements) {
        if (item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
          map.set((item as { id: string }).id, item);
        }
      }
    } else if (typeof elements === "object" && elements !== null) {
      for (const [id, element] of Object.entries(elements as Record<string, unknown>)) {
        map.set(id, element);
      }
    }
  }
  return map;
}

const clipToSettled = (ids: unknown, settled: Set<string>): unknown =>
  Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && settled.has(id)) : ids;

/**
 * Build a render-safe partial spec from a partial parse: only settled
 * elements, with id references (`children` / `keyboard`) clipped to settled
 * ids so nothing references an element that does not exist yet. Returns null
 * until the root element itself has settled. (`List.items` and `Table` cells
 * are label strings, not ids — never clipped.)
 *
 * Accepts both wire forms of `elements` (array with `id` keys — the strict
 * structured-output shape — and the final record form). The output is always
 * the record form, with each element's `id` key stripped (the zod schema's
 * `.strict()` objects reject it).
 *
 * Works on deep clones: the parsed value must stay pristine because
 * {@link SettledTracker} compares future parses against it.
 */
export function extractPartialSpec(value: unknown, settled: Set<string>): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const { root } = value as { root?: unknown };
  if (typeof root !== "string" || !settled.has(root)) return null;
  if (collectElements(value).size === 0) return null;

  const source = collectElements(value);
  const settledElements: Record<string, unknown> = {};
  for (const id of settled) {
    const element = source.get(id);
    if (element === undefined) continue;
    if (typeof element !== "object" || element === null) {
      settledElements[id] = element;
      continue;
    }
    const record = JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
    delete record["id"]; // consumed as the map key in the record form
    // Only clip keys the element actually has — assigning `undefined` would
    // add the key and trip zod's strict objects on leaf elements.
    if ("children" in record) record.children = clipToSettled(record.children, settled);
    if ("keyboard" in record) record.keyboard = clipToSettled(record.keyboard, settled);
    settledElements[id] = record;
  }

  // `version` is pinned to 1 by the wire schema; use the parsed value when present.
  const version = (value as { version?: unknown }).version;
  return { version: typeof version === "number" ? version : 1, root, elements: settledElements };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export async function runLlmSide(ctx: LlmRunContext): Promise<LlmSide> {
  const atMs = ctx.atMs;
  const probeIntervalMs = ctx.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const maxAttempts = ctx.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const deltas: LlmSide["deltas"] = [];
  const checks: LlmSide["checks"] = [];
  const partialRenders: LlmSide["partialRenders"] = [];
  const attempts: LlmSide["attempts"] = [];

  let firstTokenMs: number | null = null;
  let firstValidMs: number | null = null;
  let finalText = "";
  let finalSpec: GramSpec | null = null;
  let modelReported: string | undefined;
  let finalGate: GateResult = { ok: false, stage: "parse", issues: ["no request attempts"], normalized: false };

  const input = [
    { role: "system" as const, content: buildSystemPrompt() },
    { role: "user" as const, content: buildUserMessage(ctx.fixture) },
  ];

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    const startedMs = atMs();
    const chunks: string[] = [];
    let attemptFirstTokenMs: number | null = null;
    let responseId: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let completed = false;
    let incompleteReason: string | undefined;
    let lastProbeAt = -Infinity;
    const tracker = new SettledTracker();

    const probe = (): void => {
      const now = atMs();
      if (now - lastProbeAt < probeIntervalMs) return;
      lastProbeAt = now;
      let value: unknown;
      try {
        value = parsePartial(chunks.join(""), Allow.ALL);
      } catch {
        return; // prefix not salvageable yet — not a validity signal
      }
      const partial = extractPartialSpec(value, tracker.update(collectElements(value)));
      if (partial === null) return;
      const outcome = gateValueDetailed(partial);
      checks.push({ atMs: now, gate: outcome.gate });
      if (outcome.gate.ok && outcome.spec !== null) {
        partialRenders.push({ atMs: now, spec: outcome.spec });
      }
    };

    let streamError: string | undefined;
    try {
      const stream = ctx.client.responses.stream({
        model: ctx.model,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "gram_spec",
            strict: true,
            schema: GRAM_SPEC_WIRE_SCHEMA,
          },
        },
        ...(ctx.maxOutputTokens !== undefined ? { max_output_tokens: ctx.maxOutputTokens } : {}),
      });
      for await (const event of stream) {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          const now = atMs();
          chunks.push(event.delta);
          if (attemptFirstTokenMs === null) attemptFirstTokenMs = now;
          if (firstTokenMs === null) firstTokenMs = now;
          deltas.push({ atMs: now, text: event.delta, attemptIndex });
          probe();
        } else if (event.type === "response.completed" && event.response) {
          completed = true;
          if (event.response.id) responseId = event.response.id;
          if (event.response.model) modelReported = event.response.model;
          if (event.response.usage) {
            usage = {
              inputTokens: event.response.usage.input_tokens ?? 0,
              outputTokens: event.response.usage.output_tokens ?? 0,
            };
          }
        } else if (event.type === "response.incomplete" && event.response) {
          // Terminal without completion: the output hit a cap. Usage is still
          // recorded; the truncated text is treated as a parse failure below.
          if (event.response.id) responseId = event.response.id;
          if (event.response.model) modelReported = event.response.model;
          if (event.response.usage) {
            usage = {
              inputTokens: event.response.usage.input_tokens ?? 0,
              outputTokens: event.response.usage.output_tokens ?? 0,
            };
          }
          incompleteReason = event.response.incomplete_details?.reason ?? "unknown";
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error);
    }

    const endedMs = atMs();
    finalText = chunks.join("");

    let error: string | undefined = streamError;
    if (streamError !== undefined) {
      finalGate = { ok: false, stage: "parse", issues: [streamError], normalized: false };
    } else if (!completed && incompleteReason !== undefined) {
      error = `response incomplete (${incompleteReason}) — output truncated`;
      finalGate = { ok: false, stage: "parse", issues: [error], normalized: false };
    } else if (!completed) {
      error = "stream ended without response.completed";
      finalGate = { ok: false, stage: "parse", issues: [error], normalized: false };
    } else {
      const outcome = gateJsonTextDetailed(finalText);
      finalGate = outcome.gate;
      if (outcome.gate.ok && outcome.spec !== null) {
        finalSpec = outcome.spec;
        if (firstValidMs === null) firstValidMs = endedMs;
      }
    }

    attempts.push({
      startedMs,
      endedMs,
      responseId,
      firstTokenMs: attemptFirstTokenMs,
      usage,
      finalGate,
      ...(error !== undefined ? { error } : {}),
    });

    if (streamError !== undefined || !completed || finalGate.stage === "parse") continue; // retryable
    break; // valid, or schema/wire-invalid but parseable — an honest outcome
  }

  return {
    deltas,
    checks,
    partialRenders,
    attempts,
    firstTokenMs,
    firstValidMs,
    finalText,
    finalGate,
    finalSpec,
    modelReported,
  };
}

/**
 * Untimed warmup: one real streaming request with the IDENTICAL schema string
 * so OpenAI's one-time structured-output schema compilation never lands in a
 * measured run. The result is discarded; only the duration is reported.
 */
export async function warmupLlm(client: LlmStreamClient, model: string, maxOutputTokens?: number): Promise<number> {
  const started = performance.now();
  const stream = client.responses.stream({
    model,
    input: [{ role: "user", content: "Reply with the smallest valid GramSpec: a Message with one Text child." }],
    text: { format: { type: "json_schema", name: "gram_spec", strict: true, schema: GRAM_SPEC_WIRE_SCHEMA } },
    ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
  });
  for await (const event of stream) {
    if (event.type === "response.completed") break;
  }
  return performance.now() - started;
}
