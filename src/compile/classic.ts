import { ValidationError, type ValidationCode } from "../errors.js";
import { childIdsOf, type Limits, DEFAULT_LIMITS } from "../compose/tree.js";
import type { ButtonElement, GramElement, GramSpec } from "../spec/schema.js";

/**
 * Reference compiler: GramSpec → a classic Telegram message payload
 * (`parse_mode: "HTML"` + one InlineKeyboardMarkup).
 *
 * Pure serialization — nothing here contacts Telegram. It doubles as the
 * validation backend: Telegram's hard limits (4096-char text, 64-byte
 * callback_data) and its soft client conventions (rows per keyboard, buttons
 * per row) are checked while compiling.
 */

export interface ClassicInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: "danger" | "success" | "primary";
  /** Telegram's DisabledButton "currently holds no information" — wire shape is `{}`, not a boolean. */
  disabled?: Record<string, never>;
}

export interface ClassicMessage {
  text: string;
  parse_mode: "HTML";
  reply_markup?: { inline_keyboard: ClassicInlineButton[][] };
}

export interface CompileDiagnostic {
  code: ValidationCode;
  message: string;
  elementId?: string;
}

export interface CompileDiagnostics {
  errors: CompileDiagnostic[];
  warnings: string[];
}

export interface InspectResult {
  message: ClassicMessage | undefined;
  diagnostics: CompileDiagnostics;
}

const DIVIDER = "──────────────";
const STATUS_EMOJI: Record<string, string> = { success: "✅", info: "ℹ️", warning: "⚠️", error: "❌" };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Serialize an action + payload into a callback_data string. */
export function serializeCallbackData(action: string, payload: Record<string, unknown> | undefined): string {
  if (!payload || Object.keys(payload).length === 0) return action;
  return JSON.stringify([action, payload]);
}

/** Compile without throwing: returns the best-effort message plus diagnostics. */
export function inspectClassicMessage(spec: GramSpec, limits?: Limits): InspectResult {
  const resolvedLimits = limits ?? DEFAULT_LIMITS;
  const errors: CompileDiagnostic[] = [];
  const warnings: string[] = [];

  const root = spec.elements[spec.root];
  const bodyLines: string[] = [];
  if (root && root.type === "Message") {
    const blocks = root.children
      .map((id) => spec.elements[id])
      .filter((element) => element !== undefined);
    bodyLines.push(...blocks.map((element) => renderBlock(element, spec, 0)));
  }
  const html = bodyLines.filter((line) => line.length > 0).join("\n\n");

  // Plain-text length (Telegram counts post-parse characters).
  const plain = plainFromHtml(html);
  if (plain.length > 4096) {
    errors.push({
      code: "text_too_long",
      message: `Rendered message is ${plain.length} plain characters; Telegram allows 4096.`,
    });
  } else if (plain.length > 3500) {
    warnings.push(`Rendered message uses ${plain.length}/4096 characters — close to the limit.`);
  }

  // Keyboard.
  let replyMarkup: ClassicMessage["reply_markup"];
  if (root && root.type === "Message" && root.keyboard.length > 0) {
    const keyboard: ClassicInlineButton[][] = [];
    for (const rowId of root.keyboard) {
      const row = spec.elements[rowId];
      if (!row || row.type !== "ButtonRow") continue;
      const buttons: ClassicInlineButton[] = [];
      for (const buttonId of row.children) {
        const element = spec.elements[buttonId];
        if (!element || element.type !== "Button") continue;
        const compiled = compileButton(element as ButtonElement, buttonId, errors);
        if (compiled) buttons.push(compiled);
      }
      keyboard.push(buttons);
    }
    if (keyboard.length > 8) {
      warnings.push(`Keyboard has ${keyboard.length} rows; most clients scroll beyond a handful.`);
    }
    for (const row of keyboard) {
      if (row.length > 6) warnings.push(`A keyboard row has ${row.length} buttons — 3–4 usually renders best.`);
    }
    replyMarkup = { inline_keyboard: keyboard };
  }

  return {
    message: { text: html, parse_mode: "HTML", reply_markup: replyMarkup },
    diagnostics: { errors, warnings },
  };
}

/** Compile and throw on any Telegram-limit violation. */
export function compileClassicMessage(spec: GramSpec, limits?: Limits): ClassicMessage {
  const { message, diagnostics } = inspectClassicMessage(spec, limits);
  if (diagnostics.errors.length > 0) {
    const first = diagnostics.errors[0]!;
    throw new ValidationError(first.code, first.message, { elementId: first.elementId, cause: diagnostics.errors });
  }
  return message!;
}

