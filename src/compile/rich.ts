import { ValidationError } from "../errors.js";
import { childIdsOf } from "../compose/tree.js";
import { serializeCallbackData } from "./classic.js";
import type { ButtonElement, GramElement, GramSpec } from "../spec/schema.js";
import type { CompileDiagnostic, CompileDiagnostics } from "./classic.js";

/**
 * Rich Messages compile target (Bot API 10.1–10.3): GramSpec → the
 * `rich_message` payload accepted by `sendRichMessage` and `editMessageText`.
 *
 * Pure serialization — nothing here contacts Telegram. Field names were
 * verified against the official Bot API reference (core.telegram.org/bots/api,
 * Sep 2026):
 * - block `type` discriminators: "paragraph" | "heading" | "footer" | "divider"
 *   | "list" | "pre" | "blockquote" | "expandable_blockquote" | "pullquote"
 *   | "table" | "buttons" | "details"
 * - input list items carry `blocks` (the output-side `label` field does not
 *   exist on input)
 * - table cells: {text?, is_header?, colspan?, rowspan?, align?, valign?}
 *   (align/valign are not marked Optional in the docs → always emitted)
 * - `RichMessageButton.disabled` is a `DisabledButton` — "currently holds no
 *   information" — so the wire shape is `{}`, not `true` (same applies to the
 *   classic InlineKeyboardButton field added in the same release).
 *
 * Known-undocumented wire behavior, probed by the live smoke script
 * (examples/rich-smoke.ts) before this mapping is trusted for Field/Alert
 * composite text: RichText accepting plain strings and arrays mixing strings
 * with entities; heading `size` scale; footer blocks mid-message.
 */

/** Telegram's official Rich Message limits (rich-message-limits section). */
export const RICH_LIMITS = {
  /** Total UTF-8 characters across all block text. */
  maxTextChars: 32_768,
  /** Blocks, including nested blocks, list items, and table rows. */
  maxBlocks: 500,
  /** Buttons in one "buttons" block. */
  maxButtonsPerBlock: 8,
  /** Table columns. */
  maxTableColumns: 20,
} as const;

export type RichTextEntity =
  | { type: "bold"; text: RichText }
  | { type: "italic"; text: RichText }
  | { type: "code"; text: RichText }
  | { type: "underline"; text: RichText }
  | { type: "strikethrough"; text: RichText };

/**
 * Where a RichText is expected the API accepts a plain string, or an array
 * mixing strings and entities (verified live; see module comment).
 */
export type RichText = string | (string | RichTextEntity)[];

export interface RichTableCellJson {
  text?: RichText;
  is_header?: boolean;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
}

export interface RichButtonJson {
  text: RichText;
  style?: "danger" | "success" | "primary" | "link";
  url?: string;
  callback_data?: string;
  disabled?: Record<string, never>;
}

export type RichBlockJson =
  | { type: "paragraph"; text: RichText }
  | { type: "heading"; text: RichText; size: number }
  | { type: "footer"; text: RichText }
  | { type: "divider" }
  | { type: "list"; items: Array<{ blocks: RichBlockJson[]; value?: number; type?: "a" | "A" | "i" | "I" | "1" }> }
  | { type: "pre"; text: RichText; language?: string }
  | { type: "blockquote"; blocks: RichBlockJson[]; credit?: RichText }
  | { type: "expandable_blockquote"; text: RichText; credit?: RichText }
  | { type: "table"; cells: RichTableCellJson[][]; is_bordered?: boolean; is_striped?: boolean; is_compact?: boolean; caption?: RichText }
  | { type: "buttons"; buttons: RichButtonJson[] };

export interface RichMessageInput {
  blocks: RichBlockJson[];
}

/**
 * The compiled payload: spread into `sendRichMessage` (`{ chat_id, ...payload }`)
 * or `editMessageText` (`{ chat_id, message_id, ...payload }`).
 */
export interface RichMessagePayload {
  rich_message: RichMessageInput;
}

