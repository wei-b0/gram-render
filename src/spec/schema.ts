import { z } from "zod";

/**
 * GramSpec — the Telegram UI specification produced by gram-render.
 *
 * A flat tree (`root` + `elements`), like json-render's spec, but with
 * Telegram-typed attachments instead of generic slots:
 *
 * - `Message.children`     → ordered content blocks (the message text body)
 * - `Message.keyboard`     → ordered `ButtonRow` ids (the one InlineKeyboardMarkup)
 * - `Section.children`     → ordered content lines inside the section
 * - `ButtonRow.children`   → ordered `Button` ids
 *
 * The spec is plain JSON with no JEV implementation details. Confidence and
 * probabilities live on composition events, never in the spec.
 */

export const COMPONENT_TYPES = [
  "Message",
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
  "ButtonRow",
  "Button",
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const StatusLevel = z.enum(["success", "info", "warning", "error"]);
export type StatusLevel = z.infer<typeof StatusLevel>;

export const ButtonStyle = z.enum(["primary", "success", "danger"]);
export type ButtonStyle = z.infer<typeof ButtonStyle>;

/** An action identifier: short, callback-safe slug. Executed by the consumer, never by gram-render. */
export const ActionId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.:-]*$/i, "action must be a short identifier (letters, digits, _ . : -)");

/** Values that survive JSON round-tripping — what a payload may contain. */
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

export const MessageProps = z
  .object({ preview: z.literal("disabled").optional() })
  .strict();
export const HeadingProps = z.object({ text: z.string().min(1).max(256) }).strict();
export const TextProps = z.object({ text: z.string().min(1).max(2048) }).strict();
export const SectionProps = z.object({ title: z.string().min(1).max(256) }).strict();
export const FieldProps = z
  .object({
    label: z.string().min(1).max(128),
    value: z.string().min(1).max(512),
    /** Render the value in monospace (ids, paths, code-like values). */
    mono: z.boolean().optional(),
  })
  .strict();
export const ListProps = z
  .object({
    items: z.array(z.string().min(1).max(256)).min(1).max(24),
    ordered: z.boolean().optional(),
  })
  .strict();
export const StatusProps = z.object({ level: StatusLevel, text: z.string().min(1).max(256) }).strict();
export const CodeProps = z
  .object({ text: z.string().min(1).max(3072), language: z.string().max(32).optional() })
  .strict();
export const QuoteProps = z
  .object({ text: z.string().min(1).max(1024), expandable: z.boolean().optional() })
  .strict();
export const AlertProps = z
  .object({
    level: StatusLevel,
    title: z.string().max(128).optional(),
    text: z.string().min(1).max(512),
  })
  .strict();
export const TableProps = z
  .object({
    /** Header labels; when present, fixes the grid width and renders a header row. */
    columns: z.array(z.string().min(1).max(64)).min(1).max(8).optional(),
    /** Rectangular cell grid, row-major. */
    rows: z.array(z.array(z.string().min(1).max(256)).min(1).max(8)).min(1).max(20),
    /** Compact spacing (used by the Rich Messages target). */
    compact: z.boolean().optional(),
  })
  .strict()
  .refine(
    (table) => {
      const width = table.rows[0]?.length ?? 0;
      if (!table.rows.every((row) => row.length === width)) return false;
      return !table.columns || table.columns.length === width;
    },
    { message: "Table rows must be rectangular and match the `columns` length" },
  );
export const NoteProps = z.object({ text: z.string().min(1).max(256) }).strict();

export const ButtonProps = z
  .object({
    label: z.string().min(1).max(64),
    /** Callback action identifier. Executed by the consumer. */
    action: ActionId.optional(),
    /** Arbitrary JSON payload carried alongside the action. */
    payload: z.record(z.string(), jsonValue).optional(),
    /** Link target — mutually exclusive with `action` (unless disabled). */
    url: z.string().min(1).max(2048).optional(),
    style: ButtonStyle.optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (props) => {
      const targets = [props.action, props.url].filter(Boolean).length;
      if (props.disabled) return targets === 0;
      return targets === 1;
    },
    { message: "Button needs exactly one of `action` or `url` (neither when `disabled`)" },
  );

const elementBase = { props: z.unknown() };

/**
 * One element of the flat tree. Which attachment keys are legal is decided by
 * the component type and enforced by the tree validator:
 * - `Message` → `children` (content) + `keyboard` (ButtonRows)
 * - `Section`, `ButtonRow` → `children`
 * - everything else → leaf (no children, no keyboard)
 */
export const GramElementSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("Message"),
      props: MessageProps.default({}),
      children: z.array(z.string()).default([]),
      keyboard: z.array(z.string()).default([]),
    })
    .strict(),
  z.object({ type: z.literal("Section"), ...elementBase, props: SectionProps, children: z.array(z.string()).default([]) }).strict(),
  z.object({ type: z.literal("ButtonRow"), ...elementBase, props: z.object({}).strict().default({}), children: z.array(z.string()).default([]) }).strict(),
  z.object({ type: z.literal("Heading"), ...elementBase, props: HeadingProps }).strict(),
  z.object({ type: z.literal("Text"), ...elementBase, props: TextProps }).strict(),
  z.object({ type: z.literal("Divider"), ...elementBase, props: z.object({}).strict().default({}) }).strict(),
  z.object({ type: z.literal("Field"), ...elementBase, props: FieldProps }).strict(),
  z.object({ type: z.literal("List"), ...elementBase, props: ListProps }).strict(),
  z.object({ type: z.literal("Status"), ...elementBase, props: StatusProps }).strict(),
  z.object({ type: z.literal("Code"), ...elementBase, props: CodeProps }).strict(),
  z.object({ type: z.literal("Quote"), ...elementBase, props: QuoteProps }).strict(),
  z.object({ type: z.literal("Alert"), ...elementBase, props: AlertProps }).strict(),
  z.object({ type: z.literal("Table"), ...elementBase, props: TableProps }).strict(),
  z.object({ type: z.literal("Note"), ...elementBase, props: NoteProps }).strict(),
  z.object({ type: z.literal("Button"), ...elementBase, props: ButtonProps }).strict(),
]);

export const GramSpecSchema = z.object({
  version: z.literal(1).default(1),
  root: z.string().min(1),
  elements: z.record(z.string(), GramElementSchema),
});

export type GramElement = z.infer<typeof GramElementSchema>;
export type GramSpec = z.infer<typeof GramSpecSchema>;
export type MessageElement = Extract<GramElement, { type: "Message" }>;
export type ButtonElement = Extract<GramElement, { type: "Button" }>;

/** Parse + validate a plain object as a GramSpec. Throws a ZodError on failure. */
export function parseGramSpec(value: unknown): GramSpec {
  return GramSpecSchema.parse(value);
}
