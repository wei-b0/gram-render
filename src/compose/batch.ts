import { describeElement } from "../catalog/describe.js";
import { deriveCandidates, type DeriveResult } from "../derive/candidates.js";
import type { Evaluator } from "../evaluate/types.js";
import { CompositionError } from "../errors.js";
import type { ButtonElement, GramElement, GramSpec } from "../spec/schema.js";
import { callEvaluator, minConfidenceOf, type UsageTracker } from "./call.js";
import type { CompositionEvent, ComposeOptions, CompositionStep, Guidance } from "./options.js";
import { instantiateElement, nextElementId, validateTree, type Limits } from "./tree.js";

/**
 * Batched new-tree composition — the gram-render equivalent of json-render's
 * `composeBatch`, simplified for a fixed single-root catalog:
 *
 * 1. **Select** (one evaluator call): a `fulfillable` gate question plus one
 *    question per derived group (variants of a piece of data, or per-button
 *    includes). JEV answers all questions in parallel; assembly happens
 *    deterministically in code — JEV never authors the spec.
 * 2. **Layout** (one evaluator call, only when the shape is non-trivial):
 *    numeric `order_<id>` positions (applied as a stable sort — ties keep
 *    candidate order, which experiments showed is required), optional
 *    `parent_<id>` section membership, and `row_<buttonId>` grouping when the
 *    keyboard exceeds one comfortable row.
 */

const BUTTONS_PER_ROW = 3;

type EvaluationAnswers = Record<string, { choice: string; confidence?: number; probabilities?: Record<string, number> }>;

interface Selection {
  spec: GramSpec;
  /** Top-level content block ids in final order. */
  topBlocks: string[];
  sectionIds: string[];
  buttonIds: string[];
}

interface LayoutPlan {
  orderTargets: string[];
  parentTargets: Array<{ id: string }>;
  rowTargets: string[];
  description: string;
}

