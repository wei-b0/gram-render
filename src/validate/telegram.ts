import { inspectClassicMessage, type CompileDiagnostics } from "../compile/classic.js";
import { inspectRichMessage } from "../compile/rich.js";
import type { GramSpec } from "../spec/schema.js";

/**
 * Telegram-limit checks for a spec against a compile target. The classic
 * target measures rendered HTML text (≤4096 plain chars), callback_data size
 * (≤64 bytes), and soft client conventions (keyboard rows, buttons per row);
 * the rich target measures block count (≤500), buttons per block (≤8), and the
 * 32,768-char rich text budget. Soft-limit hints surface as warnings.
 */
export function telegramDiagnostics(spec: GramSpec, target: "classic" | "rich" = "classic"): CompileDiagnostics {
  return target === "rich" ? inspectRichMessage(spec).diagnostics : inspectClassicMessage(spec).diagnostics;
}
