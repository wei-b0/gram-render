# gram-render

[![npm](https://img.shields.io/npm/v/gram-render)](https://www.npmjs.com/package/gram-render)
[![npm downloads](https://img.shields.io/npm/dm/gram-render)](https://www.npmjs.com/package/gram-render)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/wei-b0/gram-render/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/gram-render)](https://www.npmjs.com/package/gram-render)
[![evaluator](https://img.shields.io/badge/evaluator-JEV%20%C2%B7%20TypeSafe%20System%20One-8A2BE2)](https://typesafe.ai)

![gram-render: prompt + context in, a live Telegram message out — edited in place on follow-up prompts](https://raw.githubusercontent.com/wei-b0/gram-render/main/assets/hero.svg)

**JEV-powered generative UI for Telegram bots.** Describe the UI you want in natural language, hand over structured data, and get back a deterministic, validated `GramSpec` — a plain-JSON Telegram interface specification your bot can compile and send.

```
prompt + context  ──▶  gram-render  ──▶  GramSpec (JSON)
```

gram-render never talks to Telegram. No bot token, no transport, no update handling, no callback execution — it stops at the spec. You compile it (`compileClassicMessage` for classic HTML and `compileRichMessage` for Bot API 10.3 Rich Messages are included as reference compilers) and send it with any Bot API client.

## How it works

Under the hood, composition runs on [JEV](https://typesafe.ai) (TypeSafe "System One") — a decision model that can only make calibrated discrete choices, never write text. That constraint is the safety property: **every string in the output comes from your data or your prompt** — gram-render never invents prose.

1. **Derive** — candidates are extracted from `prompt + context`: quoted prompt strings become headings/buttons, context scalars become field lines, status-shaped values get emoji variants, arrays get section-vs-list representation options, `context.actions` become buttons.
2. **Select** (one JEV call) — every derived group becomes a choice question in a single batched evaluation ("show as sections, as a list, or omit?"), plus a `fulfillable` gate. JEV answers all questions in parallel; assembly into a spec happens deterministically in code.
3. **Layout** (one JEV call, only when non-trivial) — block ordering, section membership, and keyboard-row grouping, applied as a stable sort.
4. **Validate** — the tree, prop schemas, and Telegram's real limits (4096-char text, 64-byte `callback_data`) are checked before anything is returned.

Editing an existing spec (`initialSpec`) runs a sequential operation loop (`remove` / `replace` / `move` / `add` / `finish`) instead — the same protocol shape proven by Vercel's `json-render` composer, adapted to Telegram's smaller UI surface.

## Install

```bash
npm install gram-render
```

Node ≥ 20. The only runtime dependency is `zod`.

For AI coding assistants, an [`llms.txt`](llms.txt) index of the API ships in the package and lives at the repo root.

You need a TypeSafe API key ([console.typesafe.ai](https://console.typesafe.ai/settings/keys)). The default `createEvaluator()` reads it from its `apiKey` option, or from the `GRAM_RENDER_API_KEY` / `TYPESAFE_API_KEY` environment variables.

## Quick start

```ts
import { render, createEvaluator, compileClassicMessage } from "gram-render";

// The default evaluator: resolves the TypeSafe API key (apiKey option, else
// GRAM_RENDER_API_KEY / TYPESAFE_API_KEY) and performs the JEV calls.
const evaluate = createEvaluator();

const result = await render({
  evaluate,
  prompt: 'Show this order. Quote "Order #1842" as the heading. Expose the actions.',
  context: {
    order: {
      id: "#1842", customer: "Maya Patel", status: "processing", payment: "paid",
      items: [
        { name: "Linen shirt", qty: 2, price: "$39.00" },
        { name: "Canvas tote", qty: 1, price: "$24.00" },
      ],
      total: "$102.00",
    },
    actions: [
      { label: "Mark as packed", action: "mark_packed",
        payload: { order: "#1842" }, style: "primary" },
      { label: "Cancel order", action: "cancel_order",
        payload: { order: "#1842" }, style: "danger" },
    ],
  },
});

if (result.stopReason === "finish" && result.spec) {
  const payload = compileClassicMessage(result.spec);
  // payload: { text, parse_mode: "HTML", reply_markup: { inline_keyboard } }
  // → send with your Bot API client of choice
}
```

A typical compiled message for this fixture (JEV chooses the layout, so details vary run to run):

```
<b>Order #1842</b>

<b>Order</b>
<b>ID:</b> #1842
<b>Customer:</b> Maya Patel
ℹ️ Status: processing
✅ Payment: paid
<b>Total:</b> $102.00
• Linen shirt
• Canvas tote

[Mark as packed] [Cancel order]   ← callback_data '["mark_packed",{"order":"#1842"}]'
```

### Prompt-only renders

`context` is optional. With no data, the only content source is what you quote in the prompt — JEV composes the structure and picks the blocks, but it never authors a word:

```ts
const result = await render({
  evaluate,
  prompt: 'A tiny welcome card for the coffee shop "Daily Grind". Offer "Order pickup" and "Opening hours" as buttons.',
});

if (result.stopReason === "finish" && result.spec) {
  const payload = compileClassicMessage(result.spec); // same as before
}
```

A typical compiled message for that prompt (JEV chooses the layout, so details vary run to run):

```
<b>Daily Grind</b>

[Order pickup] [Opening hours]   ← callback_data 'order_pickup' / 'opening_hours'
```

A prompt with nothing quotable (no quoted strings, no context) returns `stopReason: "unavailable"` — an empty result instead of an invented card. That is the never-authors property working in both directions: quotes are the content, and without them there is nothing to show.

### Streaming

`composeSpec` streams validated intermediate specs — useful for debugging, previews, and tooling. Telegram consumers can simply await the final event.

```ts
for await (const event of composeSpec({ prompt, context })) {
  if (event.type === "step") {
    console.log(event.step.kind, event.step.description, event.step.confidence);
    // event.spec — snapshot of the spec so far
  } else {
    console.log(event.stopReason, event.calls, event.inputTokens);
  }
}
```

### Editing

Pass a generated (or hand-written) spec back with `initialSpec` and a follow-up prompt. Unaffected elements keep their ids and props — safe to diff and to re-send only what changed.

```ts
const edited = await render({
  prompt: "Remove the cancel action.",
  initialSpec: result.spec,
  context: { order },
});
```

## API

### `render(options): Promise<RenderResult>`

One-shot composition. `RenderResult` = `{ spec, stopReason, calls, elapsedMs, inputTokens, warnings, steps }`.

### `composeSpec(options): AsyncIterable<CompositionEvent>`

Streaming variant: `step` events (kind `select` | `layout` | `edit`, description, confidence, spec snapshot) then one `complete` event (final spec, `stopReason`, usage, warnings).

### `StopReason`

- `"finish"` — spec produced.
- `"unavailable"` — JEV judged the request not fulfillable with the derived candidates (or all groups were omitted). `spec` may be null; these are normal outcomes, not exceptions.
- `"limit"` — edit loop hit `maxSteps`.

### `ComposeOptions`

| Option | Default | Meaning |
|---|---|---|
| `prompt` | — (required) | ≤ 4000 chars. Quoted `"…"` strings become heading/button candidates. |
| `context` | — | Structured data. Every displayed string comes from here or the prompt. |
| `initialSpec` | — | Switches to the sequential edit loop. |
| `evaluate` | `createEvaluator()` | The evaluator used for every JEV call. Inject a custom `Evaluator` to override (same request shape as json-render's). |
| `guidance` | — | `{ select?, layout?, edit? }` nudges forwarded in evaluator state. |
| `minConfidence` | off | When set (0–1), a fulfillability answer below the gate returns `unavailable` (JEV signals near-coin-flips with very low confidence). |
| `limits` | see below | `{ maxElements: 24, maxDepth: 3, maxCandidates: 40, maxSteps: 16, maxContextChars: 8000 }`. |
| `signal` | — | Abort signal, propagated to every evaluator call. |

### `createEvaluator(options)`

The default evaluator — a ~100-line `fetch` wrapper for the TypeSafe API (no SDK dependency; `gram-render` ships with `zod` only). It is constructed automatically when `evaluate` is omitted, and exported so you can build it explicitly (as in the quick start), share one instance across calls, or configure it: `apiKey?` (else `GRAM_RENDER_API_KEY` / `TYPESAFE_API_KEY`), `baseURL?` (else `TYPESAFE_BASE_URL`; default `https://api.typesafe.ai`), `model?` (else `TYPESAFE_DEFAULT_MODEL`; default `jev-latest`), `timeoutMs?` (default 10 000), `fetch?` (inject a mock). HTTP errors surface as typed `EvaluatorError`s; there are no internal retries.

## GramSpec

A flat tree — one `Message` root, keyed elements, ordered children. Plain JSON, no JEV internals.

```jsonc
{
  "version": 1,
  "root": "m1",
  "elements": {
    "m1": { "type": "Message", "props": {}, "children": ["n1", "n2", "n3"], "keyboard": ["r1"] },
    "n1": { "type": "Heading", "props": { "text": "Order #1842" } },
    "n2": { "type": "Status",  "props": { "level": "info", "text": "Status: processing" } },
    "n3": { "type": "Section", "props": { "title": "Delivery" }, "children": ["n4", "n5"] },
    "n4": { "type": "Field",   "props": { "label": "Method", "value": "Courier" } },
    "n5": { "type": "Field",   "props": { "label": "ETA", "value": "Sep 23–24" } },
    "r1": { "type": "ButtonRow", "props": {}, "children": ["n6", "n7"] },
    "n6": { "type": "Button", "props": { "label": "Mark as packed", "action": "mark_packed", "payload": { "order": "#1842" }, "style": "primary" } },
    "n7": { "type": "Button", "props": { "label": "Cancel order", "action": "cancel_order", "payload": { "order": "#1842" }, "style": "danger" } }
  }
}
```

### Components (the fixed Telegram catalog, shipped in-package)

| Component | Props | Telegram mapping (classic HTML) |
|---|---|---|
| `Message` | `preview?: "disabled"` | the message body + one inline keyboard |
| `Heading` | `text` | bold line |
| `Text` | `text` | plain paragraph |
| `Section` | `title` | bold title + grouped lines |
| `Divider` | — | `──────────────` rule |
| `Field` | `label`, `value`, `mono?` | `label: value` line (mono → `<code>` value) |
| `List` | `items[]`, `ordered?` | `• `/`1.` lines |
| `Status` | `level: success\|info\|warning\|error`, `text` | ✅ ℹ️ ⚠️ ❌ line |
| `Code` | `text`, `language?` | `<pre><code>` block |
| `Quote` | `text`, `expandable?` | `<blockquote>` |
| `Alert` | `level`, `title?`, `text` | emoji + bold title line |
| `Table` | `columns?[]`, `rows[][]`, `compact?` | monospace `<pre>` aligned grid |
| `Note` | `text` | small italic `<i>` hint line |
| `ButtonRow` | — | one inline-keyboard row |
| `Button` | `label`, exactly one of `action`/`url`, `payload?`, `style?` (`primary\|success\|danger`), `disabled?` | `InlineKeyboardButton` |

Slot rules (enforced): only `Message`/`Section` take content children; only `Message` has `keyboard`; only `ButtonRow` inside `keyboard`; only `Button` inside `ButtonRow`; depth ≤ 3.

Schemas are exported (`GramSpecSchema`, per-component prop schemas, `parseGramSpec`) so hand-written or third-party specs validate against the same rules.

## Compile targets

A spec is renderer-agnostic JSON. Two reference compilers ship in-package:

### Classic — `compileClassicMessage(spec)`

```ts
const payload = compileClassicMessage(spec);
// { text, parse_mode: "HTML", reply_markup?: { inline_keyboard } }
await bot("sendMessage", { chat_id, ...payload });
await bot("editMessageText", { chat_id, message_id, ...payload }); // live views
```

### Rich Messages — `compileRichMessage(spec)` (Bot API 10.1–10.3)

Compiles the same spec to real blocks — tables become `RichBlockTable`s (with borders/compact), `Note` becomes a footer block, `Quote.expandable` a native collapsible, and `Message.keyboard` rows become in-flow `buttons` blocks:

```ts
const payload = compileRichMessage(spec);
// { rich_message: { blocks: [...] } }
await bot("sendRichMessage", { chat_id, ...payload });
await bot("editMessageText", { chat_id, message_id, ...payload });
```

Button semantics are identical in both targets: `action + payload` serialize to the same ≤64-byte `callback_data`, so a consumer's callback handler works unchanged across targets. Trade-off note: buttons ride inside the rich payload, so a plain-text fallback send (HTML-parse-recovery style) would lose them — rebuild a classic `reply_markup` from the spec if you need both.

Rich limits are enforced by `inspectRichMessage` / `telegramDiagnostics(spec, "rich")`: 32,768 chars of text, 500 blocks (list items and table rows count), 8 buttons per block, 20 table columns.

## Actions & callback_data

`action` is a short consumer-defined identifier; `payload` is any JSON object. gram-render **never executes actions** — the spec records intent; your bot's callback handler owns behavior.

`compileClassicMessage` serializes `action + payload` as `JSON.stringify([action, payload])` and **errors above 64 bytes** (Telegram's `callback_data` limit). Payloads that don't fit: store them server-side and reference by a short id.

## Validation & errors

Four layers: derived-candidate checks, tree checks after every mutation (dangling/shared refs, slot rules, depth, budget), zod prop schemas, and a Telegram compile-check per target — classic: 4096-char text, 64-byte `callback_data` as errors, rows > 8 / buttons > 6 / text > 3500 as soft warnings; rich: 32,768-char text, 500 blocks, 8 buttons per block as errors, near-limit values as warnings.

- `EvaluatorError` — HTTP/timeout/protocol failures (cause preserved).
- `CompositionError` — defensive invariant violations.
- `ValidationError` — spec/limit violations, with `code` + `elementId`.

`inspectClassicMessage(spec)` / `inspectRichMessage(spec)` return diagnostics without throwing; `telegramDiagnostics(spec, target?)` is the same check as a linter.

## Design notes

- **Jev cannot invent text, and that's a feature.** Every string is (a) context data, (b) a quoted prompt string, (c) a key-derived label, or (d) a catalog-standard label. Candidates carry literal props; JEV chooses among them and never authors content.
- **Batched composition.** All selection questions ride in one evaluation call (JEV evaluates questions in parallel), so a new spec costs ≈2 calls and an edit ≈1 call per operation.
- **Deterministic assembly.** Ordering uses a stable sort (ties keep candidate order); spec assembly, id assignment (`n1, n2, …`), and row grouping are pure code.
- **Confidence is surfaced, not hidden.** Near-coin-flip decisions show up in `step.confidence`; `minConfidence` turns them into `unavailable` when you'd rather ask the user than guess.
- **Semantic catalog.** The 15 components compile to classic HTML and Bot API 10.3 Rich Messages from one schema — the same spec renders on any Telegram client generation.

## Testing

```bash
npm test                 # unit — fake evaluator, no network
npm run test:integration # real JEV (needs TYPESAFE_API_KEY), skipped otherwise
npm run example          # quickstart demo (needs TYPESAFE_API_KEY)
npm run live             # send + edit one live Telegram message (.env: TELEGRAM_BOT_TOKEN)
npm run bot              # interactive showcase bot (examples/demo-bot, same .env)
npm run smoke:rich       # live Rich Messages smoke + undocumented-behavior probes (same .env)
```

The test suite uses a scripted fake evaluator for deterministic composition/edit/assembly tests, plus env-gated integration tests against the live API.

## Roadmap (v0.2+)

Multi-message `Flow` specs, media/poll/location blocks (transport-coupled — deferred), `RichTextDateTime` mapping for date values, checkbox list items, `details`-block catalog component, in-flow button positioning inside rich tables, custom catalog escape hatch, retry policies, RFC 6902 patch streaming for live-edit consumers, `sendRichMessageDraft` streaming previews.
