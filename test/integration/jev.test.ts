import { describe, expect, it } from "vitest";
import { compileClassicMessage, render } from "../../src/index.js";
import type { ButtonElement, GramSpec } from "../../src/spec/schema.js";

/**
 * Real-JEV integration tests. Skipped unless TYPESAFE_API_KEY (or
 * GRAM_RENDER_API_KEY) is set — `npm run test:integration` runs them.
 */

const HAS_KEY = Boolean(process.env["TYPESAFE_API_KEY"] ?? process.env["GRAM_RENDER_API_KEY"]);

const AGENTS = [
  { name: "cart-resolver", status: "running", uptime: "3h 12m", tasks_done: 142 },
  { name: "mail-digest", status: "degraded", uptime: "0h 44m", tasks_done: 9 },
  { name: "backup-worker", status: "idle", uptime: "12h 01m", tasks_done: 0 },
];

function buttonsOf(spec: GramSpec): ButtonElement[] {
  return Object.values(spec.elements).filter((element) => element.type === "Button") as ButtonElement[];
}

describe.skipIf(!HAS_KEY)("JEV integration", () => {
  it("composes an agents status message end-to-end", { timeout: 30_000 }, async () => {
    const result = await render({
      prompt: 'Show these agents. Quote "Agent fleet" as the heading. Expose actions for the degraded agent.',
      context: {
        agents: AGENTS,
        actions: [
          { label: "Restart mail-digest", action: "restart_agent", payload: { agent: "mail-digest" }, style: "primary" },
          { label: "View logs", action: "view_logs", payload: { agent: "mail-digest" } },
        ],
      },
    });

    // The real JEV may legitimately answer the gate "no" for odd requests;
    // for this fixture a finish is the expected outcome.
    expect(result.stopReason).toBe("finish");
    expect(result.spec).not.toBeNull();
    const spec = result.spec as GramSpec;

    expect(Object.keys(spec.elements).length).toBeGreaterThan(3);
    expect(spec.elements[spec.root]!.type).toBe("Message");
    // The agents data is represented somehow (sections or a compact list).
    const kinds = Object.values(spec.elements).map((element) => element.type);
    expect(kinds.some((kind) => kind === "Section" || kind === "List")).toBe(true);
    // Compiles cleanly to a classic Telegram payload.
    const message = compileClassicMessage(spec);
    expect(message.text.length).toBeLessThanOrEqual(4096);
    expect(message.parse_mode).toBe("HTML");
    for (const row of message.reply_markup?.inline_keyboard ?? []) {
      for (const button of row) {
        if (button.callback_data !== undefined) {
          expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
        }
      }
    }
    console.log("--- agents spec ---\n" + JSON.stringify(spec, null, 2));
    console.log("--- compiled ---\n" + message.text + "\n" + JSON.stringify(message.reply_markup));
  });

  it("composes an unseen order-confirmation domain", { timeout: 30_000 }, async () => {
    const result = await render({
      prompt: 'Confirm my order. Quote "Order confirmed" as the heading and add a "Track shipment" button.',
      context: {
        order: { id: "#4821", status: "processing", total: "€28.50", eta: "Thu, 2 days" },
        items: [
          { name: "Beans 1kg", qty: 2, price: "€24.00" },
          { name: "Oat milk", qty: 1, price: "€4.50" },
        ],
      },
    });

    expect(result.stopReason).toBe("finish");
    const spec = result.spec as GramSpec;
    const message = compileClassicMessage(spec);
    expect(message.text).toContain("Order confirmed");
    // "Track shipment" was a quoted prompt string — it can become a button.
    const labels = buttonsOf(spec).map((button) => button.props["label"]);
    expect(labels).toContain("Track shipment");
    console.log("--- order compiled ---\n" + message.text);
  });

  it("edits a generated spec: removing the logs action keeps other ids stable", { timeout: 60_000 }, async () => {
    const first = await render({
      prompt: "Show these agents with their status.",
      context: {
        agents: AGENTS,
        actions: [
          { label: "View logs", action: "view_logs", payload: { agent: "mail-digest" } },
          { label: "Restart mail-digest", action: "restart_agent", payload: { agent: "mail-digest" } },
        ],
      },
    });
    expect(first.stopReason).toBe("finish");
    const before = first.spec as GramSpec;
    const beforeIds = Object.keys(before.elements).sort();

    const edited = await render({
      prompt: "Remove the logs action.",
      initialSpec: before,
      context: { agents: AGENTS },
    });
    expect(edited.stopReason).toBe("finish");
    const after = edited.spec as GramSpec;

    const actions = buttonsOf(after).map((button) => button.props["action"]);
    expect(actions).not.toContain("view_logs");
    // Untouched elements kept their ids.
    const removed = beforeIds.filter((id) => after.elements[id] === undefined);
    expect(removed.length).toBeGreaterThan(0);
    for (const id of Object.keys(after.elements)) {
      if (!removed.includes(id) && before.elements[id]) {
        expect(after.elements[id]!.type).toBe(before.elements[id]!.type);
      }
    }
    expect(compileClassicMessage(after)).toBeDefined();
  });
});