export async function* batchCompose(
  options: ComposeOptions,
  limits: Limits,
  evaluate: Evaluator,
  tracker: UsageTracker,
  warnings: string[],
  stepCounter: { value: number },
): AsyncGenerator<CompositionEvent> {
  const startedAt = Date.now();
  const steps: CompositionStep[] = [];
  const emit = (
    event: { type: "complete"; spec: GramSpec | null; stopReason: "finish" | "limit" | "unavailable"; steps: CompositionStep[] },
  ): Extract<CompositionEvent, { type: "complete" }> => ({
    ...event,
    calls: tracker.calls,
    elapsedMs: Date.now() - startedAt,
    inputTokens: tracker.inputTokens,
    warnings,
  });

  // ---------------------------------------------------------------- derive
  const derive = deriveCandidates(options.prompt, options.context, { maxCandidates: limits.maxCandidates });
  warnings.push(...derive.warnings);
  if (derive.questions.length === 0) {
    yield emit({
      type: "complete",
      spec: null,
      stopReason: "unavailable",
      steps,
    });
    return;
  }

  // ---------------------------------------------------------------- select
  const selectQuestions = buildSelectQuestions(derive, options.guidance);
  const selectState: Record<string, unknown> = {
    user_request: options.prompt,
    capabilities: derive.candidates.map((candidate) => ({ id: candidate.id, description: candidate.description })),
    guidance: guidanceList(options.guidance, "select"),
  };
  const contextJson = options.context ? JSON.stringify(options.context) : undefined;
  if (contextJson !== undefined && contextJson.length <= limits.maxContextChars) {
    selectState["context"] = options.context;
  } else if (contextJson !== undefined) {
    warnings.push("Context omitted from evaluator state (too large); candidate descriptions carry the data.");
  }

  const selectCall = await callEvaluator(
    evaluate,
    { state: selectState, questions: selectQuestions, signal: options.signal },
    tracker,
  );

  const fulfillable = selectCall.answers["fulfillable"]!;
  if (fulfillable.choice === "no") {
    yield emit({ type: "complete", spec: null, stopReason: "unavailable", steps });
    return;
  }
  const gate = options.minConfidence;
  if (gate !== undefined && (fulfillable.confidence ?? 1) < gate) {
    warnings.push(
      `Fulfillability confidence ${(fulfillable.confidence ?? 1).toFixed(2)} is below the minConfidence gate (${gate}).`,
    );
    yield emit({ type: "complete", spec: null, stopReason: "unavailable", steps });
    return;
  }

  const selection = assemble(derive, selectCall.answers, limits);
  if (!selection) {
    yield emit({ type: "complete", spec: null, stopReason: "unavailable", steps });
    return;
  }
  warnings.push(...validateTree(selection.spec, limits));

  steps.push({
    index: ++stepCounter.value,
    kind: "select",
    description: `Selected ${selection.topBlocks.length} content block(s) and ${selection.buttonIds.length} button(s).`,
    confidence: minConfidenceOf(selectCall.answers),
    answers: selectCall.answers,
    elapsedMs: selectCall.elapsedMs,
    inputTokens: selectCall.inputTokens,
  });
  yield { type: "step", spec: structuredClone(selection.spec), step: steps[steps.length - 1]! };

  // ---------------------------------------------------------------- layout
  const plan = planLayout(selection);
  if (Object.keys(plan.questions).length === 0) {
    yield emit({ type: "complete", spec: selection.spec, stopReason: "finish", steps });
    return;
  }

  const layoutState: Record<string, unknown> = {
    user_request: options.prompt,
    selected_elements: [
      ...selection.topBlocks,
      ...selection.buttonIds,
    ].flatMap((id) => {
      const element = selection.spec.elements[id];
      return element ? [{ id, type: element.type, content: describeElement(element) }] : [];
    }),
    guidance: guidanceList(options.guidance, "layout"),
  };
  const layoutCall = await callEvaluator(
    evaluate,
    { state: layoutState, questions: plan.questions, signal: options.signal },
    tracker,
  );

  applyLayout(selection, layoutCall.answers, plan);
  warnings.push(...validateTree(selection.spec, limits));

  steps.push({
    index: ++stepCounter.value,
    kind: "layout",
    description: plan.description,
    confidence: minConfidenceOf(layoutCall.answers),
    answers: layoutCall.answers,
    elapsedMs: layoutCall.elapsedMs,
    inputTokens: layoutCall.inputTokens,
  });
  yield { type: "step", spec: structuredClone(selection.spec), step: steps[steps.length - 1]! };

  yield emit({ type: "complete", spec: selection.spec, stopReason: "finish", steps });
}

// ---------------------------------------------------------------- selection

function buildSelectQuestions(
  derive: DeriveResult,
  guidance: Guidance | undefined,
): Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> {
  const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {
    fulfillable: {
      type: "choice",
      instructions: "Can the user's request be fulfilled using the supplied candidate building blocks?",
      criteria: {
        yes: "The candidates cover the request",
        no: "Something essential is missing — the request cannot be fulfilled",
      },
    },
  };
  for (const derived of derive.questions) {
    const criteria: Record<string, string> = {};
    for (const option of derived.options) {
      criteria[option.id] = option.description;
    }
    criteria["omit"] = "Leave this out";
    questions[derived.key] = {
      type: "choice",
      instructions: guidance?.select ? `${derived.instructions} ${guidance.select}` : derived.instructions,
      criteria,
    };
  }
  return questions;
}

