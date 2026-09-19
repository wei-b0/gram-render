import { describe, expect, it } from "vitest";
import {
  AlertProps,
  ButtonProps,
  CodeProps,
  COMPONENT_TYPES,
  FieldProps,
  HeadingProps,
  ListProps,
  MessageProps,
  NoteProps,
  QuoteProps,
  SectionProps,
  StatusProps,
  TableProps,
  TextProps,
} from "../../src/spec/schema.js";
import { gateJsonText, gateValue } from "../../examples/comparison/gate.js";
import { GRAM_SPEC_WIRE_SCHEMA } from "../../examples/comparison/providers/gram-spec-schema.js";
import { validOrderSpec, VALID_ORDER_SPEC_WIRE_TEXT } from "./order-spec.js";

/**
 * Parity between the hand-written OpenAI strict-mode wire schema and the
 * package's own GramSpec component definitions, plus the shared gate's
 * accept/reject behavior. (Final acceptance of the wire schema is the live
 * smoke — OpenAI rejects invalid strict schemas at request time.)
 */

interface WireVariant {
  additionalProperties: boolean;
  properties: {
    type: { enum: string[] };
    props: { properties: Record<string, unknown> };
  };
  required: string[];
}

/** Slot keys per component type, as the zod element schemas define them. */
const ZOD_SLOTS: Record<string, string[]> = {
  Message: ["children", "keyboard"],
  Section: ["children"],
  ButtonRow: ["children"],
};

/** Per-type zod props shapes (ButtonRow and Divider take no props). */
const ZOD_PROPS: Record<string, Record<string, unknown>> = {
  Message: MessageProps.shape,
  Heading: HeadingProps.shape,
  Text: TextProps.shape,
  Section: SectionProps.shape,
  Divider: {},
  Field: FieldProps.shape,
  List: ListProps.shape,
  Status: StatusProps.shape,
  Code: CodeProps.shape,
  Quote: QuoteProps.shape,
  Alert: AlertProps.shape,
  Table: TableProps.shape,
  Note: NoteProps.shape,
  ButtonRow: {},
  Button: ButtonProps.shape,
};

function variantsByType(): Map<string, WireVariant> {
  const element = (GRAM_SPEC_WIRE_SCHEMA.$defs as Record<string, unknown>)["element"] as {
    anyOf: WireVariant[];
  };
  const map = new Map<string, WireVariant>();
  for (const variant of element.anyOf) {
    map.set(variant.properties.type.enum[0]!, variant);
  }
  return map;
}

function elementsOf(spec: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return spec["elements"] as Record<string, Record<string, unknown>>;
}

describe("GramSpec wire schema", () => {
  it("covers exactly the 15 component types", () => {
    expect(new Set(variantsByType().keys())).toEqual(new Set(COMPONENT_TYPES));
    expect(COMPONENT_TYPES).toHaveLength(15);
  });

  it("mirrors each component's props keys and slot requirements", () => {
    for (const [type, variant] of variantsByType()) {
      expect(variant.additionalProperties, `${type} must forbid extra keys`).toBe(false);
      expect(variant.required, `${type} requires type and props`).toEqual(
        expect.arrayContaining(["type", "props"]),
      );
      for (const slot of ZOD_SLOTS[type] ?? []) {
        expect(variant.required, `${type} requires ${slot}`).toContain(slot);
      }
      expect(Object.keys(variant.properties.props.properties).sort(), `${type} props`).toEqual(
        Object.keys(ZOD_PROPS[type] ?? {}).sort(),
      );
    }
  });

  it("is JSON-serializable and pins version to 1", () => {
    const round = JSON.parse(JSON.stringify(GRAM_SPEC_WIRE_SCHEMA)) as typeof GRAM_SPEC_WIRE_SCHEMA;
    expect(round).toEqual(GRAM_SPEC_WIRE_SCHEMA);
    expect(round.properties["version"]).toEqual({ type: "integer", enum: [1] });
  });

  it("expresses elements as an array with ids inside (strict mode allows no map types)", () => {
    expect(GRAM_SPEC_WIRE_SCHEMA.properties["elements"]).toEqual({
      type: "array",
      items: { $ref: "#/$defs/element" },
    });
    for (const [type, variant] of variantsByType()) {
      expect(variant.required, `${type} carries its id`).toContain("id");
      expect(variant.properties["id"]).toEqual({ type: "string" });
    }
    const buttonProps = variantsByType().get("Button")!.properties.props as {
      properties: Record<string, unknown>;
    };
    expect(buttonProps.properties["payload"]).toEqual({
      anyOf: [{ type: "array", items: { $ref: "#/$defs/pair" } }, { type: "null" }],
    });
  });

  it("gates the strict-output wire form of the canonical spec", () => {
    expect(gateJsonText(VALID_ORDER_SPEC_WIRE_TEXT)).toEqual({
      ok: true,
      stage: "ok",
      issues: [],
      normalized: true,
    });
  });
});

describe("shared validity gate", () => {
  it("passes the canonical order spec", () => {
    expect(gateValue(validOrderSpec())).toEqual({ ok: true, stage: "ok", issues: [], normalized: true });
  });

  it("strips null-valued optional props before schema validation", () => {
    const spec = validOrderSpec();
    (elementsOf(spec)["n6"]!["props"] as Record<string, unknown>)["mono"] = null;
    const gate = gateValue(spec);
    expect(gate.ok).toBe(true);
    expect(gate.normalized).toBe(true);
  });

  it("rejects a button with both action and url", () => {
    const spec = validOrderSpec();
    const b1 = elementsOf(spec)["b1"]!;
    b1["props"] = { ...b1["props"], url: "https://example.com" } as Record<string, unknown>;
    const gate = gateValue(spec);
    expect(gate.ok).toBe(false);
    expect(gate.stage).toBe("schema");
    expect(gate.issues.join("\n")).toContain("exactly one");
  });

  it("rejects a disabled button that still carries an action", () => {
    const spec = validOrderSpec();
    const b1 = elementsOf(spec)["b1"]!;
    b1["props"] = { ...b1["props"], disabled: true } as Record<string, unknown>;
    const gate = gateValue(spec);
    expect(gate.ok).toBe(false);
    expect(gate.stage).toBe("schema");
  });

  it("rejects a ragged table", () => {
    const spec = validOrderSpec();
    const elements = elementsOf(spec);
    elements["t1"] = {
      type: "Table",
      props: { columns: ["Item", "Qty"], rows: [["Backpack", "1"], ["Bottle"]] },
    };
    (elements["m1"]!["children"] as string[]).push("t1");
    const gate = gateValue(spec);
    expect(gate.ok).toBe(false);
    expect(gate.stage).toBe("schema");
    expect(gate.issues.join("\n")).toContain("rectangular");
  });

  it("rejects an unknown component type", () => {
    const spec = validOrderSpec();
    elementsOf(spec)["n9"] = { type: "Bogus", props: {} };
    const gate = gateValue(spec);
    expect(gate.ok).toBe(false);
    expect(gate.stage).toBe("schema");
  });

  it("rejects a spec whose root element does not exist", () => {
    const spec = validOrderSpec();
    spec["root"] = "missing";
    const gate = gateValue(spec);
    expect(gate.ok).toBe(false);
    expect(gate.stage).toBe("schema");
    expect(gate.issues[0]).toContain("root_not_found");
  });

  it("fails at the parse stage on invalid JSON", () => {
    const gate = gateJsonText("{nope");
    expect(gate.ok).toBe(false);
    expect(gate.stage).toBe("parse");
    expect(gate.issues.length).toBeGreaterThan(0);
  });
});
