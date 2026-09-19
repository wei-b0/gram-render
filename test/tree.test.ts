import { describe, expect, it } from "vitest";
import { instantiateElement, nextElementId, validateTree, deleteSubtree, subtreeIds, DEFAULT_LIMITS } from "../src/compose/tree.js";
import { replacementFamily } from "../src/catalog/components.js";
import type { GramSpec } from "../src/spec/schema.js";

export function agentSpec(): GramSpec {
  return {
    version: 1,
    root: "m1",
    elements: {
      m1: { type: "Message", props: {}, children: ["h1", "s1", "st1"], keyboard: ["r1"] },
      h1: { type: "Heading", props: { text: "Running Agents" } },
      s1: { type: "Section", props: { title: "cart-resolver" }, children: ["f1", "st2"] },
      f1: { type: "Field", props: { label: "Uptime", value: "3h 12m" } },
      st1: { type: "Status", props: { level: "info", text: "3 agents online" } },
      st2: { type: "Status", props: { level: "success", text: "running" } },
      r1: { type: "ButtonRow", props: {}, children: ["b1", "b2"] },
      b1: { type: "Button", props: { label: "Refresh", action: "refresh" } },
      b2: { type: "Button", props: { label: "View logs", action: "view_logs", payload: { agent: "cart-resolver" } } },
    },
  };
}

describe("validateTree", () => {
  it("accepts a well-formed spec", () => {
    expect(validateTree(agentSpec(), DEFAULT_LIMITS)).toEqual([]);
  });

  it("rejects dangling references", () => {
    const spec = agentSpec();
    spec.elements["m1"]!.children = ["ghost"];
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrowError(/missing child 'ghost'/);
  });

  it("rejects shared elements", () => {
    const spec = agentSpec();
    spec.elements["s1"]!.children.push("st1");
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrowError(/referenced more than once|Cyclic/);
  });

  it("rejects slot violations (field inside button row)", () => {
    const spec = agentSpec();
    spec.elements["r1"]!.children = ["f1"];
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrowError(/cannot contain a Field child/);
  });

  it("rejects non-ButtonRow in keyboard", () => {
    const spec = agentSpec();
    spec.elements["m1"]!.keyboard = ["f1"];
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrowError(/Keyboard slot requires a ButtonRow/);
  });

  it("rejects unknown element types", () => {
    const spec = agentSpec();
    (spec.elements["h1"] as Record<string, unknown>)["type"] = "Modal";
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrow();
  });

  it("rejects unreachable elements", () => {
    const spec = agentSpec();
    spec.elements["loner"] = { type: "Divider", props: {} };
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrowError(/unreachable/);
  });

  it("rejects depth violations", () => {
    const spec = agentSpec();
    expect(() => validateTree(spec, { ...DEFAULT_LIMITS, maxDepth: 2 })).toThrowError(/max depth 2/);
  });

  it("rejects element count over budget", () => {
    const spec = agentSpec();
    expect(() => validateTree(spec, { ...DEFAULT_LIMITS, maxElements: 2 })).toThrowError(/max 2/);
  });

  it("rejects invalid props (button without target)", () => {
    const spec = agentSpec();
    spec.elements["b1"] = { type: "Button", props: { label: "Broken" } };
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrowError(/exactly one of/);
  });

  it("accepts Table and Note as Message and Section children", () => {
    const spec = agentSpec();
    spec.elements["t1"] = { type: "Table", props: { rows: [["a", "b"]] } };
    spec.elements["n1"] = { type: "Note", props: { text: "hint" } };
    (spec.elements["m1"] as { children: string[] }).children.push("t1", "n1");
    spec.elements["s1"]!.children.push("t1");
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrowError(/referenced more than once/); // shared child guard still applies
    (spec.elements["m1"] as { children: string[] }).children = ["h1", "s1", "st1", "t1"];
    spec.elements["s1"]!.children = ["f1", "st2", "n1"];
    expect(validateTree(spec, DEFAULT_LIMITS)).toEqual([]);
  });

  it("rejects a Table inside a ButtonRow", () => {
    const spec = agentSpec();
    spec.elements["t1"] = { type: "Table", props: { rows: [["a"]] } };
    spec.elements["r1"]!.children = ["t1"];
    expect(() => validateTree(spec, DEFAULT_LIMITS)).toThrowError(/cannot contain a Table child/);
  });
});

describe("replacementFamily", () => {
  it("assigns the content family to Table and Note", () => {
    expect(replacementFamily("Table")).toBe("content");
    expect(replacementFamily("Note")).toBe("content");
    expect(replacementFamily("Button")).toBe("button");
  });
});

describe("tree utilities", () => {
  it("nextElementId skips collisions", () => {
    const spec = agentSpec();
    spec.elements["n1"] = { type: "Divider", props: {} };
    spec.elements["n2"] = { type: "Divider", props: {} };
    expect(nextElementId(spec)).toBe("n3");
    expect(nextElementId(agentSpec())).toBe("n1");
  });

  it("subtreeIds includes nested children", () => {
    const spec = agentSpec();
    expect(subtreeIds(spec, "s1")).toEqual(["s1", "f1", "st2"]);
    expect(subtreeIds(spec, "r1")).toEqual(["r1", "b1", "b2"]);
  });

  it("deleteSubtree removes rows with their buttons", () => {
    const spec = agentSpec();
    deleteSubtree(spec, "r1");
    expect(spec.elements["r1"]).toBeUndefined();
    expect(spec.elements["b1"]).toBeUndefined();
    expect(spec.elements["b2"]).toBeUndefined();
    expect(spec.elements["m1"]!.keyboard).toEqual([]);
    expect(() => validateTree(spec, DEFAULT_LIMITS)).not.toThrow();
  });

  it("instantiateElement builds container shapes", () => {
    const message = instantiateElement("Message", {});
    expect(message).toMatchObject({ type: "Message", children: [], keyboard: [] });
    const section = instantiateElement("Section", { title: "x" });
    expect(section).toMatchObject({ type: "Section", children: [] });
    const heading = instantiateElement("Heading", { text: "x" });
    expect("children" in heading).toBe(false);
  });
});
