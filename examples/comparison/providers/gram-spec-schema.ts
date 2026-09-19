/**
 * OpenAI strict-mode JSON Schema mirroring GramSpecSchema, for structured
 * output (`text.format.type = "json_schema"`).
 *
 * OpenAI strict rules honored here:
 *  - every object: `additionalProperties: false`, every property in `required`;
 *  - optional props become nullable (`anyOf: [<type>, {type: "null"}]`);
 *  - only the supported keyword subset (type, enum, properties, required,
 *    additionalProperties: false, items, anyOf, $defs/$ref);
 *  - the root is not an anyOf (nested anyOf is fine);
 *  - NO map types: strict mode on this model rejects `additionalProperties`
 *    with a subschema at any depth (verified live). Two GramSpec shapes are
 *    records and go over the wire as arrays instead, converted back by
 *    providers/normalize.ts before the zod gate:
 *      - `elements`: array of element variants, each carrying its `id`;
 *      - `Button.payload`: array of `{key, value}` pairs (values are scalars
 *        or arrays of scalars).
 *  - validation-only keywords (minLength, pattern, rectangularity, the Button
 *    one-of rule) are NOT expressible — they are omitted here and enforced by
 *    the shared post-hoc zod gate (examples/comparison/gate.ts), which is part
 *    of the recorded benchmark methodology.
 *
 * A unit test (test/comparison/schema.test.ts) pins the component coverage
 * against the package's own GramSpecSchema/COMPONENT_TYPES; final acceptance
 * of the wire schema is the live smoke (the provider rejects invalid strict
 * schemas at request time).
 */

export interface JsonSchemaObject {
  [key: string]: unknown;
}

const str = (extra: JsonSchemaObject = {}): JsonSchemaObject => ({ type: "string", ...extra });
const nullable = (schema: JsonSchemaObject): JsonSchemaObject => ({ anyOf: [schema, { type: "null" }] });
const level = (): JsonSchemaObject => str({ enum: ["success", "info", "warning", "error"] });

/** All fields required, nothing extra — the strict-mode props object shape. */
const props = (properties: Record<string, JsonSchemaObject>): JsonSchemaObject => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const emptyProps = props({});

const childrenIds = (): JsonSchemaObject => ({ type: "array", items: str() });

const elementVariant = (
  type: string,
  propsSchema: JsonSchemaObject,
  slots: { children?: boolean; keyboard?: boolean } = {},
): JsonSchemaObject => {
  const properties: Record<string, JsonSchemaObject> = { id: str(), type: { enum: [type] }, props: propsSchema };
  const required = ["id", "type", "props"];
  if (slots.children) {
    properties.children = childrenIds();
    required.push("children");
  }
  if (slots.keyboard) {
    properties.keyboard = childrenIds();
    required.push("keyboard");
  }
  return { type: "object", properties, required, additionalProperties: false };
};

export const GRAM_SPEC_WIRE_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    root: str(),
    elements: { type: "array", items: { $ref: "#/$defs/element" } },
  },
  required: ["version", "root", "elements"],
  additionalProperties: false,
  $defs: {
    jsonValue: {
      anyOf: [
        str(),
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "array", items: { $ref: "#/$defs/jsonValue" } },
      ],
    },
    pair: props({ key: str(), value: { $ref: "#/$defs/jsonValue" } }),
    element: {
      anyOf: [
        elementVariant("Message", props({ preview: nullable(str({ enum: ["disabled"] })) }), {
          children: true,
          keyboard: true,
        }),
        elementVariant("Section", props({ title: str() }), { children: true }),
        elementVariant("ButtonRow", emptyProps, { children: true }),
        elementVariant("Heading", props({ text: str() })),
        elementVariant("Text", props({ text: str() })),
        elementVariant("Divider", emptyProps),
        elementVariant("Field", props({ label: str(), value: str(), mono: nullable({ type: "boolean" }) })),
        elementVariant("List", props({ items: childrenIds(), ordered: nullable({ type: "boolean" }) })),
        elementVariant("Status", props({ level: level(), text: str() })),
        elementVariant("Code", props({ text: str(), language: nullable(str()) })),
        elementVariant("Quote", props({ text: str(), expandable: nullable({ type: "boolean" }) })),
        elementVariant("Alert", props({ level: level(), title: nullable(str()), text: str() })),
        elementVariant(
          "Table",
          props({
            columns: nullable(childrenIds()),
            rows: { type: "array", items: childrenIds() },
            compact: nullable({ type: "boolean" }),
          }),
        ),
        elementVariant("Note", props({ text: str() })),
        elementVariant(
          "Button",
          props({
            label: str(),
            action: nullable(str()),
            payload: nullable({ type: "array", items: { $ref: "#/$defs/pair" } }),
            url: nullable(str()),
            style: nullable(str({ enum: ["primary", "success", "danger"] })),
            disabled: nullable({ type: "boolean" }),
          }),
        ),
      ],
    },
  },
};
