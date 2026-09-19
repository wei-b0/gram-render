/**
 * Text harvesting and formatting for candidate derivation.
 *
 * JEV cannot invent prose — every display string in a candidate prop comes
 * from the caller's context, a quoted string in the prompt, or a key-name
 * derived label. This module provides the mechanical extraction.
 */

const QUOTED = /["“]([^"”\n]{1,120})["”]/g;

/** Extract double-quoted (and curly-quoted) strings from the prompt, in order. */
export function extractQuoted(prompt: string): string[] {
  const results: string[] = [];
  for (const match of prompt.matchAll(QUOTED)) {
    const text = match[1]?.trim();
    if (text) results.push(text);
  }
  return results;
}

const ACRONYMS = new Set(["id", "url", "eta", "api", "cpu", "ram", "ip", "dns", "ttl", "uuid", "http", "ssl", "vm", "os"]);

/** "tasks_done" / "tasksDone" / "tasks-done" → "Tasks Done" (acronyms stay uppercase). */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** Format a scalar context value as a display string. Non-displayable values return undefined. */
export function formatValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return undefined;
}

/** Slug for candidate ids: lowercase words joined by `_`, truncated. */
export function slugify(text: string, max = 24): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\d]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/g, "");
  return slug || "x";
}

/** Shorten a string for inclusion in a JEV-facing description. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
