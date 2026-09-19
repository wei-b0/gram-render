import type { ComponentType } from "../spec/schema.js";
import { clip, extractQuoted, formatValue, humanizeKey, slugify } from "./harvest.js";
import { displayValue, looksLikeCode, looksLikeUrl, recognizeStatus, type StatusInfo } from "./recognize.js";

/**
 * Candidate derivation — the core adaptation versus json-render.
 *
 * json-render's candidates are authored by the consuming app. Here the catalog
 * is fixed and tiny, so candidates are **derived internally** from
 * `prompt + context`: every display string is caller data, a quoted prompt
 * string, a key-name-derived label, or a catalog-standard label. JEV then only
 * ever *chooses* among these pre-built units — it never writes text.
 *
 * Derivation yields two artifacts consumed by the composer:
 * - `candidates` — atomic instantiable units (with pre-baked children for
 *   Sections). Props are literal; JEV cannot modify them.
 * - `questions` — grouped selection decisions (one JEV choice question per
 *   group; all groups are batched into a single evaluation call):
 *   - `variants`: mutually exclusive representations of one piece of data
 *     (heading variants, section-vs-flat-fields, status-vs-field line,
 *     one-representation-per-array). The composer appends an `omit` option.
 *   - `include`: a single optional candidate (buttons). The composer appends
 *     an `omit` option.
 */

export interface CandidateElement {
  type: ComponentType;
  props: Record<string, unknown>;
  /** Pre-baked children (Sections carry their Field/Status lines). */
  children?: CandidateElement[];
}

export interface Candidate {
  id: string;
  /** The ONLY thing JEV sees besides the id — carries the concrete data. */
  description: string;
  element: CandidateElement;
  /** Question key this candidate is offered under. */
  resource?: string;
}

export interface DerivedOption {
  /** Criteria key inside the question. */
  id: string;
  description: string;
  /** Candidates instantiated when this option is chosen. */
  candidateIds: string[];
}

export interface DerivedQuestion {
  /** Stable question name used as the JEV question id. */
  key: string;
  instructions: string;
  options: DerivedOption[];
}

export interface DeriveResult {
  candidates: Candidate[];
  questions: DerivedQuestion[];
  warnings: string[];
}

export interface DeriveOptions {
  /** Maximum candidates derived. Default 40. */
  maxCandidates?: number;
  /** Maximum array items expanded. Default 8. */
  maxItemsPerArray?: number;
}

const DEFAULTS = { maxCandidates: 40, maxItemsPerArray: 8 };

const PRIMARY_KEYS = ["name", "title", "id", "key", "label", "username", "email", "slug"];
/** Scalar context keys whose value is likely a footnote/hint. */
const NOTE_KEYS = new Set(["hint", "note", "footer", "tip", "caption"]);
/** Scalar context keys whose numeric value is likely a per-item count. */
const QUANTITY_KEYS = ["quantity", "qty", "count"];
/** Scalar context keys whose value is likely a per-item price or cost. */
const PRICE_KEYS = ["price", "cost", "unit_price"];
/** Max characters per derived table cell. */
const TABLE_CELL_MAX = 48;
const STANDARD_BUTTONS: Array<{ label: string; action: string }> = [
  { label: "Refresh", action: "refresh" },
  { label: "Contact support", action: "contact_support" },
];

