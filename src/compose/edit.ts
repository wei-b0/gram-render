import { describeElement } from "../catalog/describe.js";
import { replacementFamily } from "../catalog/components.js";
import { deriveCandidates, type CandidateElement, type DeriveResult } from "../derive/candidates.js";
import type { Evaluator } from "../evaluate/types.js";
import { CompositionError } from "../errors.js";
import { GramSpecSchema, type GramSpec } from "../spec/schema.js";
import { callEvaluator, type UsageTracker } from "./call.js";
import type { CompositionEvent, ComposeOptions, CompositionStep, Guidance } from "./options.js";
import {
  attach,
  childIdsOf,
  deleteSubtree,
  detach,
  instantiateElement,
  nextElementId,
  validateTree,
  type Limits,
} from "./tree.js";

/**
 * Sequential edit mode — the gram-render equivalent of json-render's edit
 * protocol. Runs whenever `initialSpec` is provided, regardless of strategy:
 *
 * Each iteration asks a single `next` question offering adds (derived
 * candidates), `remove:<id>`, `replace:<id>` and `move:<id>` operations on
 * existing elements, plus `finish` / `unavailable`. Replace and move are
 * two-phase: the operation is chosen first, then the next iteration offers the
 * legal targets (same-family replacement candidates, or concrete positions).
 * Unaffected elements keep their ids and props.
 */

type EvaluationAnswers = Record<string, { choice: string; confidence?: number; probabilities?: Record<string, number> }>;

interface PendingReplace {
  type: "replace";
  id: string;
}
interface PendingMove {
  type: "move";
  id: string;
}
type Pending = PendingReplace | PendingMove;

export async function* editCompose(
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
    event: { spec: GramSpec | null; stopReason: "finish" | "limit" | "unavailable" },
  ): Extract<CompositionEvent, { type: "complete" }> => ({
    type: "complete",
    ...event,
    steps,
    calls: tracker.calls,
    elapsedMs: Date.now() - startedAt,
    inputTokens: tracker.inputTokens,
    warnings,
  });

  const seed = GramSpecSchema.parse(options.initialSpec);
  const spec = structuredClone(seed);
  warnings.push(...validateTree(spec, limits));

  const derive = deriveCandidates(options.prompt, options.context, { maxCandidates: limits.maxCandidates });
  warnings.push(...derive.warnings);

  const changesMade: string[] = [];
  let pending: Pending | undefined;

  for (let iteration = 0; iteration < limits.maxSteps; iteration += 1) {
    const questions = buildNextQuestions(spec, derive, pending, limits);
    const state: Record<string, unknown> = {
      user_request: options.prompt,
      already_built: describeSpec(spec),
      changes_made: [...changesMade],
      candidates: derive.candidates.map((candidate) => ({ id: candidate.id, description: candidate.description })),
      guidance: options.guidance?.edit ? [options.guidance.edit] : [],
    };
    if (pending) {
      const element = spec.elements[pending.id];
      state["pending_operation"] = {
        operation: pending.type,
        element: element ? describeElement(element) : pending.id,
        note:
          pending.type === "replace"
            ? "Choose the replacement for this element now."
            : "Choose the new position for this element now.",
      };
    }
    const contextJson = options.context ? JSON.stringify(options.context) : undefined;
    if (contextJson !== undefined && contextJson.length <= limits.maxContextChars) {
      state["context"] = options.context;
    }

    const call = await callEvaluator(evaluate, { state, questions, signal: options.signal }, tracker);
    const answer = call.answers["next"]!;
    const choice = answer.choice;

    if (choice === "finish") {
      yield emit({ spec, stopReason: "finish" });
      return;
    }
    if (choice === "unavailable") {
      yield emit({ spec, stopReason: "unavailable" });
      return;
    }

    const applied = applyOperation(spec, derive, choice, pending, changesMade, limits);
    pending = applied.nextPending;
    warnings.push(...validateTree(spec, limits));

    steps.push({
      index: ++stepCounter.value,
      kind: "edit",
      description: applied.description,
      confidence: answer.confidence,
      answers: { next: answer },
      elapsedMs: call.elapsedMs,
      inputTokens: call.inputTokens,
    });
    yield { type: "step", spec: structuredClone(spec), step: steps[steps.length - 1]! };
  }

  yield emit({ spec, stopReason: "limit" });
}

// ---------------------------------------------------------------- questions