function assemble(derive: DeriveResult, answers: EvaluationAnswers, limits: Limits): Selection | undefined {
  const spec: GramSpec = {
    version: 1,
    root: "m1",
    elements: { m1: instantiateElement("Message", {}) },
  };
  const selection: Selection = { spec, topBlocks: [], sectionIds: [], buttonIds: [] };
  let order = 0;

  const addElement = (element: GramElement): string => {
    const id = nextElementId(spec);
    spec.elements[id] = element;
    return id;
  };

  const instantiateCandidate = (candidateId: string): string => {
    const candidate = derive.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) throw new CompositionError(`Derived option references unknown candidate '${candidateId}'.`);
    const id = addElement(instantiateElement(candidate.element.type, structuredClone(candidate.element.props)));
    const element = spec.elements[id]!;
    if (candidate.element.children) {
      if (!("children" in element)) throw new CompositionError(`Candidate '${candidateId}' baked children into a leaf type.`);
      for (const child of candidate.element.children) {
        const childId = addElement(instantiateElement(child.type, structuredClone(child.props)));
        element.children.push(childId);
      }
    }
    return id;
  };

  for (const derived of derive.questions) {
    const answer = answers[derived.key];
    if (!answer || answer.choice === "omit") continue;
    const option = derived.options.find((entry) => entry.id === answer.choice);
    if (!option) throw new CompositionError(`Answer "${answer.choice}" for question "${derived.key}" matched no derived option.`);
    for (const candidateId of option.candidateIds) {
      const id = instantiateCandidate(candidateId);
      const element = spec.elements[id]!;
      if (element.type === "Button") {
        selection.buttonIds.push(id);
      } else {
        selection.topBlocks.push(id);
        if (element.type === "Section") selection.sectionIds.push(id);
      }
      order += 1;
      if (order >= limits.maxElements) break;
    }
  }

  if (selection.topBlocks.length === 0 && selection.buttonIds.length === 0) return undefined;

  const root = spec.elements[spec.root];
  if (root && root.type === "Message") root.children = [...selection.topBlocks];

  // Keyboard: one comfortable row by default; the layout phase may regroup.
  rebuildRows(selection, undefined);
  return selection;
}

