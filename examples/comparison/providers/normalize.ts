/**
 * Normalize an LLM-produced value against the GramSpec schema's optionality
 * and wire-shape rules before validation.
 *
 * Two kinds of normalization, applied identically to both sides (gram-render
 * specs are already in final shape, so for them this is an identity walk; the
 * `normalized` flag on gate results records that it ran):
 *
 * 1. Wire shapes → record shapes. OpenAI strict structured output supports no
 *    map types (`additionalProperties` with a subschema is rejected at any
 *    depth), so two GramSpec records go over the wire as arrays:
 *      - `elements`: `[{id, type, props, ...}]` → `{ [id]: {type, props, ...} }`
 *        (the `id` key is consumed as the map key);
 *      - `Button.payload`: `[{key, value}]` → `{ [key]: value }`, values
 *        preserved verbatim (nulls are legal payload values).
 *    Malformed entries (element without a string id, pair without a string
 *    key) are dropped — what breaks downstream is reported by the zod gate.
 *
 * 2. Null-strip. Strict output has no true optionality — optional props are
 *    emitted as explicit nulls, and GramSpec's zod schema rejects unknown/null
 *    props (every props object is `.strict()`), so keys whose value is `null`
 *    are deep-stripped. Exception: `payload` values are caller-defined JSON
 *    where null is legal — that subtree is preserved (post pair-conversion).
 */

export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripNulls(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === null) continue;
      out[key] = key === "payload" ? child : stripNulls(child);
    }
    return out;
  }
  return value;
}

/** Wire arrays → record shapes (`elements` by id, `payload` by key). */
export function wireToRecords(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => wireToRecords(item));
  }
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "elements" && Array.isArray(child)) {
      const record: Record<string, unknown> = {};
      for (const item of child) {
        if (item === null || typeof item !== "object") continue;
        const { id, ...rest } = item as Record<string, unknown>;
        if (typeof id !== "string") continue;
        record[id] = wireToRecords(rest);
      }
      out[key] = record;
    } else if (key === "payload" && Array.isArray(child)) {
      const record: Record<string, unknown> = {};
      for (const item of child) {
        if (item === null || typeof item !== "object") continue;
        const pair = item as Record<string, unknown>;
        if (typeof pair["key"] !== "string") continue;
        record[pair["key"]] = pair["value"];
      }
      out[key] = record;
    } else {
      out[key] = wireToRecords(child);
    }
  }
  return out;
}

/** Full pre-gate normalization: wire shapes first, then null-strip. */
export function normalizeForGate(value: unknown): unknown {
  return stripNulls(wireToRecords(value));
}