function buildNextQuestions(
  spec: GramSpec,
  derive: DeriveResult,
  pending: Pending | undefined,
  limits: Limits,
): Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> {
  const criteria: Record<string, string> = {};

  if (pending?.type === "replace") {
    const element = spec.elements[pending.id];
    const family = element ? replacementFamily(element.type) : "content";
    for (const candidate of derive.candidates) {
      if (replacementFamily(candidate.element.type) !== family) continue;
      criteria[candidate.id] = candidate.description;
    }
    criteria["remove"] = "Remove the element instead of replacing it";
    return {
      next: {
        type: "choice",
        instructions: "Choose the replacement for the pending element. Choose remove to drop it instead.",
        criteria,
      },
    };
  }

  if (pending?.type === "move") {
    const destinations = moveDestinations(spec, pending.id);
    if (destinations.length === 0) {
      // Nowhere to move — offer finish so the loop can terminate cleanly.
      return { next: { type: "choice", instructions: "No alternative positions exist.", criteria: { finish: "Keep everything as is" } } };
    }
    for (const destination of destinations) criteria[destination.key] = destination.description;
    return {
      next: {
        type: "choice",
        instructions: "Choose the new position for the pending element. Its content moves with it.",
        criteria,
      },
    };
  }

  // Add options — reuse the derived questions' options (variants stay exclusive).
  const budgetLeft = limits.maxElements - Object.keys(spec.elements).length;
  if (budgetLeft > 0) {
    for (const derived of derive.questions) {
      for (const option of derived.options) {
        criteria[`add:${derived.key}:${option.id}`] = option.description;
      }
    }
  }

  for (const [id, element] of Object.entries(spec.elements)) {
    if (id === spec.root) continue;
    criteria[`remove:${id}`] = `Remove ${describeElement(element)} (and everything inside it)`;
    const family = replacementFamily(element.type);
    const hasReplacement = derive.candidates.some((candidate) => replacementFamily(candidate.element.type) === family);
    if (hasReplacement) criteria[`replace:${id}`] = `Replace ${describeElement(element)} with something else`;
    if (moveDestinations(spec, id).length > 0) criteria[`move:${id}`] = `Move or reorder ${describeElement(element)}`;
  }

  criteria["finish"] = "The request is fully satisfied — stop editing";
  criteria["unavailable"] = "The requested change cannot be done with the available options";

  return {
    next: {
      type: "choice",
      instructions:
        "Choose the next editing operation. Choose finish once the user's request is fully satisfied. Prefer the smallest change that satisfies the request.",
      criteria,
    },
  };
}

// ---------------------------------------------------------------- operations

