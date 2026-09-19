/**
 * Value recognition: map raw context values to richer Telegram-native
 * components where the meaning is unambiguous (status words → Status lines
 * with level/emoji, URLs → link buttons), and format display strings
 * (dates, nulls, scalar arrays).
 */

import { formatValue } from "./harvest.js";
import type { StatusLevel } from "../spec/schema.js";

export interface StatusInfo {
  level: StatusLevel;
  /** Single lowercase word describing the status. */
  label: string;
}

const STATUS_WORDS: Record<string, StatusLevel> = {
  // success
  running: "success",
  active: "success",
  healthy: "success",
  online: "success",
  ok: "success",
  success: "success",
  succeeded: "success",
  done: "success",
  completed: "success",
  complete: "success",
  passed: "success",
  ready: "success",
  connected: "success",
  delivered: "success",
  shipped: "success",
  paid: "success",
  // info
  pending: "info",
  queued: "info",
  processing: "info",
  in_progress: "info",
  starting: "info",
  starting_up: "info",
  idle: "info",
  waiting: "info",
  scheduled: "info",
  created: "info",
  open: "info",
  // warning
  degraded: "warning",
  warning: "warning",
  stale: "warning",
  retrying: "warning",
  paused: "warning",
  slow: "warning",
  behind: "warning",
  // error
  failed: "error",
  failure: "error",
  error: "error",
  errored: "error",
  offline: "error",
  crashed: "error",
  down: "error",
  canceled: "error",
  cancelled: "error",
  rejected: "error",
  expired: "error",
  blocked: "error",
  unhealthy: "error",
};

const STATUS_KEYS = new Set(["status", "state", "health", "phase", "condition", "level"]);

/**
 * Recognize a status-like scalar. Either the value is a known status word, or
 * the key is status-shaped (status/state/health/…) and the value is a short
 * single token (mapped to `info` when unrecognized).
 */
export function recognizeStatus(key: string, value: string): StatusInfo | undefined {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  const fromValue = STATUS_WORDS[normalized];
  if (fromValue) return { level: fromValue, label: normalized };
  if (STATUS_KEYS.has(key.toLowerCase()) && /^[a-z_]{1,24}$/.test(normalized)) {
    return { level: "info", label: normalized };
  }
  return undefined;
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+$/.test(value) && value.length <= 2048;
}

/** Key words whose string values are worth rendering as code blocks. */
const CODE_KEYS = new Set(["code", "log", "logs", "snippet", "diff", "patch", "stack", "trace", "stacktrace", "json", "output", "tail"]);

export function looksLikeCode(key: string, value: string): boolean {
  // Match whole key names ("log") and word parts ("terminal_tail" → "tail").
  const words = key.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.some((word) => CODE_KEYS.has(word)) && value.length >= 2;
}

// ---------------------------------------------------------------- dates

/** Keys whose numeric values may be epoch timestamps (guards e.g. `tasks_done: 142`). */
const DATE_KEY = /(at|time|date|ts|epoch|since|until|created|updated|modified|deadline|expires|last_?seen)/i;
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function isoToHuman(value: string): string | undefined {
  const match = ISO_DATETIME.exec(value.trim());
  return match ? `${match[1]!} ${match[2]!}` : undefined;
}

function epochToHuman(value: number): string | undefined {
  // Seconds: 1e9–1e11 (2001–5138). Milliseconds: 1e12–1e15.
  const ms = value >= 1e12 && value <= 1e15 ? value : value >= 1e9 && value <= 1e11 ? value * 1000 : undefined;
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Format a context value for display, with light recognition on top of
 * {@link formatValue}: ISO 8601 datetimes → "YYYY-MM-DD HH:MM"; epoch numbers
 * → the same, but only under date-shaped keys; null → "—"; scalar arrays →
 * comma-joined. Returns undefined when the value has no display form.
 */
export function displayValue(key: string, value: unknown): string | undefined {
  if (value === null) return "—";
  if (typeof value === "string") {
    return isoToHuman(value) ?? formatValue(value);
  }
  if (typeof value === "number" && Number.isFinite(value) && DATE_KEY.test(key)) {
    return epochToHuman(value) ?? formatValue(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => formatValue(entry)).filter((entry): entry is string => entry !== undefined);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return formatValue(value);
}
