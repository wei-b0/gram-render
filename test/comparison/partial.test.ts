import { describe, expect, it } from "vitest";
import { Allow, parse as parsePartial } from "partial-json";
import { gateValue, gateValueDetailed } from "../../examples/comparison/gate.js";
import { collectElements, extractPartialSpec, SettledTracker } from "../../examples/comparison/providers/llm.js";
import { VALID_ORDER_SPEC_TEXT, VALID_ORDER_SPEC_WIRE_TEXT } from "./order-spec.js";

/**
 * The partial-UI pipeline: partial-JSON parsing of a growing buffer, the
 * settled-element rule (identical across two consecutive parses), and
 * reference clipping to settled ids. These states are what the video replays
 * mid-stream; a truncated element must never reach the renderer.
 */

function probe(buffer: string, tracker: SettledTracker): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = parsePartial(buffer, Allow.ALL);
  } catch {
    return null; // prefix not salvageable yet
  }
  return extractPartialSpec(value, tracker.update(collectElements(value)));
}

describe("partial-UI extraction", () => {
  it("materializes a gate-passing partial spec before the stream completes (wire form)", () => {
    const chunks = VALID_ORDER_SPEC_WIRE_TEXT.match(/.{1,10}/gs) ?? [];
    const tracker = new SettledTracker();
    const fullLength = VALID_ORDER_SPEC_WIRE_TEXT.length;

    let sawShell = false;
    let sawContent = false;
    for (let i = 0; i < chunks.length - 1; i++) {
      const partial = probe(chunks.slice(0, i + 1).join(""), tracker);
      if (partial === null || !gateValue(partial).ok) continue;
      const elements = partial["elements"] as Record<string, unknown>;
      if (Object.keys(elements).length >= 1) sawShell = true;
      if (Object.keys(elements).length >= 3) sawContent = true;
    }

    // The Telegram bubble materializes (possibly as an empty shell first) and
    // fills with content strictly before the final chunk arrives.
    expect(sawShell).toBe(true);
    expect(sawContent).toBe(true);
  });

  it("materializes the same way when a spec streams in the final record form", () => {
    const chunks = VALID_ORDER_SPEC_TEXT.match(/.{1,10}/gs) ?? [];
    const tracker = new SettledTracker();

    let sawShell = false;
    for (let i = 0; i < chunks.length - 1; i++) {
      const partial = probe(chunks.slice(0, i + 1).join(""), tracker);
      if (partial === null || !gateValue(partial).ok) continue;
      if (Object.keys(partial["elements"] as Record<string, unknown>).length >= 1) sawShell = true;
    }
    expect(sawShell).toBe(true);
  });

  it("returns null until the root element has settled", () => {
    const tracker = new SettledTracker();
    const first = probe(VALID_ORDER_SPEC_TEXT.slice(0, 80), tracker);
    // Either unparseable or not yet settled — never a spec without its root.
    if (first !== null) {
      expect(Object.keys(first["elements"] as Record<string, unknown>)).toContain(first["root"]);
    }
  });

  it("requires two consecutive identical parses before an element settles", () => {
    const tracker = new SettledTracker();
    const message = { type: "Message", props: {}, children: ["n1"], keyboard: [] };

    // Parse 1: nothing settled yet.
    const firstState = { version: 1, root: "m1", elements: { m1: message } };
    expect(probe(JSON.stringify(firstState), tracker)).toBeNull();

    // Parse 2: m1 identical → settled.
    const second = probe(JSON.stringify(firstState), tracker);
    expect(second).not.toBeNull();
    expect(Object.keys(second!["elements"] as Record<string, unknown>)).toContain("m1");

    // Parse 3: n1 appears mid-stream (still changing) → not settled, m1 persists.
    const changing = {
      version: 1,
      root: "m1",
      elements: { m1: message, n1: { type: "Heading", props: { text: "Ord" } } },
    };
    const third = probe(JSON.stringify(changing), tracker)!;
    expect(Object.keys(third["elements"] as Record<string, unknown>)).not.toContain("n1");

    // Parse 4: n1 changed again → still not settled.
    const growing = {
      ...changing,
      elements: { ...changing.elements, n1: { type: "Heading", props: { text: "Order" } } },
    };
    const fourth = probe(JSON.stringify(growing), tracker)!;
    expect(Object.keys(fourth["elements"] as Record<string, unknown>)).not.toContain("n1");

    // Parse 5: n1 identical to parse 4 → settles.
    const fifth = probe(JSON.stringify(growing), tracker)!;
    expect(Object.keys(fifth["elements"] as Record<string, unknown>)).toContain("n1");
  });

  it("clips dangling references and leaves List/Table labels untouched", () => {
    const tracker = new SettledTracker();
    const state = {
      version: 1,
      root: "m1",
      elements: {
        m1: { type: "Message", props: {}, children: ["n1", "n2", "l1"], keyboard: ["r1"] },
        n1: { type: "Heading", props: { text: "Order" } },
        l1: { type: "List", props: { items: ["Canvas Backpack", "Travel Bottle"] } },
      },
    };
    const text = JSON.stringify(state);

    probe(text, tracker); // parse 1 — nothing settled
    const partial = probe(text, tracker)!; // parse 2 — m1, n1, l1 settled
    const elements = partial["elements"] as Record<string, Record<string, unknown>>;

    // "n2" and "r1" are referenced but never emitted → clipped.
    expect(elements["m1"]!["children"]).toEqual(["n1", "l1"]);
    expect(elements["m1"]!["keyboard"]).toEqual([]);
    // List items are label strings, not ids — never clipped.
    expect((elements["l1"]!["props"] as Record<string, unknown>)["items"]).toEqual([
      "Canvas Backpack",
      "Travel Bottle",
    ]);
    expect(Object.keys(elements)).not.toContain("n2");
    expect(Object.keys(elements)).not.toContain("r1");
  });

  it("converts wire payloads to records and strips nulls in gate-passing partials", () => {
    const tracker = new SettledTracker();
    const state = {
      version: 1,
      root: "m1",
      elements: [
        { id: "m1", type: "Message", props: { preview: null }, children: ["b1"], keyboard: [] },
        {
          id: "b1",
          type: "Button",
          props: { label: "Mark as packed", action: "mark_packed", payload: [{ key: "orderId", value: 1842 }], url: null },
        },
      ],
    };
    const text = JSON.stringify(state);
    probe(text, tracker); // parse 1 — nothing settled
    const partial = probe(text, tracker)!; // parse 2 — m1, b1 settled

    // The raw partial is record-form with ids stripped, but explicit nulls and
    // pair payloads pass through untouched — the gate normalizes them.
    const outcome = gateValueDetailed(partial);
    expect(outcome.gate.ok).toBe(true);
    const elements = outcome.spec!["elements"] as Record<string, Record<string, unknown>>;

    expect(Object.keys(elements).sort()).toEqual(["b1", "m1"]);
    expect(elements["m1"]!["props"]).toEqual({});
    // Payload pairs → record; explicit nulls stripped (payload VALUES survive).
    expect((elements["b1"]!["props"] as Record<string, unknown>)["payload"]).toEqual({ orderId: 1842 });
    expect((elements["b1"]!["props"] as Record<string, unknown>)["url"]).toBeUndefined();
  });

  it("keeps the parsed value pristine so the settled rule stays stable", () => {
    const tracker = new SettledTracker();
    const state = {
      version: 1,
      root: "m1",
      elements: {
        m1: { type: "Message", props: {}, children: ["n1", "n2"], keyboard: [] },
        n1: { type: "Heading", props: { text: "Order" } },
        n2: { type: "Text", props: { text: "Hi" } },
      },
    };
    const text = JSON.stringify(state);
    probe(text, tracker);
    expect(probe(text, tracker)).not.toBeNull();
    // If clipping mutated the tracked previous parse, this third probe would
    // see m1 as "changed" (children re-clipped) and return null.
    expect(probe(text, tracker)).not.toBeNull();
  });
});