export interface RichInspectResult {
  payload: RichMessagePayload | undefined;
  diagnostics: CompileDiagnostics;
}

const STATUS_EMOJI: Record<string, string> = { success: "✅", info: "ℹ️", warning: "⚠️", error: "❌" };
const HEADING_SIZE = 3;
const SECTION_HEADING_SIZE = 5;

/** Compile without throwing: returns the best-effort payload plus diagnostics. */
export function inspectRichMessage(spec: GramSpec): RichInspectResult {
  const errors: CompileDiagnostic[] = [];
  const warnings: string[] = [];
  const blocks: RichBlockJson[] = [];

  const root = spec.elements[spec.root];
  if (root && root.type === "Message") {
    for (const childId of root.children) {
      const element = spec.elements[childId];
      if (element !== undefined) renderBlock(element, spec, blocks, errors);
    }
    for (const rowId of root.keyboard) {
      const row = spec.elements[rowId];
      if (!row || row.type !== "ButtonRow") continue;
      const buttons: RichButtonJson[] = [];
      for (const buttonId of row.children) {
        const element = spec.elements[buttonId];
        if (!element || element.type !== "Button") continue;
        const compiled = compileButton(element as ButtonElement, buttonId, errors);
        if (compiled) buttons.push(compiled);
      }
      if (buttons.length > RICH_LIMITS.maxButtonsPerBlock) {
        errors.push({
          code: "too_many_buttons",
          message: `A buttons block has ${buttons.length} buttons; Rich Messages allow ${RICH_LIMITS.maxButtonsPerBlock}.`,
          elementId: rowId,
        });
      } else if (buttons.length >= RICH_LIMITS.maxButtonsPerBlock) {
        warnings.push(`A buttons block has ${buttons.length} buttons — the Rich Messages maximum.`);
      }
      blocks.push({ type: "buttons", buttons });
    }
  }

  const budget = budgetOf(blocks);
  if (budget.textChars > RICH_LIMITS.maxTextChars) {
    errors.push({
      code: "text_too_long",
      message: `Rendered rich text is ${budget.textChars} characters; Rich Messages allow ${RICH_LIMITS.maxTextChars}.`,
    });
  }
  if (budget.blocks > RICH_LIMITS.maxBlocks) {
    errors.push({
      code: "block_limit",
      message: `Message expands to ${budget.blocks} blocks (incl. list items and table rows); Rich Messages allow ${RICH_LIMITS.maxBlocks}.`,
    });
  } else if (budget.blocks > 400) {
    warnings.push(`Message expands to ${budget.blocks} blocks — close to the 500-block limit.`);
  }

  return { payload: { rich_message: { blocks } }, diagnostics: { errors, warnings } };
}

/** Compile and throw on any Telegram-limit violation. */
export function compileRichMessage(spec: GramSpec): RichMessagePayload {
  const { payload, diagnostics } = inspectRichMessage(spec);
  if (diagnostics.errors.length > 0) {
    const first = diagnostics.errors[0]!;
    throw new ValidationError(first.code, first.message, {
      elementId: first.elementId,
      cause: diagnostics.errors,
    });
  }
  return payload!;
}

function compileButton(element: ButtonElement, elementId: string, errors: CompileDiagnostic[]): RichButtonJson | undefined {
  const props = element.props;
  const button: RichButtonJson = { text: props["label"] };
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
    button.style = props["style"] as RichButtonJson["style"];
  }
  return button;
}