function applyOperation(
  spec: GramSpec,
  derive: DeriveResult,
  choice: string,
  pending: Pending | undefined,
  changesMade: string[],
  limits: Limits,
): { nextPending: Pending | undefined; description: string } {
  // --- second phase of a replace
  if (pending?.type === "replace") {
    const target = spec.elements[pending.id];
    if (!target) throw new CompositionError(`Pending replace element '${pending.id}' vanished.`);
    if (choice === "remove") {
      deleteSubtree(spec, pending.id);
      changesMade.push(`Removed ${describeElement(target)}`);
      return { nextPending: undefined, description: `Removed ${describeElement(target)}` };
    }
    const candidate = derive.candidates.find((entry) => entry.id === choice);
    if (!candidate) throw new CompositionError(`Unknown replacement candidate '${choice}'.`);
    const description = `Replaced ${describeElement(target)} with ${candidate.description}`;
    const oldChildren = "children" in target ? [...target.children] : [];
    const replacement = instantiateElement(candidate.element.type, structuredClone(candidate.element.props));
    if ("children" in replacement && "children" in target && replacementFamily(replacement.type) === replacementFamily(target.type)) {
      replacement.children = oldChildren;
    }
    spec.elements[pending.id] = replacement;
    changesMade.push(description);
    return { nextPending: undefined, description };
  }

  // --- second phase of a move
  if (pending?.type === "move") {
    const element = spec.elements[pending.id];
    if (!element) throw new CompositionError(`Pending move element '${pending.id}' vanished.`);
    const destinations = moveDestinations(spec, pending.id);
    const destination = destinations.find((entry) => entry.key === choice);
    if (!destination) throw new CompositionError(`Unknown move destination '${choice}'.`);
    const description = `Moved ${describeElement(element)} — ${destination.description}`;
    destination.apply();
    changesMade.push(description);
    return { nextPending: undefined, description };
  }

  // --- first-phase operations
  if (choice.startsWith("add:")) {
    const rest = choice.slice("add:".length);
    const separator = rest.indexOf(":");
    const questionKey = separator >= 0 ? rest.slice(0, separator) : rest;
    const optionId = separator >= 0 ? rest.slice(separator + 1) : "";
    const derived = derive.questions.find((entry) => entry.key === questionKey);
    const option = derived?.options.find((entry) => entry.id === optionId);
    if (!derived || !option) throw new CompositionError(`Unknown add option '${choice}'.`);
    const added: string[] = [];
    for (const candidateId of option.candidateIds) {
      const candidate = derive.candidates.find((entry) => entry.id === candidateId);
      if (!candidate) continue;
      const id = addCandidateElement(spec, candidate.element, limits);
      added.push(id);
    }
    const summary = option.description;
    changesMade.push(`Added ${summary}`);
    return { nextPending: undefined, description: `Added ${summary}` };
  }

  if (choice.startsWith("remove:")) {
    const id = choice.slice("remove:".length);
    const element = spec.elements[id];
    if (!element) throw new CompositionError(`Unknown element '${id}' for removal.`);
    const description = `Removed ${describeElement(element)}`;
    deleteSubtree(spec, id);
    changesMade.push(description);
    return { nextPending: undefined, description };
  }

  if (choice.startsWith("replace:")) {
    const id = choice.slice("replace:".length);
    if (!spec.elements[id]) throw new CompositionError(`Unknown element '${id}' for replacement.`);
    return { nextPending: { type: "replace", id }, description: `Chose replacement of element '${id}'` };
  }

  if (choice.startsWith("move:")) {
    const id = choice.slice("move:".length);
    if (!spec.elements[id]) throw new CompositionError(`Unknown element '${id}' for move.`);
    return { nextPending: { type: "move", id }, description: `Chose move of element '${id}'` };
  }

  throw new CompositionError(`Unknown editing operation '${choice}'.`);
}

/** Instantiate a derived candidate element and attach it in the right slot. */
function addCandidateElement(spec: GramSpec, element: CandidateElement, limits: Limits): string {
  if (Object.keys(spec.elements).length >= limits.maxElements) {
    throw new CompositionError("Element budget exhausted during add.");
  }
  const id = nextElementId(spec);
  const instance = instantiateElement(element.type, structuredClone(element.props));
  spec.elements[id] = instance;
  if ("children" in instance && element.children) {
    for (const child of element.children) {
      const childId = nextElementId(spec);
      spec.elements[childId] = instantiateElement(child.type, structuredClone(child.props));
      instance.children.push(childId);
    }
  }
  if (element.type === "Button") {
    attachButton(spec, id);
  } else {
    attach(spec, id, spec.root);
  }
  return id;
}

function attachButton(spec: GramSpec, buttonId: string): void {
  const root = spec.elements[spec.root];
  if (!root || root.type !== "Message") throw new CompositionError("Cannot add a button without a Message root.");
  const lastRowId = root.keyboard[root.keyboard.length - 1];
  const lastRow = lastRowId ? spec.elements[lastRowId] : undefined;
  if (lastRow && lastRow.type === "ButtonRow" && lastRow.children.length < 4) {
    lastRow.children.push(buttonId);
    return;
  }
  const rowId = nextElementId(spec);
  spec.elements[rowId] = instantiateElement("ButtonRow", {});
  root.keyboard.push(rowId);
  const row = spec.elements[rowId];
  if (row && row.type === "ButtonRow") row.children.push(buttonId);
}

// ---------------------------------------------------------------- destinations

interface MoveDestination {
  key: string;
  description: string;
  apply: () => void;
}

