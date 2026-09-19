/**
 * Hand-built GramSpec screens for the showcase bot — home, gallery,
 * how-it-works, about, and the playground intro. All navigation is a demo
 * affordance; fixture data lives in fixtures.ts. Every screen here is
 * validated by unit tests (parseGramSpec + zero compile diagnostics).
 */

import { serializeCallbackData } from "../../src/index.js";
import type { ComponentType, GramElement, GramSpec } from "../../src/index.js";

/** Tiny builder for hand-authored specs (ids n1, n2, …). */
export class SpecBuilder {
  readonly elements: Record<string, GramElement> = {};
  private count = 0;

  add(type: ComponentType, props: Record<string, unknown>, children?: string[]): string {
    const id = `n${++this.count}`;
    this.elements[id] = (children ? { type, props, children } : { type, props }) as unknown as GramElement;
    return id;
  }

  /** Message root with content children + keyboard rows (button id arrays). */
  message(children: string[], keyboard: string[][]): string {
    const rows = keyboard.map((buttons) => this.add("ButtonRow", {}, buttons));
    const id = this.add("Message", {}, children);
    (this.elements[id] as { keyboard?: string[] }).keyboard = rows;
    return id;
  }

  done(rootId: string): GramSpec {
    return { version: 1, root: rootId, elements: { ...this.elements } };
  }
}

type ButtonSpec =
  | { label: string; action: string; payload?: Record<string, unknown>; style?: "primary" | "success" | "danger" }
  | { label: string; url: string };

export function addButton(b: SpecBuilder, spec: ButtonSpec): string {
  if ("url" in spec) {
    return b.add("Button", { label: spec.label, url: spec.url });
  }
  return b.add("Button", {
    label: spec.label,
    action: spec.action,
    ...(spec.payload ? { payload: spec.payload } : {}),
    ...(spec.style ? { style: spec.style } : {}),
  });
}

// --- screens ---

export function homeSpec(repoUrl: string): GramSpec {
  const b = new SpecBuilder();
  const h = b.add("Heading", { text: "gram-render" });
  const t = b.add("Text", {
    text: "Structured app data + one line of intent in — a validated Telegram UI out. Under the hood: JEV (TypeSafe System One), a model that only ever chooses between pre-built blocks. It never writes a word.",
  });
  const l = b.add("List", {
    items: [
      "Try the demo — a live order card that edits itself",
      "Browse examples — 5 fixtures, 5 component mixes",
      "Playground — paste your own JSON and prompt it",
    ],
  });
  const q = b.add("Quote", { text: "Every string you'll see came from data or a prompt — nothing is invented." });
  const root = b.message([h, t, l, q], [
    [addButton(b, { label: "Try the demo", action: "nav_demo", style: "primary" })],
    [addButton(b, { label: "Browse examples", action: "nav_examples" }), addButton(b, { label: "Playground", action: "nav_play" })],
    [addButton(b, { label: "How it works", action: "nav_how" }), addButton(b, { label: "About", action: "nav_about" })],
    [addButton(b, { label: "Source / docs", url: repoUrl })],
  ]);
  return b.done(root);
}

export function gallerySpec(): GramSpec {
  const b = new SpecBuilder();
  const h = b.add("Heading", { text: "Example gallery" });
  const t = b.add("Text", {
    text: "Five fixtures, five different mixes of the same 15-component catalog. Pick one — it loads real data and renders live.",
  });
  const l = b.add("List", {
    items: [
      "Order #1842 — sections, statuses, item list, actions",
      "Incident INC-2917 — alert, timeline quote, statuses",
      "Deployment b-7742 — table, code block, mono fields",
      "Usage, 30 days — table, note footer, key numbers",
      "Ticket TCK-558 — thread quote, list, priority",
    ],
  });
  const root = b.message([h, t, l], [
    [addButton(b, { label: "Order", action: "ex_order", style: "primary" }), addButton(b, { label: "Incident", action: "ex_incident" })],
    [addButton(b, { label: "Deployment", action: "ex_deploy" }), addButton(b, { label: "Usage", action: "ex_usage" })],
    [addButton(b, { label: "Ticket", action: "ex_ticket" })],
    [addButton(b, { label: "Back", action: "nav_home" })],
  ]);
  return b.done(root);
}