function compileButton(element: ButtonElement, elementId: string, errors: CompileDiagnostic[]): ClassicInlineButton | undefined {
  const props = element.props;
  const button: ClassicInlineButton = { text: props["label"] };
  if (props["disabled"] === true) {
    button.disabled = {}; // DisabledButton holds no information
  } else if (props["url"]) {
    button.url = props["url"];
  } else if (props["action"]) {
    const data = serializeCallbackData(props["action"], props["payload"] as Record<string, unknown> | undefined);
    const bytes = new TextEncoder().encode(data).length;
    if (bytes > 64) {
      errors.push({
        code: "callback_data_too_long",
        message: `Button '${props["label"]}': callback data is ${bytes} bytes (Telegram allows 64). Store large payloads server-side and reference them by id.`,
        elementId,
      });
    }
    button.callback_data = data;
  } else {
    errors.push({
      code: "button_target_missing",
      message: `Button '${props["label"]}' has no action or url.`,
      elementId,
    });
    return undefined;
  }
  if (typeof props["style"] === "string") {
    button.style = props["style"] as ClassicInlineButton["style"];
  }
  return button;
}

function renderBlock(element: GramElement, spec: GramSpec, depth: number): string {
  if (depth > 3) return ""; // unreachable via validated trees; defensive
  const props = element.props as Record<string, unknown>;
  switch (element.type) {
    case "Message":
      return "";
    case "Heading":
      return `<b>${escapeHtml(String(props["text"]))}</b>`;
    case "Text":
      return escapeHtml(String(props["text"]));
    case "Section": {
      const children = childIdsOf(element)
        .map((id) => spec.elements[id])
        .filter((child) => child !== undefined)
        .map((child) => renderBlock(child, spec, depth + 1));
      return [`<b>${escapeHtml(String(props["title"]))}</b>`, ...children].filter((line) => line.length > 0).join("\n");
    }
    case "Divider":
      return DIVIDER;
    case "Field": {
      const value = escapeHtml(String(props["value"]));
      const rendered = props["mono"] === true ? `<code>${value}</code>` : value;
      return `<b>${escapeHtml(String(props["label"]))}:</b> ${rendered}`;
    }
    case "List": {
      const items = (props["items"] as string[]) ?? [];
      const ordered = props["ordered"] === true;
      return items
        .map((item, index) => (ordered ? `${index + 1}. ` : "• ") + escapeHtml(item))
        .join("\n");
    }
    case "Status":
      return `${STATUS_EMOJI[String(props["level"])] ?? "•"} ${escapeHtml(String(props["text"]))}`;
    case "Code": {
      const language = typeof props["language"] === "string" ? ` class="language-${escapeHtml(props["language"])}"` : "";
      return `<pre><code${language}>${escapeHtml(String(props["text"]))}</code></pre>`;
    }
    case "Quote":
      return props["expandable"] === true
        ? `<blockquote expandable>${escapeHtml(String(props["text"]))}</blockquote>`
        : `<blockquote>${escapeHtml(String(props["text"]))}</blockquote>`;
    case "Alert": {
      const emoji = STATUS_EMOJI[String(props["level"])] ?? "•";
      const title = typeof props["title"] === "string" ? `<b>${escapeHtml(props["title"])}</b> — ` : "";
      return `${emoji} ${title}${escapeHtml(String(props["text"]))}`;
    }
    case "Table":
      return tableGrid(props["columns"] as string[] | undefined, (props["rows"] as string[][]) ?? []);
    case "Note":
      return `<i>${escapeHtml(String(props["text"]))}</i>`;
    case "ButtonRow":
      return "";
    case "Button":
      return ""; // buttons never render in the text body
  }
}

// Local helpers ----------------------------------------------------------------

/**
 * Render a table as a monospace-aligned grid inside `<pre>`. Column widths are
 * the natural max cell length; past ~100 total characters cells are truncated
 * proportionally (wide columns give up more). Character-count alignment —
 * emoji/CJK cells may visually shift (documented limitation).
 */
function tableGrid(columns: string[] | undefined, rows: string[][]): string {
  const dataRows = columns ? [columns, ...rows] : rows;
  if (dataRows.length === 0) return "";
  const width = dataRows[0]!.length;
  const SEPARATOR = "  ";

  const natural: number[] = [];
  for (let col = 0; col < width; col++) {
    natural.push(Math.max(...dataRows.map((row) => (row[col] ?? "").length)));
  }
  let widths = natural;
  const total = natural.reduce((sum, w) => sum + w, 0) + SEPARATOR.length * (width - 1);
  if (total > 100 && width > 1) {
    const budget = 100 - SEPARATOR.length * (width - 1);
    const scale = budget / natural.reduce((sum, w) => sum + w, 0);
    widths = natural.map((w) => Math.max(4, Math.floor(w * scale)));
  }

  const lines = dataRows.map((row) =>
    row
      .map((cell, col) => truncateCell(cell, widths[col]!).padEnd(widths[col]!))
      .join(SEPARATOR)
      .trimEnd(),
  );

  if (columns) {
    const rule = widths.map((w) => "─".repeat(w)).join(SEPARATOR);
    lines.splice(1, 0, rule);
  }
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

function truncateCell(text: string, maxWidth: number): string {
  return text.length > maxWidth ? `${text.slice(0, Math.max(1, maxWidth - 1))}…` : text;
}

/** Approximate the post-parse plain text: strip tags, unescape entities. */
function plainFromHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