/** Legal move destinations for an element (content positions, row positions, or row order). */
function moveDestinations(spec: GramSpec, id: string): MoveDestination[] {
  const element = spec.elements[id];
  if (!element || id === spec.root) return [];

  const moving = new Set(subtreeIdsLocal(spec, id));
  const destinations: MoveDestination[] = [];

  if (element.type === "Button") {
    for (const rowId of keyboardRowIds(spec)) {
      const row = spec.elements[rowId];
      if (!row || row.type !== "ButtonRow") continue;
      const siblings = row.children.filter((childId) => !moving.has(childId));
      for (const siblingId of siblings) {
        const sibling = spec.elements[siblingId]!;
        destinations.push({
          key: `mv:${rowId}:before:${siblingId}`,
          description: `before button '${String((sibling.props as Record<string, unknown>)["label"])}'`,
          apply: () => spliceMove(spec, id, rowId, siblingId),
        });
      }
      if (row.children.length > 0) {
        destinations.push({
          key: `mv:${rowId}:end`,
          description: `to the end of the row`,
          apply: () => spliceMove(spec, id, rowId, undefined),
        });
      }
    }
    return destinations;
  }

  if (element.type === "ButtonRow") {
    const rowIds = keyboardRowIds(spec);
    const rows = rowIds.filter((rowId) => rowId !== id);
    for (const otherId of rows) {
      const other = spec.elements[otherId]!;
      destinations.push({
        key: `mv:keyboard:before:${otherId}`,
        description: `before the row containing ${describeElement(other)}`,
        apply: () => reorderKeyboard(spec, id, otherId),
      });
    }
    if (rows.length > 0) {
      destinations.push({
        key: "mv:keyboard:end",
        description: "to the end of the keyboard",
        apply: () => reorderKeyboard(spec, id, undefined),
      });
    }
    return destinations;
  }

  // Content elements (incl. Sections) — positions in the message body and in other sections.
  const containers: Array<{ id: string; label: string }> = [
    { id: spec.root, label: "the message body" },
    ...Object.entries(spec.elements)
      .filter(([otherId, other]) => other.type === "Section" && otherId !== id && !moving.has(otherId))
      .map(([otherId, other]) => ({ id: otherId, label: `section '${String((other.props as Record<string, unknown>)["title"])}'` })),
  ];
  for (const container of containers) {
    const target = spec.elements[container.id];
    if (!target) continue;
    const siblings = childIdsOf(target).filter((childId) => !moving.has(childId));
    for (const siblingId of siblings) {
      const sibling = spec.elements[siblingId]!;
      destinations.push({
        key: `mv:${container.id}:before:${siblingId}`,
        description: `into ${container.label}, above ${describeElement(sibling)}`,
        apply: () => spliceMove(spec, id, container.id, siblingId),
      });
    }
    destinations.push({
      key: `mv:${container.id}:end`,
      description: `into ${container.label}, at the ${siblings.length > 0 ? "end" : "(currently empty) position"}`,
      apply: () => spliceMove(spec, id, container.id, undefined),
    });
  }
  return destinations;
}

function subtreeIdsLocal(spec: GramSpec, id: string): string[] {
  const result = [id];
  const walk = (elementId: string): void => {
    const element = spec.elements[elementId];
    if (!element) return;
    for (const childId of childIdsOf(element)) {
      result.push(childId);
      walk(childId);
    }
  };
  walk(id);
  return result;
}

function keyboardRowIds(spec: GramSpec): string[] {
  const root = spec.elements[spec.root];
  return root && root.type === "Message" ? [...root.keyboard] : [];
}

/** Detach `id` then insert before `beforeId` (or append) in `parentId`'s children. */
function spliceMove(spec: GramSpec, id: string, parentId: string, beforeId: string | undefined): void {
  detach(spec, id);
  const parent = spec.elements[parentId];
  if (!parent || !("children" in parent)) return;
  const index = beforeId ? parent.children.indexOf(beforeId) : -1;
  if (index >= 0) parent.children.splice(index, 0, id);
  else parent.children.push(id);
}

function reorderKeyboard(spec: GramSpec, rowId: string, beforeRowId: string | undefined): void {
  const root = spec.elements[spec.root];
  if (!root || root.type !== "Message") return;
  const index = root.keyboard.indexOf(rowId);
  if (index >= 0) root.keyboard.splice(index, 1);
  const before = beforeRowId ? root.keyboard.indexOf(beforeRowId) : -1;
  if (before >= 0) root.keyboard.splice(before, 0, rowId);
  else root.keyboard.push(rowId);
}

// ---------------------------------------------------------------- description

function describeSpec(spec: GramSpec): Array<Record<string, unknown>> {
  return Object.entries(spec.elements).map(([id, element]) => {
    const entry: Record<string, unknown> = {
      id,
      type: element.type,
      content: describeElement(element),
      children: childIdsOf(element),
    };
    if (element.type === "Message") entry["keyboard"] = element.keyboard;
    return entry;
  });
}