export function deriveCandidates(
  prompt: string,
  context: Record<string, unknown> | undefined,
  options: DeriveOptions = {},
): DeriveResult {
  const caps = { ...DEFAULTS, ...options };
  const warnings: string[] = [];
  const candidates: Candidate[] = [];
  const questions: DerivedQuestion[] = [];
  const usedIds = new Set<string>();
  let capWarned = false;
  const warnCapReached = (): void => {
    if (capWarned) return;
    capWarned = true;
    warnings.push(`Candidate cap (${caps.maxCandidates}) reached — some content was not derived.`);
  };

  const addCandidate = (candidate: Omit<Candidate, "id"> & { id: string }): string | undefined => {
    let id = candidate.id;
    let n = 2;
    while (usedIds.has(id)) id = `${candidate.id}_${n++}`;
    if (candidates.length >= caps.maxCandidates) {
      warnCapReached();
      return undefined;
    }
    usedIds.add(id);
    candidates.push({ ...candidate, id });
    return id;
  };

  const addQuestion = (question: DerivedQuestion): void => {
    if (questions.length >= caps.maxCandidates) {
      warnCapReached();
      return;
    }
    questions.push(question);
  };

  // ---------------------------------------------------------------- headings
  // Quoted strings in the prompt are the strongest heading signals (verified in
  // experiments: quoted headings chosen at confidence 1.00).
  const headingOptions: DerivedOption[] = [];
  for (const quote of extractQuoted(prompt)) {
    const id = addCandidate({
      id: `h_${slugify(quote, 20)}`,
      description: `Heading '${clip(quote, 48)}' (bold title line)`,
      element: { type: "Heading", props: { text: quote } },
      resource: "heading",
    });
    if (id) {
      headingOptions.push({ id, description: `Use the heading '${clip(quote, 48)}'`, candidateIds: [id] });
    }
  }
  // Key-derived heading fallbacks (only when the context has content keys).
  if (context) {
    for (const key of Object.keys(context)) {
      if (key === "actions") continue;
      const id = addCandidate({
        id: `h_${slugify(key, 20)}`,
        description: `Heading '${humanizeKey(key)}' (bold title line)`,
        element: { type: "Heading", props: { text: humanizeKey(key) } },
        resource: "heading",
      });
      if (id) {
        headingOptions.push({ id, description: `Use the heading '${humanizeKey(key)}'`, candidateIds: [id] });
      }
    }
  }
  if (headingOptions.length > 0) {
    addQuestion({
      key: "heading",
      instructions: "Pick the heading for this Telegram message. Choose omit if no heading is needed.",
      options: headingOptions,
    });
  }

  // ------------------------------------------------------------ context walk
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      if (key === "actions") continue; // handled below
      walkValue(key, value, "");
    }
  }

  // ----------------------------------------------------------------- buttons
  // Caller-declared actions first: [{ label, action, payload?, url?, style? }]
  const knownActions = new Set<string>();
  const actions = context?.["actions"];
  if (Array.isArray(actions)) {
    for (const entry of actions) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const label = typeof record["label"] === "string" ? record["label"] : undefined;
      if (!label) continue;
      const url = typeof record["url"] === "string" ? record["url"] : undefined;
      const action = typeof record["action"] === "string" ? record["action"] : undefined;
      const style = typeof record["style"] === "string" ? record["style"] : undefined;
      const payload = record["payload"] && typeof record["payload"] === "object" ? (record["payload"] as Record<string, unknown>) : undefined;
      if (!url && !action) continue;
      if (action) knownActions.add(action.toLowerCase());
      const props: Record<string, unknown> = { label };
      if (url) props["url"] = url;
      if (action) {
        props["action"] = action;
        if (payload) props["payload"] = payload;
      }
      if (style === "primary" || style === "success" || style === "danger") props["style"] = style;
      const id = addCandidate({
        id: `btn_${slugify(label, 20)}`,
        description: `Button '${clip(label, 32)}' (${url ? `opens link` : `action ${action}`})`,
        element: { type: "Button", props },
        resource: `btn_${slugify(label, 20)}`,
      });
      if (id) {
        addQuestion({
          key: `btn_${slugify(label, 20)}`,
          instructions: "Include this button in the inline keyboard?",
          options: [{ id: `use_${id}`, description: `Include button '${clip(label, 32)}'`, candidateIds: [id] }],
        });
      }
    }
  }
  // Short quoted strings also make sensible button labels (deduped against
  // context actions and standard buttons by slug).
  for (const quote of extractQuoted(prompt)) {
    const words = quote.split(/\s+/);
    // Label-length heuristic — but never reject a URL for being long.
    if ((quote.length > 20 && !looksLikeUrl(quote)) || words.length > 3) continue;
    const slug = slugify(quote, 24);
    if (knownActions.has(slug)) continue;
    knownActions.add(slug);
    // A quoted URL becomes a link button, not a callback action.
    const isUrl = looksLikeUrl(quote);
    const id = addCandidate({
      id: `btn_${slug}`,
      description: `Button '${clip(quote, 32)}' (${isUrl ? "opens link" : `action ${slug}`})`,
      element: {
        type: "Button",
        props: isUrl ? { label: quote.slice(0, 64), url: quote } : { label: quote, action: slug },
      },
      resource: `btn_${slug}`,
    });
    if (id) {
      addQuestion({
        key: `btn_${slug}`,
        instructions: "Include this button in the inline keyboard?",
        options: [{ id: `use_${id}`, description: `Include button '${clip(quote, 32)}'`, candidateIds: [id] }],
      });
    }
  }
  // Standard low-priority buttons — JEV omits them when irrelevant.
  for (const standard of STANDARD_BUTTONS) {
    if (knownActions.has(standard.action)) continue;
    const id = addCandidate({
      id: `btn_${standard.action}`,
      description: `Button '${standard.label}' (action ${standard.action})`,
      element: { type: "Button", props: { label: standard.label, action: standard.action } },
      resource: `btn_${standard.action}`,
    });
    if (id) {
      addQuestion({
        key: `btn_${standard.action}`,
        instructions: "Include this button in the inline keyboard?",
        options: [{ id: `use_${id}`, description: `Include button '${standard.label}'`, candidateIds: [id] }],
      });
    }
  }

  return { candidates, questions, warnings };

  // ------------------------------------------------------------------ helpers

  function walkValue(key: string, value: unknown, parentPath: string): void {
    const path = parentPath ? `${parentPath}.${key}` : key;
    const human = humanizeKey(key);

    // --- scalar (or scalar-shaped special cases)
    const formatted = displayValue(key, value);
    if (formatted !== undefined && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      addScalarLine(path, human, key, formatted);
      return;
    }

    // --- array
    if (Array.isArray(value)) {
      addArray(path, human, key, value);
      return;
    }

    // --- object
    if (value && typeof value === "object") {
      addObject(path, human, key, value as Record<string, unknown>);
    }
  }

  function addScalarLine(path: string, human: string, key: string, value: string): void {
    const options: DerivedOption[] = [];

    // URL → tappable link button vs plain field line
    if (looksLikeUrl(value)) {
      const buttonId = addCandidate({
        id: `lnk_${slugify(key, 20)}`,
        description: `Link button '${human}' (opens ${clip(value, 40)})`,
        element: { type: "Button", props: { label: human, url: value } },
        resource: `line_${path}`,
      });
      const fieldId = addCandidate({
        id: `f_${slugify(key, 20)}`,
        description: `Line '${clip(`${human}: ${value}`, 80)}'`,
        element: { type: "Field", props: { label: human, value } },
        resource: `line_${path}`,
      });
      if (buttonId && fieldId) {
        options.push(
          { id: buttonId, description: `Show as a link button '${human}'`, candidateIds: [buttonId] },
          { id: fieldId, description: `Show as a plain line '${clip(`${human}: ${value}`, 60)}'`, candidateIds: [fieldId] },
        );
      }
      addQuestion({ key: `line_${path}`, instructions: `How should '${human}' be shown?`, options });
      return;
    }

    // Code-shaped values render as monospace blocks
    if (looksLikeCode(key, value)) {
      const codeId = addCandidate({
        id: `code_${slugify(key, 20)}`,
        description: `Monospace block with ${value.split("\n").length} line(s) of ${human.toLowerCase()}`,
        element: { type: "Code", props: { text: value.slice(0, 3000) } },
        resource: `line_${path}`,
      });
      if (codeId) options.push({ id: codeId, description: `Show as a monospace ${human.toLowerCase()} block`, candidateIds: [codeId] });
      addQuestion({ key: `line_${path}`, instructions: `Include the ${human.toLowerCase()} block?`, options });
      return;
    }

    const status = recognizeStatus(key, value);
    const fieldId = addCandidate({
      id: `f_${slugify(key, 20)}`,
      description: `Line '${clip(`${human}: ${value}`, 80)}'`,
      element: { type: "Field", props: { label: human, value } },
      resource: `line_${path}`,
    });
    if (fieldId) options.push({ id: fieldId, description: `Show as a line '${clip(`${human}: ${value}`, 60)}'`, candidateIds: [fieldId] });
    if (status) {
      const statusId = addCandidate({
        id: `st_${slugify(key, 20)}`,
        description: `Status line '${status.level}: ${clip(status.label, 32)}' (emoji + label)`,
        element: { type: "Status", props: { level: status.level, text: `${human}: ${value}` } },
        resource: `line_${path}`,
      });
      if (statusId) {
        options.unshift({ id: statusId, description: `Show as an emoji status line (${status.level})`, candidateIds: [statusId] });
      }
    }
    if (NOTE_KEYS.has(key.toLowerCase()) && typeof value === "string" && value.length <= 256) {
      const noteId = addCandidate({
        id: `note_${slugify(key, 20)}`,
        description: `Hint line '${clip(value, 48)}' (small italic text, e.g. at the bottom)`,
        element: { type: "Note", props: { text: value } },
        resource: `line_${path}`,
      });
      if (noteId) options.push({ id: noteId, description: `Show as a small italic hint line`, candidateIds: [noteId] });
    }
    addQuestion({ key: `line_${path}`, instructions: `Should the '${human}' line be included, and how?`, options });
  }

  function addArray(path: string, human: string, key: string, value: unknown[]): void {
    if (value.length === 0) return;
    const options: DerivedOption[] = [];

    // Compact list option — one bulleted line per item.
    const listLines = value
      .slice(0, caps.maxItemsPerArray)
      .map((item) => summarizeItem(item))
      .filter((line): line is string => line !== undefined);
    if (value.length > caps.maxItemsPerArray) {
      listLines.push(`+${value.length - caps.maxItemsPerArray} more`);
      warnings.push(`'${key}': ${value.length} items, showing first ${caps.maxItemsPerArray}.`);
    }
    const listId = addCandidate({
      id: `list_${slugify(key, 20)}`,
      description: `Bulleted list, ${listLines.length} line(s): ${listLines.map((l) => `'${clip(l, 24)}'`).join(", ")}`.slice(0, 120),
      element: { type: "List", props: { items: listLines } },
      resource: `items_${path}`,
    });
    if (listId) {
      options.push({ id: listId, description: `One compact bulleted list of all ${human.toLowerCase()} (${listLines.length} lines)`, candidateIds: [listId] });
    }

    // Per-item section option — one titled section per item (cap-bounded).
    if (value.length <= caps.maxItemsPerArray && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
      const sectionIds: string[] = [];
      for (const [index, item] of value.entries()) {
        const record = item as Record<string, unknown>;
        const primary = primaryOf(record);
        const children = buildItemChildren(record);
        if (children.length === 0 && !primary) continue;
        const title = primary ?? humanizeKey(`${key}_${index + 1}`);
        const fieldSummary = children
          .map((child) => describeChild(child))
          .filter(Boolean)
          .join(", ");
        const sectionId = addCandidate({
          id: `sec_${slugify(key, 16)}_${index + 1}`,
          description: `Section '${clip(title, 32)}' with ${children.length} line(s): ${clip(fieldSummary, 80)}`.slice(0, 120),
          element: { type: "Section", props: { title }, children },
          resource: `items_${path}`,
        });
        if (sectionId) sectionIds.push(sectionId);
      }
      if (sectionIds.length > 0) {
        options.unshift({
          id: "sections",
          description: `One titled section per ${singularize(key)} (${sectionIds.length} sections, one line each)`,
          candidateIds: sectionIds,
        });
      }
    }

    // Table option — uniform records with a shared scalar key set (2..8 columns).
    const table = buildTable(key, human, path, value);
    if (table) {
      options.push({
        id: table.candidateId,
        description: `One table of all ${human.toLowerCase()} (${table.rows} rows × ${table.columns} columns)`,
        candidateIds: [table.candidateId],
      });
    }

    if (options.length > 0) {
      addQuestion({
        key: `items_${path}`,
        instructions: `How should the ${human.toLowerCase()} be shown? Choose omit to leave them out.`,
        options,
      });
    }
  }

  function addObject(path: string, human: string, key: string, value: Record<string, unknown>): void {
    const sectionChildren = buildItemChildren(value);
    const options: DerivedOption[] = [];

    if (sectionChildren.length > 0) {
      const sectionId = addCandidate({
        id: `sec_${slugify(key, 20)}`,
        description: `Section '${clip(human, 32)}' with ${sectionChildren.length} line(s): ${clip(
          sectionChildren.map((child) => describeChild(child)).filter(Boolean).join(", "),
          80,
        )}`.slice(0, 120),
        element: { type: "Section", props: { title: human }, children: sectionChildren },
        resource: `body_${path}`,
      });
      const flatIds: string[] = [];
      for (const child of sectionChildren) {
        const flatId = addCandidate({
          id: `f_${slugify(`${path}_${String(child.props["label"] ?? child.props["text"] ?? "x")}`, 20)}`,
          description: `Line '${clip(describeChild(child), 80)}'`,
          element: { type: child.type, props: child.props },
          resource: `body_${path}`,
        });
        if (flatId) flatIds.push(flatId);
      }
      if (sectionId) {
        options.push({ id: sectionId, description: `A titled '${human}' section grouping its lines`, candidateIds: [sectionId] });
      }
      if (flatIds.length > 0) {
        options.push({ id: "flat", description: `Loose lines without a section title (${flatIds.length} lines)`, candidateIds: flatIds });
      }
      addQuestion({ key: `body_${path}`, instructions: `How should '${human}' be shown? Choose omit to leave it out.`, options });
    }

    // Nested URLs become offerable as tappable link buttons (include question);
    // the section/flat representations keep the plain-line rendering either way.
    for (const [childKey, childValue] of Object.entries(value)) {
      if (typeof childValue !== "string" || !looksLikeUrl(childValue)) continue;
      const childHuman = humanizeKey(childKey);
      const slug = slugify(childKey, 16);
      const id = addCandidate({
        id: `lnk_${slug}`,
        description: `Link button '${childHuman}' (opens ${clip(childValue, 40)})`,
        element: { type: "Button", props: { label: childHuman, url: childValue } },
        resource: `btn_url_${slug}`,
      });
      if (id) {
        addQuestion({
          key: `btn_url_${slug}`,
          instructions: "Include this link button in the inline keyboard?",
          options: [{ id: `use_${id}`, description: `Include link button '${clip(childHuman, 32)}'`, candidateIds: [id] }],
        });
      }
    }

    // Recurse into nested structures (e.g. order.items) — top-level richness.
    for (const [childKey, childValue] of Object.entries(value)) {
      if (Array.isArray(childValue) || (childValue !== null && typeof childValue === "object")) {
        walkValue(childKey, childValue, path);
      }
    }
  }

  function buildItemChildren(record: Record<string, unknown>): CandidateElement[] {
    const children: CandidateElement[] = [];
    for (const [childKey, childValue] of Object.entries(record)) {
      const formatted = displayValue(childKey, childValue);
      if (formatted === undefined) continue;
      const childHuman = humanizeKey(childKey);
      const status = recognizeStatus(childKey, formatted);
      if (status) {
        children.push({ type: "Status", props: { level: status.level, text: `${childHuman}: ${formatted}` } });
      } else {
        children.push({ type: "Field", props: { label: childHuman, value: formatted.slice(0, 512) } });
      }
    }
    return children.slice(0, 8);
  }

  function summarizeItem(item: unknown): string | undefined {
    if (item === null || typeof item !== "object") return formatValue(item);
    const record = item as Record<string, unknown>;
    const primary = primaryOf(record);
    if (!primary) return undefined;
    const statusEntry = Object.entries(record).find(([k, v]) => {
      const formatted = formatValue(v);
      return formatted !== undefined && recognizeStatus(k, formatted) !== undefined;
    });
    if (statusEntry) {
      const status = recognizeStatus(statusEntry[0], formatValue(statusEntry[1])!)!;
      return `${primary} — ${status.label}`;
    }
    // Compact lines carry the item's count and price when the record has
    // them — a name-only list hides exactly the fields compaction exists
    // to summarize.
    let quantity = "";
    for (const key of QUANTITY_KEYS) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        quantity = ` ×${value}`;
        break;
      }
    }
    let price = "";
    for (const key of PRICE_KEYS) {
      const formatted = formatValue(record[key]);
      if (formatted !== undefined) {
        price = ` — ${formatted}`;
        break;
      }
    }
    return `${primary}${quantity}${price}`;
  }

  /**
   * Build the uniform-records table option for an array: every item a plain
   * object, a shared key set of 2–8 scalar-valued keys, ≤20 rows. Returns the
   * candidate id plus dimensions, or undefined when the data doesn't fit.
   */
  function buildTable(
    key: string,
    human: string,
    path: string,
    value: unknown[],
  ): { candidateId: string; rows: number; columns: number } | undefined {
    if (value.length === 0 || value.length > 20 || !value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
      return undefined;
    }
    const records = value as Array<Record<string, unknown>>;
    const firstKeys = Object.keys(records[0]!).filter((k) => k !== "actions");
    const sharedKeys = firstKeys.filter((k) =>
      records.every((record) => k in record && displayValue(k, record[k]) !== undefined),
    );
    if (sharedKeys.length < 2 || sharedKeys.length > 8) return undefined;

    const columns = sharedKeys.map((k) => humanizeKey(k));
    const rows: string[][] = [];
    for (const record of records) {
      const cells: string[] = [];
      for (const k of sharedKeys) {
        const cell = displayValue(k, record[k]);
        if (cell === undefined) return undefined; // non-scalar slipped in — not tabular
        cells.push(clip(cell, TABLE_CELL_MAX));
      }
      rows.push(cells);
    }
    const candidateId = addCandidate({
      id: `tbl_${slugify(key, 20)}`,
      description: `Table, ${rows.length} rows × ${columns.length} columns: ${columns.join(", ")}`.slice(0, 120),
      element: { type: "Table", props: { columns, rows } },
      resource: `items_${path}`,
    });
    return candidateId ? { candidateId, rows: rows.length, columns: columns.length } : undefined;
  }

  function primaryOf(record: Record<string, unknown>): string | undefined {
    for (const key of PRIMARY_KEYS) {
      const value = record[key];
      const formatted = formatValue(value);
      if (formatted !== undefined) return formatted;
    }
    for (const value of Object.values(record)) {
      const formatted = formatValue(value);
      if (formatted !== undefined && typeof value === "string") return formatted;
    }
    return undefined;
  }

  function describeChild(child: CandidateElement): string {
    const props = child.props;
    if (child.type === "Field") return `${props["label"]}: ${clip(String(props["value"]), 24)}`;
    if (child.type === "Status") return `${props["level"]} ${clip(String(props["text"]), 32)}`;
    return "";
  }

  function singularize(key: string): string {
    if (key.endsWith("ies")) return `${key.slice(0, -3)}y`;
    if (/(?:ses|xes|zes|ches|shes)$/.test(key)) return key.slice(0, -2);
    if (key.endsWith("s")) return key.slice(0, -1);
    return key;
  }
}
