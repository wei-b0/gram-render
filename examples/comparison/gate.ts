/**
 * The shared validity gate — the benchmark's single definition of "a valid
 * GramSpec", applied identically to both sides:
 *
 *   JSON.parse → wire-shape + null-strip normalization (providers/normalize.ts)
 *   → GramSpecSchema.safeParse
 *   → root must exist in elements (the compiler tolerates dangling refs by
 *     skipping them, but a spec without its root renders nothing)
 *   → inspectClassicMessage with zero diagnostics errors (Telegram-wire valid)
 *
 * `firstValidMs` on each side is the first gate pass on a COMPLETE value;
 * gated partial renders never count toward the metric.
 */

import { inspectClassicMessage } from "../../src/compile/classic.js";
import type { GramSpec } from "../../src/spec/schema.js";
import { GramSpecSchema } from "../../src/spec/schema.js";
import { normalizeForGate } from "./providers/normalize.js";
import type { GateResult } from "./types.js";

export type { GateResult };

/** Gate result plus the zod-validated spec (null unless the gate passed). */
export interface GateOutcome {
  gate: GateResult;
  spec: GramSpec | null;
}

/** Gate an already-parsed JavaScript value (plain object). */
export function gateValueDetailed(value: unknown): GateOutcome {
  const normalized = normalizeForGate(value);
  const parsed = GramSpecSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      gate: {
        ok: false,
        stage: "schema",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        normalized: true,
      },
      spec: null,
    };
  }
  if (parsed.data.elements[parsed.data.root] === undefined) {
    return {
      gate: {
        ok: false,
        stage: "schema",
        issues: ["root_not_found: spec.root does not reference an element in spec.elements"],
        normalized: true,
      },
      spec: null,
    };
  }
  const inspected = inspectClassicMessage(parsed.data);
  const errors = inspected.diagnostics.errors.map((d) => `${d.code}: ${d.message}`);
  if (errors.length > 0) {
    return { gate: { ok: false, stage: "wire", issues: errors, normalized: true }, spec: null };
  }
  return { gate: { ok: true, stage: "ok", issues: [], normalized: true }, spec: parsed.data };
}

export function gateValue(value: unknown): GateResult {
  return gateValueDetailed(value).gate;
}

/** Gate a raw JSON string — adds the parse stage. */
export function gateJsonTextDetailed(text: string): GateOutcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      gate: {
        ok: false,
        stage: "parse",
        issues: [error instanceof Error ? error.message : String(error)],
        normalized: false,
      },
      spec: null,
    };
  }
  return gateValueDetailed(value);
}

export function gateJsonText(text: string): GateResult {
  return gateJsonTextDetailed(text).gate;
}
