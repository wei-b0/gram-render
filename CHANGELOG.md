# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 — 2026-09-19

Initial release.

### Added

- **Composition** — `render()` (one-shot) and `composeSpec()` (streaming AsyncIterable) turn `prompt + context` into a validated `GramSpec` using JEV (TypeSafe System One) discrete-choice evaluation: batched select call → deterministic assembly → layout call (stable sort). `stopReason: finish | unavailable | limit`; confidence surfaced on every step, optional `minConfidence` gate.
- **Edit mode** — sequential operation loop (`remove` / `replace` / `move` / `add` / `finish`) via `initialSpec`; unaffected elements keep ids and props.
- **Catalog (15 components)** — `Message`, `Heading`, `Text`, `Section`, `Divider`, `Field`, `List`, `Status`, `Code`, `Quote`, `Alert`, `Table`, `Note`, `ButtonRow`, `Button`, with enforced slot rules, depth ≤ 3, and zod prop schemas.
- **Compile targets** — `compileClassicMessage` (Bot API classic HTML + inline keyboard) and `compileRichMessage` (Bot API 10.1–10.3 Rich Messages blocks: tables, footer, expandable quotes, in-flow button blocks). Button `callback_data` semantics identical across targets.
- **Derivation** — candidates derived internally from `prompt + context`: quoted strings → headings/buttons/links, context scalars → field/status/note lines, arrays → list / per-item sections / uniform-records table representations, ISO-8601 and date-keyed epoch humanizing, URL detection, `context.actions` → buttons, standard low-priority buttons.
- **Validation** — tree checks (dangling/shared refs, slots, depth, budgets), prop schemas, per-target Telegram limit checks (classic: 4096 chars, 64-byte `callback_data`; rich: 32,768 chars, 500 blocks, 8 buttons/block), typed `GramRenderError` hierarchy.
- **Evaluator adapter** — `createEvaluator` (zero-SDK `fetch` wrapper for the TypeSafe API) with injectable custom `Evaluator`.
- **Examples** — quickstart, live Telegram send/edit, to-fro demo chatbot, Rich Messages smoke + wire-format probes.
- Tests: 140 unit assertions (fake evaluator, no network) + env-gated integration tests against the live API.