function renderBlock(element: GramElement, spec: GramSpec, out: RichBlockJson[], errors: CompileDiagnostic[]): void {
  const props = element.props as Record<string, unknown>;
  switch (element.type) {
    case "Message":
      return; // handled by inspectRichMessage
    case "Heading":
      out.push({ type: "heading", text: String(props["text"]), size: HEADING_SIZE });
      return;
    case "Text":
      out.push({ type: "paragraph", text: String(props["text"]) });
      return;
    case "Section": {
      out.push({ type: "heading", text: String(props["title"]), size: SECTION_HEADING_SIZE });
      for (const childId of childIdsOf(element)) {
        const child = spec.elements[childId];
        if (child !== undefined) renderBlock(child, spec, out, errors);
      }
      return;
    }
    case "Divider":
      out.push({ type: "divider" });
      return;
    case "Field": {
      const value: RichTextEntity | string =
        props["mono"] === true ? { type: "code", text: String(props["value"]) } : String(props["value"]);
      out.push({ type: "paragraph", text: [{ type: "bold", text: `${String(props["label"])}:` }, " ", value] });
      return;
    }
    case "List": {
      const items = (props["items"] as string[]) ?? [];
      const ordered = props["ordered"] === true;
      out.push({
        type: "list",
        items: items.map((item) => ({
          blocks: [{ type: "paragraph", text: item }],
          ...(ordered ? { type: "1" as const } : {}),
        })),
      });
      return;
    }
    case "Status":
      out.push({ type: "paragraph", text: `${STATUS_EMOJI[String(props["level"])] ?? "•"} ${String(props["text"])}` });
      return;
    case "Code":
      out.push({
        type: "pre",
        text: String(props["text"]),
        ...(typeof props["language"] === "string" ? { language: props["language"] } : {}),
      });
      return;
    case "Quote":
      if (props["expandable"] === true) {
        out.push({ type: "expandable_blockquote", text: String(props["text"]) });
      } else {
        out.push({ type: "blockquote", blocks: [{ type: "paragraph", text: String(props["text"]) }] });
      }
      return;
    case "Alert": {
      const emoji = STATUS_EMOJI[String(props["level"])] ?? "•";
      const title = typeof props["title"] === "string" ? [{ type: "bold" as const, text: props["title"] }, " — " as string] : [];
      out.push({ type: "paragraph", text: [emoji, ...title, String(props["text"])] });
      return;
    }
    case "Table": {
      const columns = props["columns"] as string[] | undefined;
      const rows = (props["rows"] as string[][]) ?? [];
      const cells: RichTableCellJson[][] = [];
      if (columns) {
        cells.push(columns.map((label) => ({ text: label, is_header: true, align: "left", valign: "top" })));
      }
      for (const row of rows) {
        cells.push(row.map((text) => ({ text, align: "left", valign: "top" })));
      }
      out.push({ type: "table", cells, is_bordered: true, ...(props["compact"] === true ? { is_compact: true } : {}) });
      return;
    }
    case "Note":
      out.push({ type: "footer", text: String(props["text"]) });
      return;
    case "ButtonRow":
      return; // handled by inspectRichMessage (keyboard order)
    case "Button":
      return; // never rendered in the block flow
  }
}

/** Count blocks the way Telegram's limit describes: list items and table rows included. */
function budgetOf(blocks: RichBlockJson[]): { blocks: number; textChars: number } {
  let count = 0;
  let textChars = 0;
  const textOf = (value: RichText | RichTextEntity): void => {
    if (typeof value === "string") {
      textChars += value.length;
    } else if (Array.isArray(value)) {
      for (const part of value) textOf(part);
    } else {
      textOf(value.text);
    }
  };
  const walk = (list: RichBlockJson[]): void => {
    for (const block of list) {
      count += 1;
      switch (block.type) {
        case "paragraph":
        case "heading":
        case "footer":
        case "expandable_blockquote":
        case "pre":
          textOf(block.text);
          break;
        case "list":
          for (const item of block.items) {
            count += 1; // list items count toward the block budget
            walk(item.blocks);
          }
          break;
        case "table":
          for (const row of block.cells) {
            count += 1; // table rows count toward the block budget
            for (const cell of row) if (cell.text !== undefined) textOf(cell.text);
          }
          break;
        case "blockquote":
          walk(block.blocks);
          break;
        case "buttons":
          for (const button of block.buttons) textOf(button.text);
          break;
        case "divider":
          break;
      }
    }
  };
  walk(blocks);
  return { blocks: count, textChars };
}
