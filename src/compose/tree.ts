import { CATALOG, MESSAGE_CHILD_TYPES, SECTION_CHILD_TYPES } from "../catalog/components.js";
import { ValidationError, type ValidationCode } from "../errors.js";
import { GramElementSchema, type GramElement, type GramSpec, type ComponentType } from "../spec/schema.js";

/** Composition budgets (all configurable via `limits`). */
export interface Limits {
  /** Edit-mode operations (batch mode is inherently ≤ 2 evaluator calls). */
  maxSteps: number;
  maxElements: number;
  maxDepth: number;
  maxCandidates: number;
  /** Caller context larger than this is omitted from evaluator state (still drives derivation). */
  maxContextChars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 16,
  maxElements: 24,
  maxDepth: 3,
  maxCandidates: 40,
  maxContextChars: 8000,
};

export function cloneSpec(spec: GramSpec): GramSpec {
  return structuredClone(spec);
}

/** Next `n<count>` id: one past the highest existing numeric suffix (collision-free). */
export function nextElementId(spec: GramSpec): string {
  let max = 0;
  for (const id of Object.keys(spec.elements)) {
    const match = /^n(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `n${max + 1}`;
}

/** Content children of an element (empty for leaves). */
export function childIdsOf(element: GramElement): string[] {
  return "children" in element ? element.children : [];
}

function parentOf(spec: GramSpec, id: string): { parentId: string; index: number; slot: "children" | "keyboard" } | undefined {
  for (const [candidateId, element] of Object.entries(spec.elements)) {
    const childList = childIdsOf(element);
    const index = childList.indexOf(id);
    if (index >= 0) return { parentId: candidateId, index, slot: "children" };
    if (element.type === "Message") {
      const keyboardIndex = element.keyboard.indexOf(id);
      if (keyboardIndex >= 0) return { parentId: candidateId, index: keyboardIndex, slot: "keyboard" };
    }
  }
  return undefined;
}

/** Splice `id` into `parentId`'s content children. Caller must add the element first. */
export function attach(spec: GramSpec, id: string, parentId: string): void {
  const parent = spec.elements[parentId];
  if (!parent || !("children" in parent)) {
    throw new ValidationError("slot_violation", `Cannot attach to '${parentId}': not a container.`, { elementId: parentId });
  }
  parent.children.push(id);
}

/** Append a ButtonRow id to the Message keyboard. */
export function attachKeyboardRow(spec: GramSpec, rowId: string): void {
  const root = spec.elements[spec.root];
  if (!root || root.type !== "Message") {
    throw new ValidationError("slot_violation", "Keyboard rows can only attach to the Message root.", { elementId: spec.root });
  }
  root.keyboard.push(rowId);
}

/** Remove `id` from its parent's children/keyboard (element stays in the map). */
export function detach(spec: GramSpec, id: string): void {
  const location = parentOf(spec, id);
  if (!location) return;
  const parent = spec.elements[location.parentId];
  if (!parent) return;
  if (location.slot === "keyboard" && parent.type === "Message") {
    parent.keyboard.splice(location.index, 1);
  } else if ("children" in parent) {
    parent.children.splice(location.index, 1);
  }
}

/** All ids in the subtree rooted at `id` (including `id`). */
export function subtreeIds(spec: GramSpec, id: string): string[] {
  const result = [id];
  const walk = (elementId: string): void => {
    const element = spec.elements[elementId];
    if (!element) return;
    for (const childId of childIdsOf(element)) {
      result.push(childId);
      walk(childId);
    }
    if (element.type === "Message") {
      for (const rowId of element.keyboard) {
        result.push(rowId);
        walk(rowId);
      }
    }
  };
  walk(id);
  return result;
}

/** Detach `id` and delete every element in its subtree. */
export function deleteSubtree(spec: GramSpec, id: string): void {
  detach(spec, id);
  for (const subId of subtreeIds(spec, id)) {
    if (subId !== spec.root) delete spec.elements[subId];
  }
}

/** Validate the whole tree: structure, slot rules, depth, budgets, prop schemas. Returns warnings; throws ValidationError. */
export function validateTree(spec: GramSpec, limits: Limits): string[] {
  const warnings: string[] = [];
  const fail: (code: ValidationCode, message: string, elementId?: string) => never = (
    code,
    message,
    elementId,
  ) => {
    throw new ValidationError(code, message, { elementId });
  };

  const root = spec.elements[spec.root];
  if (!root) fail("root_missing", `Root '${spec.root}' does not exist in elements.`);
  if (root.type !== "Message") fail("invalid_spec", "Root must be a Message element.", spec.root);

  const elementCount = Object.keys(spec.elements).length;
  if (elementCount > limits.maxElements) {
    fail("element_limit", `Spec has ${elementCount} elements (max ${limits.maxElements}).`);
  } else if (elementCount > limits.maxElements * 0.9) {
    warnings.push(`Element count ${elementCount} is close to the limit (${limits.maxElements}).`);
  }

  // Re-validate each element against the schema (props, attachment shapes).
  for (const [id, element] of Object.entries(spec.elements)) {
    const parsed = GramElementSchema.safeParse(element);
    if (!parsed.success) {
      fail("invalid_spec", `Element '${id}' (${element.type}) is invalid: ${parsed.error.issues[0]?.message ?? "schema violation"}`, id);
    }
    const allowedChildren = CATALOG[element.type].childTypes;
    const hasChildren = "children" in element && element.children.length > 0;
    if (!allowedChildren && "children" in element && element.type !== "Message") {
      // Section/ButtonRow have childTypes; leaves must not.
      fail("slot_violation", `Element '${id}' (${element.type}) cannot have children.`, id);
    }
    if (allowedChildren && hasChildren) {
      for (const childId of element.children) {
        const child = spec.elements[childId];
        if (!child) fail("dangling_ref", `Element '${id}' references missing child '${childId}'.`, id);
        if (child.type === "Message") fail("shared_element", `Element '${id}' references the root as a child.`, id);
        const allowed = element.type === "Section" ? SECTION_CHILD_TYPES : element.type === "Message" ? MESSAGE_CHILD_TYPES : CATALOG[element.type].childTypes ?? [];
        if (!allowed.includes(child.type as never)) {
          fail("slot_violation", `Element '${id}' (${element.type}) cannot contain a ${child.type} child.`, id);
        }
      }
    }
    if (element.type === "Message") {
      for (const rowId of element.keyboard) {
        const row = spec.elements[rowId];
        if (!row) fail("dangling_ref", `Keyboard references missing row '${rowId}'.`, id);
        if (row.type !== "ButtonRow") fail("slot_violation", `Keyboard slot requires a ButtonRow, found ${row.type}.`, id);
      }
    }
  }

  // Every element referenced at most once + reachable from root (walk = cycle/shared detection).
  const seen = new Set<string>();
  const walk = (id: string, path: Set<string>): void => {
    if (path.has(id)) fail("shared_element", `Cyclic reference involving element '${id}'.`, id);
    if (seen.has(id)) fail("shared_element", `Element '${id}' is referenced more than once.`, id);
    seen.add(id);
    path.add(id);
    const element = spec.elements[id];
    if (!element) fail("dangling_ref", `Reference to missing element '${id}'.`, id);
    const depth = path.size;
    if (depth > limits.maxDepth) {
      fail("depth_exceeded", `Element '${id}' exceeds max depth ${limits.maxDepth}.`, id);
    }
    for (const childId of childIdsOf(element)) walk(childId, path);
    if (element.type === "Message") for (const rowId of element.keyboard) walk(rowId, path);
    path.delete(id);
  };
  walk(spec.root, new Set());

  if (seen.size < elementCount) {
    fail("invalid_spec", "Some elements are unreachable from the root.");
  }

  // Empty keyboard rows are pointless and render as nothing — flag them.
  for (const [id, element] of Object.entries(spec.elements)) {
    if (element.type === "ButtonRow" && element.children.length === 0) {
      warnings.push(`Button row '${id}' is empty.`);
    }
  }

  return warnings;
}

/** Instantiate a fresh element from a type + literal props (defaults applied by zod on validate). */
export function instantiateElement(type: ComponentType, props: Record<string, unknown>): GramElement {
  switch (type) {
    case "Message":
      return { type, props, children: [], keyboard: [] } as GramElement;
    case "Section":
    case "ButtonRow":
      return { type, props, children: [] } as unknown as GramElement;
    default:
      return { type, props } as GramElement;
  }
}