export function howSpec(): GramSpec {
  const b = new SpecBuilder();
  const h = b.add("Heading", { text: "How it works" });
  const f1 = b.add("Field", { label: "Render", value: "state → gram-render → GramSpec → Telegram UI", mono: true });
  const f2 = b.add("Field", { label: "Actions", value: "callback → your code → state change → re-render", mono: true });
  const l = b.add("List", {
    items: [
      "Derive — candidates are built from your prompt + data",
      "Select — one batched JEV call picks what to show",
      "Layout — one more call orders and groups blocks",
      "Validate — tree, schemas, and Telegram limits checked",
    ],
  });
  const q = b.add("Quote", {
    text: "gram-render never executes actions and never invents text — buttons carry intent; your callback handler owns behavior.",
  });
  const n = b.add("Note", { text: "After any render, /inspect shows every choice JEV made — with confidences." });
  const root = b.message([h, f1, f2, l, q, n], [
    [addButton(b, { label: "Try the demo", action: "nav_demo", style: "primary" }), addButton(b, { label: "Back", action: "nav_home" })],
  ]);
  return b.done(root);
}

export function aboutSpec(): GramSpec {
  const b = new SpecBuilder();
  const h = b.add("Heading", { text: "About this bot" });
  const t = b.add("Text", {
    text: "A public showcase for gram-render: the library turns prompt + context into a validated GramSpec, and this bot — a consumer — compiles and sends it. The library itself never talks to Telegram.",
  });
  const l = b.add("List", {
    items: [
      "/demo — guided order demo",
      "/examples — fixture gallery",
      "/play — paste your own JSON",
      "/inspect — how the last render was decided",
      "/reset — clear this session",
      "/about — this page",
    ],
  });
  const n = b.add("Note", { text: "JEV chooses; it never authors prose. That is the safety property." });
  const root = b.message([h, t, l, n], [
    [addButton(b, { label: "Try the demo", action: "nav_demo", style: "primary" }), addButton(b, { label: "How it works", action: "nav_how" })],
  ]);
  return b.done(root);
}

export function playgroundSpec(): GramSpec {
  const b = new SpecBuilder();
  const h = b.add("Heading", { text: "Playground" });
  const t = b.add("Text", {
    text: "Paste any JSON object (up to 6 000 characters) as a chat message. You'll get an acknowledgement, then type any prompt and JEV renders your data live.",
  });
  const l = b.add("List", {
    items: [
      "One JSON object per message",
      'Then type a prompt — e.g. "Show a compact overview."',
      "Follow-up prompts edit the view in place",
    ],
  });
  const q = b.add("Quote", {
    text: "Buttons inside your JSON (context.actions) belong to YOUR app — tapping one here only explains what a real bot's handler would do.",
  });
  const root = b.message([h, t, l, q], [
    [addButton(b, { label: "Load sample JSON", action: "pg_sample", style: "primary" }), addButton(b, { label: "Back", action: "nav_home" })],
  ]);
  return b.done(root);
}

/** What a post-render tray carries (currently just the inspect affordance). */
export type TrayKind = "inspect";

/**
 * The small message that follows every demo/gallery render: one hint line
 * plus the Inspect/Back buttons. No edit chips — edits are typed prompts.
 */
export function inspectTraySpec(): GramSpec {
  const b = new SpecBuilder();
  const t = b.add("Text", {
    text: "✏️ Type any prompt to edit the view above. The card's buttons are app actions your code would execute.",
  });
  const root = b.message([t], [
    [addButton(b, { label: "Inspect last render", action: "nav_inspect" }), addButton(b, { label: "Back", action: "nav_home" })],
  ]);
  return b.done(root);
}

/** Guard used by tests: callback_data must stay within Telegram's 64 bytes. */
export function callbackBytes(action: string, payload?: Record<string, unknown>): number {
  return new TextEncoder().encode(serializeCallbackData(action, payload)).length;
}
