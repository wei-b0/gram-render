/**
 * Canonical fixture for the LLM vs gram-render+JEV comparison benchmark.
 *
 * A simple order-management domain: one order, two line items, two styled
 * actions. The prompt deliberately contains no quoted strings, so the heading
 * derives from context keys — the same signal set JEV sees.
 */

export interface ComparisonFixture {
  id: string;
  prompt: string;
  context: Record<string, unknown>;
}

export const ORDER_FIXTURE: ComparisonFixture = {
  id: "order-1842",
  prompt:
    "Show this order as a clean Telegram interface. Highlight the current status and expose exactly the actions provided in the context — nothing else.",
  context: {
    order: {
      id: "#1842",
      customer: "Maya Patel",
      status: "processing",
      payment: "paid",
      total: "$84.50",
      delivery: "Tomorrow, 2–5 PM",
    },
    items: [
      { name: "Canvas Backpack", quantity: 1, price: "$54.00" },
      { name: "Travel Bottle", quantity: 2, price: "$15.25" },
    ],
    actions: [
      { label: "Mark as packed", action: "mark_packed", payload: { orderId: 1842 }, style: "primary" },
      { label: "Cancel order", action: "cancel_order", payload: { orderId: 1842 }, style: "danger" },
    ],
  },
};
