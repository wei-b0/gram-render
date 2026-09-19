import { describe, expect, it } from "vitest";
import { GramSpecSchema, parseGramSpec } from "../src/spec/schema.js";

const validSpec = {
  version: 1,
  root: "m1",
  elements: {
    m1: { type: "Message", props: {}, children: ["h1", "r1"], keyboard: ["r1"] },
    h1: { type: "Heading", props: { text: "Running Agents" } },
    r1: { type: "ButtonRow", props: {}, children: ["b1"] },
    b1: { type: "Button", props: { label: "Refresh", action: "refresh" } },
  },
};

describe("GramSpecSchema", () => {
  it("accepts a valid spec and fills defaults", () => {
    const spec = parseGramSpec(validSpec);
    expect(spec.version).toBe(1);
    expect(spec.elements["m1"]!.type).toBe("Message");
  });

  it("rejects a button with both action and url", () => {
    const broken = structuredClone(validSpec);
    broken.elements["b1"] = { type: "Button", props: { label: "X", action: "a", url: "https://x" } };
    expect(() => parseGramSpec(broken)).toThrow();
  });

  it("rejects a disabled button with a target", () => {
    const broken = structuredClone(validSpec);
    broken.elements["b1"] = { type: "Button", props: { label: "X", action: "a", disabled: true } };
    expect(() => parseGramSpec(broken)).toThrow();
  });

  it("accepts a disabled button without a target", () => {
    const spec = structuredClone(validSpec);
    spec.elements["b1"] = { type: "Button", props: { label: "X", disabled: true } };
    expect(() => parseGramSpec(spec)).not.toThrow();
  });

  it("rejects unknown props on strict schemas", () => {
    const broken = structuredClone(validSpec);
    broken.elements["h1"] = { type: "Heading", props: { text: "Hi", nonsense: 1 } };
    expect(() => parseGramSpec(broken)).toThrow();
  });

  it("rejects invalid action identifiers", () => {
    const broken = structuredClone(validSpec);
    broken.elements["b1"] = { type: "Button", props: { label: "X", action: "1bad action" } };
    expect(() => parseGramSpec(broken)).toThrow();
  });

  it("rejects a leaf element with attachment keys", () => {
    const broken = structuredClone(validSpec);
    broken.elements["h1"] = { type: "Heading", props: { text: "Hi" }, children: ["b1"] };
    const result = GramSpecSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects a payload that is not JSON-serializable", () => {
    const broken = structuredClone(validSpec);
    broken.elements["b1"] = { type: "Button", props: { label: "X", action: "a", payload: { fn: () => {} } } };
    expect(() => parseGramSpec(broken)).toThrow();
  });
});

describe("Table and Note schemas", () => {
  function withElement(props: Record<string, unknown>): Record<string, unknown> {
    const spec = structuredClone(validSpec) as Record<string, any>;
    spec.elements["h1"] = { type: "Table", props };
    return spec;
  }

  it("accepts a rectangular table with matching columns", () => {
    const spec = withElement({
      columns: ["Agent", "Status"],
      rows: [
        ["cart-resolver", "running"],
        ["mail-digest", "degraded"],
      ],
      compact: true,
    });
    expect(() => parseGramSpec(spec)).not.toThrow();
  });

  it("accepts a headerless table", () => {
    const spec = withElement({ rows: [["a", "b"]] });
    expect(() => parseGramSpec(spec)).not.toThrow();
  });

  it("rejects a ragged table", () => {
    const spec = withElement({ rows: [["a", "b"], ["c"]] });
    expect(() => parseGramSpec(spec)).toThrow(/rectangular/);
  });

  it("rejects a table whose columns length differs from the row width", () => {
    const spec = withElement({ columns: ["A", "B", "C"], rows: [["a", "b"]] });
    expect(() => parseGramSpec(spec)).toThrow(/rectangular/);
  });

  it("rejects a table over the caps", () => {
    const tooWide = withElement({ rows: [Array.from({ length: 9 }, (_, index) => String(index))] });
    expect(() => parseGramSpec(tooWide)).toThrow();
    const tooDeep = withElement({ rows: Array.from({ length: 21 }, (_, index) => [String(index)]) });
    expect(() => parseGramSpec(tooDeep)).toThrow();
  });

  it("rejects unknown props and accepts Note text", () => {
    const note: Record<string, any> = structuredClone(validSpec) as never;
    note.elements["h1"] = { type: "Note", props: { text: "Use /use <name> to select" } };
    expect(() => parseGramSpec(note)).not.toThrow();
    note.elements["h1"] = { type: "Note", props: { text: "x", bold: true } };
    expect(() => parseGramSpec(note)).toThrow();
  });

  it("accepts a Field with mono and rejects a non-boolean mono", () => {
    const spec = structuredClone(validSpec) as Record<string, any>;
    spec.elements["h1"] = { type: "Field", props: { label: "Pane", value: "pane-7", mono: true } };
    expect(() => parseGramSpec(spec)).not.toThrow();
    spec.elements["h1"] = { type: "Field", props: { label: "Pane", value: "pane-7", mono: "yes" } };
    expect(() => parseGramSpec(spec)).toThrow();
  });
});
