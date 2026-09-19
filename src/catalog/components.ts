import type { ComponentType } from "../spec/schema.js";

/**
 * The internal Telegram UI catalog — fixed for v0.1. Consumers never register
 * components; they consume the generated spec.
 *
 * `description` is what the JEV evaluator sees when components are named in
 * questions (capabilities state, edit-mode summaries). It describes the
 * *Telegram rendering convention*, not abstract UI concepts.
 */

export type ElementKind = "root" | "container" | "leaf" | "row" | "button";

export interface ComponentDef {
  type: ComponentType;
  kind: ElementKind;
  /** Human-facing description of what this component looks like in Telegram. */
  description: string;
  /** Content blocks this component may hold in `children` (root/container/row only). */
  childTypes?: readonly ComponentType[];
  /** May hold `keyboard` rows (root only). */
  keyboard?: boolean;
}

/** Content blocks that may appear as direct children of a Message. */
export const MESSAGE_CHILD_TYPES = [
  "Heading",
  "Text",
  "Section",
  "Divider",
  "Field",
  "List",
  "Status",
  "Code",
  "Quote",
  "Alert",
  "Table",
  "Note",
] as const;

/** Content lines allowed inside a Section (no nested sections or headings — Telegram has no nesting). */
export const SECTION_CHILD_TYPES = [
  "Text",
  "Field",
  "List",
  "Status",
  "Quote",
  "Code",
  "Alert",
  "Table",
  "Note",
  "Divider",
] as const;

export const CATALOG: Record<ComponentType, ComponentDef> = {
  Message: {
    type: "Message",
    kind: "root",
    description: "The whole Telegram message (root): a text body plus one inline keyboard",
    childTypes: MESSAGE_CHILD_TYPES,
    keyboard: true,
  },
  Heading: {
    type: "Heading",
    kind: "leaf",
    description: "A bold title line, usually at the top of the message",
  },
  Text: {
    type: "Text",
    kind: "leaf",
    description: "A plain text paragraph",
  },
  Section: {
    type: "Section",
    kind: "container",
    description: "A titled group of related lines (e.g. one block per item), separated by blank lines",
    childTypes: SECTION_CHILD_TYPES,
  },
  Divider: {
    type: "Divider",
    kind: "leaf",
    description: "A horizontal rule line separating sections",
  },
  Field: {
    type: "Field",
    kind: "leaf",
    description: "A single 'Label: value' line",
  },
  List: {
    type: "List",
    kind: "leaf",
    description: "A compact bulleted (or numbered) list of short lines",
  },
  Status: {
    type: "Status",
    kind: "leaf",
    description: "An emoji status line: ✅ success, ℹ️ info, ⚠️ warning, ❌ error",
  },
  Code: {
    type: "Code",
    kind: "leaf",
    description: "A monospace preformatted code block",
  },
  Quote: {
    type: "Quote",
    kind: "leaf",
    description: "A quoted text block (optionally expandable/collapsible)",
  },
  Alert: {
    type: "Alert",
    kind: "leaf",
    description: "A prominent notice line: ❌ error, ⚠️ warning, ✅ success, ℹ️ info",
  },
  Table: {
    type: "Table",
    kind: "leaf",
    description: "A grid of aligned rows and columns for uniform records (optionally with a header row)",
  },
  Note: {
    type: "Note",
    kind: "leaf",
    description: "A small italic hint line at the bottom (footnote, usage tip, empty-state remark)",
  },
  ButtonRow: {
    type: "ButtonRow",
    kind: "row",
    description: "One row of inline keyboard buttons",
    childTypes: ["Button"],
  },
  Button: {
    type: "Button",
    kind: "button",
    description: "A tappable keyboard button: either an action callback or a URL link",
  },
};

export const CONTENT_LEAF_TYPES = ["Heading", "Text", "Field", "List", "Status", "Code", "Quote", "Alert", "Table", "Note", "Divider"] as const;

/** Structural families used to constrain edit-mode replacements. */
export function replacementFamily(type: ComponentType): string {
  if (type === "Button") return "button";
  if (type === "Section") return "section";
  if (type === "ButtonRow") return "row";
  return "content";
}