/** Collision-free `r<N>` id for keyboard rows. */
function nextRowId(spec: GramSpec): string {
  let max = 0;
  for (const id of Object.keys(spec.elements)) {
    const match = /^r(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `r${max + 1}`;
}

/** Rebuild the Message keyboard from the current buttons (+ optional row assignments, 1-based). */
function rebuildRows(selection: Selection, rowAssignments: Map<string, number> | undefined): void {
  const spec = selection.spec;
  const root = spec.elements[spec.root];
  if (!root || root.type !== "Message" || selection.buttonIds.length === 0) return;

  // Drop existing rows.
  for (const rowId of root.keyboard) delete spec.elements[rowId];
  root.keyboard = [];

  const rowCount = rowAssignments ? Math.max(1, ...rowAssignments.values()) : 1;
  const rows: string[][] = Array.from({ length: rowCount }, () => []);
  for (const [index, buttonId] of selection.buttonIds.entries()) {
    const assigned = rowAssignments?.get(buttonId);
    const row = assigned ?? defaultRow(index, selection.buttonIds.length, rowCount);
    rows[Math.min(Math.max(row, 1), rowCount) - 1]!.push(buttonId);
  }
  for (const rowButtons of rows) {
    if (rowButtons.length === 0) continue;
    const rowId = nextRowId(spec);
    spec.elements[rowId] = instantiateElement("ButtonRow", {});
    for (const buttonId of rowButtons) {
      const row = spec.elements[rowId];
      if (row && row.type === "ButtonRow") row.children.push(buttonId);
    }
    root.keyboard.push(rowId);
  }
}

/** Balanced default: fill rows left-to-right when no assignment exists. */
function defaultRow(index: number, total: number, rowCount: number): number {
  if (rowCount === 1) return 1;
  const perRow = Math.ceil(total / rowCount);
  return Math.floor(index / perRow) + 1;
}

// ---------------------------------------------------------------- layout

function planLayout(selection: Selection): LayoutPlan & { questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> } {
  const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {};
  const topBlocks = selection.topBlocks;
  const sections = selection.sectionIds;
  const buttons = selection.buttonIds;

  const orderTargets = topBlocks.length >= 2 ? topBlocks : [];
  for (const blockId of orderTargets) {
    const element = selection.spec.elements[blockId]!;
    questions[`order_${blockId}`] = {
      type: "choice",
      instructions: `In what position should this block appear? (${describeElement(element)})`,
      criteria: Object.fromEntries(topBlocks.map((_, index) => [String(index + 1), `position ${index + 1}`])),
    };
  }

  // Loose blocks a Section could adopt (subset of SECTION_CHILD_TYPES; headings stay top-level).
  const adoptable = new Set<string>(["Text", "Field", "List", "Status", "Code", "Quote", "Alert", "Table", "Note", "Divider"]);
  const parentTargets: LayoutPlan["parentTargets"] = [];
  if (sections.length > 0) {
    for (const blockId of topBlocks) {
      const element = selection.spec.elements[blockId]!;
      if (!adoptable.has(element.type)) continue;
      const criteria: Record<string, string> = {
        root: "Directly in the message body, not inside a section",
      };
      for (const sectionId of sections) {
        const section = selection.spec.elements[sectionId];
        const title = section && section.type === "Section" ? String(section.props["title"]) : sectionId;
        criteria[`in_${sectionId}`] = `Inside the section '${title}'`;
      }
      questions[`parent_${blockId}`] = {
        type: "choice",
        instructions: `Where should this block live? (${describeElement(element)})`,
        criteria,
      };
      parentTargets.push({ id: blockId });
    }
  }

  // Rows: only worth a decision when the keyboard exceeds one comfortable row.
  const rowTargets = buttons.length > BUTTONS_PER_ROW ? buttons : [];
  if (rowTargets.length > 0) {
    const rowCount = Math.ceil(rowTargets.length / BUTTONS_PER_ROW);
    for (const buttonId of rowTargets) {
      const button = selection.spec.elements[buttonId] as ButtonElement | undefined;
      questions[`row_${buttonId}`] = {
        type: "choice",
        instructions: `Which keyboard row should this button be in? (${button ? describeElement(button) : buttonId})`,
        criteria: Object.fromEntries(
          Array.from({ length: rowCount }, (_, index) => [`row_${index + 1}`, `Row ${index + 1}`]),
        ),
      };
    }
  }

  return {
    questions,
    orderTargets,
    parentTargets,
    rowTargets,
    description: `Arranged ${topBlocks.length} block(s)${parentTargets.length > 0 ? `, placed ${parentTargets.length} into sections` : ""}${
      rowTargets.length > 0 ? `, grouped ${rowTargets.length} buttons into rows` : ""
    }.`,
  };
}

function applyLayout(selection: Selection, answers: EvaluationAnswers, plan: LayoutPlan): void {
  const spec = selection.spec;

  // 1. Ordering — stable sort by answered position; ties keep candidate order.
  if (plan.orderTargets.length >= 2) {
    const positions = plan.orderTargets.map((id, index) => ({
      id,
      index,
      position: Number(answers[`order_${id}`]?.choice ?? index + 1) || index + 1,
    }));
    positions.sort((a, b) => a.position - b.position || a.index - b.index);
    selection.topBlocks = positions.map((entry) => entry.id);
    const root = spec.elements[spec.root];
    if (root && root.type === "Message") root.children = [...selection.topBlocks];
  }

  // 2. Section membership.
  for (const target of plan.parentTargets) {
    const answer = answers[`parent_${target.id}`];
    if (!answer || answer.choice === "root") continue;
    const sectionId = answer.choice.replace(/^in_/, "");
    const section = spec.elements[sectionId];
    if (!section || section.type !== "Section") continue;
    const root = spec.elements[spec.root];
    if (root && root.type === "Message") {
      const index = root.children.indexOf(target.id);
      if (index >= 0) root.children.splice(index, 1);
    }
    selection.topBlocks = selection.topBlocks.filter((id) => id !== target.id);
    section.children.push(target.id);
  }

  // 3. Keyboard rows.
  if (plan.rowTargets.length > 0) {
    const rowAssignments = new Map<string, number>();
    for (const buttonId of plan.rowTargets) {
      const answer = answers[`row_${buttonId}`];
      const row = answer ? Number(answer.choice.replace(/^row_/, "")) : 1;
      rowAssignments.set(buttonId, Number.isFinite(row) ? row : 1);
    }
    rebuildRows(selection, rowAssignments);
  }
}

function guidanceList(guidance: Guidance | undefined, phase: "select" | "layout"): string[] {
  const list: string[] = [];
  const value = guidance?.[phase];
  if (value) list.push(value);
  return list;
}
