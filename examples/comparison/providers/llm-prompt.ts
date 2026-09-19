/**
 * Prompts for the LLM side of the comparison. The system prompt carries only
 * the GramSpec contract plus the same 15 catalog descriptions the JEV
 * evaluator sees (src/catalog/components.ts) — both sides get identical
 * component semantics. The user message is the shared prompt plus the context
 * JSON, byte-identical to what JEV's state carries.
 */

import { CATALOG } from "../../../src/index.js";
import type { ComparisonFixture } from "../fixture.js";

export function buildSystemPrompt(): string {
  const catalogLines = Object.values(CATALOG).map((def) => `- ${def.type}: ${def.description}`);
  return [
    "You generate a GramSpec: a declarative JSON description of a Telegram bot message UI.",
    "",
    "Output contract:",
    '- A single JSON object: { "version": 1, "root": "<element id>", "elements": [ element, ... ] }.',
    '- "elements" is a flat array. Every element is { "id": "<unique id>", "type": ..., "props": { ... } } — the id travels INSIDE the element, and "root" references that id.',
    '- Exactly one element has type "Message"; it is the root. A Message has "children" (ordered ids of top-level blocks) and "keyboard" (ordered ids of ButtonRow elements).',
    '- "Section" and "ButtonRow" also carry "children" (ids). All other types are leaves — never give them children or keyboard.',
    "- Message children may be: Heading, Text, Section, Divider, Field, List, Status, Code, Quote, Alert, Table, Note.",
    "- Section children may be: Text, Field, List, Status, Quote, Code, Alert, Table, Note, Divider — no nested Sections, no Headings.",
    "- Keyboard rows are ButtonRow elements; each ButtonRow's children are Button elements.",
    "- A Button's props must set exactly one of \"action\" (a short identifier) or \"url\" — unless \"disabled\": true, which requires neither.",
    '- A Button\'s optional "payload" is an array of { "key": string, "value": string|number|boolean|null|scalar-array } pairs, e.g. { "orderId": 1842 } becomes [ { "key": "orderId", "value": 1842 } ].',
    "",
    "Component catalog (the same component semantics the JEV decision model sees):",
    ...catalogLines,
    "",
    "Data rule: every string you output must come from the user's request or the provided context data. Never invent or embellish values.",
    'Suggested id convention: "m1" for the root Message, "n1", "n2", ... for content elements, "r1", "r2", ... for keyboard rows.',
  ].join("\n");
}

export function buildUserMessage(fixture: ComparisonFixture): string {
  return `${fixture.prompt}\n\nContext data:\n${JSON.stringify(fixture.context, null, 2)}`;
}
