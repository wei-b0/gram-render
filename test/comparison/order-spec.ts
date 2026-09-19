/**
 * Hand-built GramSpec mirroring the order fixture (order #1842) — the
 * canonical gate-passing spec used across the comparison tests. Exported as a
 * JSON string so every consumer gets a fresh, independent copy.
 */

const SPEC = {
  version: 1,
  root: "m1",
  elements: {
    m1: { type: "Message", props: {}, children: ["n1", "n2", "n3", "n4"], keyboard: ["r1"] },
    n1: { type: "Heading", props: { text: "Order #1842" } },
    n2: { type: "Status", props: { level: "info", text: "Processing" } },
    n3: { type: "Field", props: { label: "Customer", value: "Maya Patel" } },
    n4: { type: "Section", props: { title: "Items" }, children: ["n5", "n6"] },
    n5: { type: "Field", props: { label: "Canvas Backpack ×1", value: "$54.00" } },
    n6: { type: "Field", props: { label: "Travel Bottle ×2", value: "$15.25", mono: false } },
    r1: { type: "ButtonRow", props: {}, children: ["b1", "b2"] },
    b1: {
      type: "Button",
      props: { label: "Mark as packed", action: "mark_packed", payload: { orderId: 1842 }, style: "primary" },
    },
    b2: {
      type: "Button",
      props: { label: "Cancel order", action: "cancel_order", payload: { orderId: 1842 }, style: "danger" },
    },
  },
};

export const VALID_ORDER_SPEC_TEXT = JSON.stringify(SPEC);

/**
 * The same spec in the strict structured-output WIRE shape (the shape the LLM
 * actually streams): `elements` is an array with each id inside its element,
 * payloads are `{key, value}` pair arrays, and nullable props arrive as
 * explicit nulls. `normalizeForGate` converts this to the record form above.
 */
const WIRE_SPEC = {
  version: 1,
  root: "m1",
  elements: [
    { id: "m1", type: "Message", props: { preview: null }, children: ["n1", "n2", "n3", "n4"], keyboard: ["r1"] },
    { id: "n1", type: "Heading", props: { text: "Order #1842" } },
    { id: "n2", type: "Status", props: { level: "info", text: "Processing" } },
    { id: "n3", type: "Field", props: { label: "Customer", value: "Maya Patel", mono: null } },
    { id: "n4", type: "Section", props: { title: "Items" }, children: ["n5", "n6"] },
    { id: "n5", type: "Field", props: { label: "Canvas Backpack ×1", value: "$54.00", mono: null } },
    { id: "n6", type: "Field", props: { label: "Travel Bottle ×2", value: "$15.25", mono: false } },
    { id: "r1", type: "ButtonRow", props: {}, children: ["b1", "b2"] },
    {
      id: "b1",
      type: "Button",
      props: {
        label: "Mark as packed",
        action: "mark_packed",
        payload: [{ key: "orderId", value: 1842 }],
        url: null,
        style: "primary",
        disabled: null,
      },
    },
    {
      id: "b2",
      type: "Button",
      props: {
        label: "Cancel order",
        action: "cancel_order",
        payload: [{ key: "orderId", value: 1842 }],
        url: null,
        style: "danger",
        disabled: null,
      },
    },
  ],
};

export const VALID_ORDER_SPEC_WIRE_TEXT = JSON.stringify(WIRE_SPEC);

export function validOrderSpec(): Record<string, unknown> {
  return JSON.parse(VALID_ORDER_SPEC_TEXT) as Record<string, unknown>;
}
