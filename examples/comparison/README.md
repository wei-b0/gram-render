# LLM vs gram-render+JEV — reproducible comparison benchmark

A side-by-side benchmark of two ways to turn the same brief into a Telegram UI:

- **LEFT — LLM:** a frontier model (default `openai/gpt-6-astra` via OpenRouter;
  any Responses-API model via `--model`) writes a GramSpec via OpenAI Responses
  API native structured output, streaming.
- **RIGHT — gram-render + JEV:** `composeSpec()` derives candidates
  deterministically and JEV (`jev-latest`) makes calibrated discrete choices.
  JEV never authors text.

**Primary metric: time to valid GramSpec** — request start until the spec passes
the shared validity gate. Both sides start under a single shared `t0`, run
concurrently, and their outputs render through the *same* downstream compiler
(`compileClassicMessage`) — so parity is structural, not stylistic.

Everything in the Remotion video (`video/`, rendered by `render.ts`) replays a
captured trace. **No API calls happen during rendering.**

## What the video shows

Deliberately minimal — the race itself is the content:

- **Two Telegram conversations, nothing else.** Each panel is a flat,
  edge-to-edge Telegram chat surface (dark `#0e1621`, no card chrome — the
  benchmark canvas around it stays black) rendered by ONE shared spec →
  Telegram preview component (`video/TelegramPreview.tsx`), styled after
  Telegram Desktop's night theme and rendered at ~1.8× zoom so the message
  fills its half like a zoomed-in screenshot. The conversation is
  bottom-anchored under a centered date chip; the message reads like an
  actual incoming bot message:
  a gradient no-photo userpic (picked from the bot name, as Telegram does) +
  sender name beside a bubble only as large as its content, with the real
  `HH:MM` send time tucked into its bottom-right corner — hierarchy from
  typography rather than dashboard widgets: bold-label text lines, status
  lines with level-tinted glyphs (ℹ️ info / ✅ success), bullet lists, bold
  section titles, and tables as compact aligned monospace blocks (Telegram's
  native `<pre>` table representation, matching the compiler's column
  alignment). The inline keyboard attaches directly beneath the bubble at
  bubble width as native buttons — single-line, Telegram-style row sizing
  (every button in a row takes an equal share — the message widens so the
  widest label fits its share untruncated, ellipsis as the last-resort
  truncation) — including the per-button styles
  the wire artifact carries (`style: "primary" | "danger" | …` — filled
  blue/red). Both sides
  render through this exact same component and shell — only the generated
  message content differs; the recorded gate (`inspectClassicMessage`) still
  validates each spec's compiled wire artifact. Before a side's first
  renderable state, the chat shows Telegram's typing indicator.
- **The date chip and bubble timestamps are trace data, not invented:** the
  chip is the captured run's start date and each clock is `t0` plus that
  side's recorded first-UI instant (both sides land at `13:26` UTC in the
  canonical run). Formatted in UTC (no locale) so renders stay byte-identical
  on any machine.
- **LEFT — `LLM`:** UI blocks materialize one by one — each block appears at
  the frame it first became available in the recorded gated partial renders
  (full strength — real gated partial states, not a draft). The raw JSON
  stream is not shown.
- **RIGHT — `gram-render + JEV`:** the UI appears when the select step lands;
  no derivation internals, no model names on screen (the trace pins them).
- **One enormous timer per side** under the UI, displaying recorded trace
  time. When a side finishes, its timer freezes green with a checkmark
  (`0.76s ✓`) and the finished UI just sits there while the other side
  catches up. No bottom bar — the final frame is the two finished UIs and
  their two numbers, nothing more.
- **The left side plays as a 2.5× timelapse** (`LLM_TIME_SCALE` in
  `video/timeline.ts`): ~10.6 s of recorded LLM time is squeezed into ~4.2 s
  of video so the finished right side visibly waits on it. Every on-screen
  number is still a recorded trace value — the left timer displays real trace
  milliseconds (ticking 2.5× faster); the right side plays 1:1. This is a
  presentation choice, disclosed here; the underlying trace is untouched.
- **Header:** one line — "same prompt · same data · same schema". No model
  names, no fixture id, no metric headline.
- Fonts are bundled into the composition (`video/font-loader.ts` + `@fontsource`),
  so renders are byte-identical on machines with no system fonts installed.
- **Publishing:** the 1920×1080@30 MP4 is the deliverable (e.g. for X). The
  640×360 GIF is a dev preview only — don't publish it.

## Usage

```bash
# Prerequisites: .env with TYPESAFE_API_KEY (JEV side) and OPENROUTER_API_KEY
# or OPENAI_API_KEY (LLM side)

npm run compare:run                          # 3 warm runs + aggregates
npm run compare:run -- --runs 5              # more runs
npm run compare:run -- --model gpt-5.6-sol   # any Responses-API model
npm run compare:run -- --cold                # skip warmups (record cold numbers)
npm run compare:run -- --max-output-tokens 4096   # output cap (default 4096)
npm run compare:run -- --runs 1 --out examples/comparison/traces/canonical.json

npm run compare:video -- --trace examples/comparison/traces/canonical.json            # MP4 1920×1080@30
npm run compare:video -- --trace … --codec gif                                        # GIF 640×360

npm run compare                               # run + video
```

Outputs: one `traces/trace-<iso>-run<k>.json` per run plus a
`traces/summary-<iso>.json` aggregate; video files under `out/`. Both
directories are gitignored — except `traces/canonical.json`, the one run the
published video shows, which is committed.

## What counts as "valid" (the shared gate)

Both sides pass every candidate spec through the identical gate
(`gate.ts`):

1. `JSON.parse` (LLM side only — gram-render emits objects)
2. wire-shape + null-strip normalization (`providers/normalize.ts`): strict
   structured output allows no map types, so `elements` streams as an array of
   id-tagged elements and Button payloads as `{key, value}` pair arrays — both
   converted back to record form — and optional props arrive as explicit
   `null`s, which are stripped (payload values excepted)
3. `GramSpecSchema.safeParse` (the package's own zod schema)
4. root-existence check (the compiler tolerates dangling refs; the gate doesn't)
5. `inspectClassicMessage` with **zero** diagnostic errors (Telegram wire limits)

`firstValidMs` = first gate pass on a **complete** value. Gated partial-UI
states (below) never count toward the metric. Retries (transport/stream
failures and unparseable output, up to 3 request windows) stay inside the
measured window; `t0` never resets. A parseable but schema-invalid completion
is recorded as the honest outcome — not retried.

## Fairness rules

- **Same bytes in:** the prompt and context (`fixture.ts`) are hash-pinned in
  every trace (`promptSha256`, `contextSha256`). The LLM's user message embeds
  the identical `JSON.stringify(context, null, 2)` JEV's state carries.
- **Same component semantics:** the LLM's system prompt contains the same 15
  `CATALOG` component descriptions the JEV evaluator sees — nothing more
  opinionated. Both sides are told what the components are; neither is told
  how to lay them out beyond that.
- **Same downstream:** both specs go through the same compiler and the same
  Telegram preview in the video.
- **No handicaps:** the LLM gets native structured output (not "please emit
  JSON" prose) and model-default sampling. One recorded exception: output is
  capped at `maxOutputTokens` (default 4096 — several times what this fixture's
  spec needs; pinned in every trace) purely so budget-limited keys pass
  providers' up-front affordability checks. Partial-UI rendering on the left
  uses only fully-settled, gate-passing states — a conservative renderer, not
  a hopeful one.
- **Warmups excluded, recorded:** structured-output schemas have one-time
  compile latency on the OpenAI side; TLS/DNS on the JEV side. Default warmups
  (identical schema string; one real JEV round trip) run untimed and their
  durations are pinned in `meta.warmupMs`. `--cold` records cold numbers,
  marked per-run.

## Methodology & honesty

- The video shows **exactly one captured run** (canonical.json); aggregates
  over N runs accompany any publication — never cherry-picked, re-running is
  one command. The canonical run is picked by a fixed rule stated before
  capture: **run 1 of the canonical capture batch** (the first warm run), not
  the best-looking one.
- **Fixture history, disclosed:** the first capture (2026-09-19, prompt v1 —
  "expose the available actions") was discarded for **output parity, not
  timing**: gram-render's derivation proposes standard low-priority buttons
  (Refresh, Contact support) and JEV included them at low confidence (0.08 /
  0.19), which the LLM output lacked — the surfaces wouldn't have been
  comparable. The prompt was amended to scope the actions ("expose exactly
  the actions provided in the context — nothing else"), the same bytes going
  to both sides; JEV then omitted the standard buttons decisively (0.96 /
  0.92) and both sides produced the identical two-action keyboard. One
  discarded v2 probe run (fixture verification only) preceded that batch; all
  traces remain on disk.
- **Canonical re-capture, disclosed (same prompt-v2 bytes):** the derivation's
  compact-list formatter originally summarized object items by name only, so
  the gram-render side's first canonical hid the per-item quantities/prices
  the LLM side showed. The formatter now appends them when the data carries
  them (`Canvas Backpack ×1 — $54.00`; unit-tested), and the canonical batch
  was re-run with unchanged prompt/context hashes. The canonical trace is
  **run 1 of the `2026-09-19T15-27-38-540Z` batch** (warm: LLM 58.39 s vs
  gram-render 0.76 s; gram-render won 3/3 — the LLM time includes a first
  attempt truncated at `max_output_tokens` and retried inside the measured
  window, recorded in the trace's attempts). The earlier canonical — whose
  gram-side list was manually enriched to match this format for the first
  video cut — is retained as `traces/canonical-enriched-backup.json`.
- Every on-screen number comes from the trace: timers are the recorded
  `atMs` values; the partial-UI frames are the recorded `partialRenders`; the
  stream typing is the recorded raw deltas.
- Real timings, not the storyboard's ideals: the right side costs ~1–2 real
  JEV round trips (~1–2 s total measured), the left side is bounded by model
  generation speed. If a race is close or the "wrong" side wins, the video
  shows that.
- Each trace pins: model id + server-reported model, schema/prompt/context
  hashes, git sha, node version, openai version, warm flag, warmup durations,
  JEV model + base URL, retries, token usage. A trace is sufficient to re-render
  the video and to audit every claim it makes.

## Files

```
fixture.ts                the shared brief (order #1842) — prompt + context, hash-pinned
types.ts                  zod schema for trace JSON (ComparisonTrace) — everything the video replays
gate.ts                   the shared validity gate (definition above)
trace.ts                  pure trace builders + N-run aggregates
run.ts                    the runner (t0, warmups, concurrent race, trace writing)
providers/
  llm.ts                  OpenAI Responses streaming capture, partial-UI extraction, retries
  gram.ts                 composeSpec capture (wrapped evaluator + pull timestamps)
  llm-prompt.ts           system prompt (GramSpec contract + catalog) / user message
  gram-spec-schema.ts     hand-written OpenAI strict-mode JSON Schema for GramSpec
  normalize.ts            null-strip normalization (payload subtrees preserved)
traces/                   run outputs (gitignored; canonical.json force-added)
out/                      MP4/GIF output (gitignored)
video/                    Remotion composition (pure replay; bundled web fonts)
```

## Environment

| Variable | Used by | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | LLM side | preferred when set — routes to OpenRouter (`https://openrouter.ai/api/v1`, default model `openai/gpt-6-astra`) |
| `OPENAI_API_KEY` | LLM side | direct OpenAI fallback, used when `OPENROUTER_API_KEY` is unset |
| `TYPESAFE_API_KEY` (or `GRAM_RENDER_API_KEY`) | JEV side | required |
| `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` | JEV side | optional overrides, pinned in the trace |

Both LLM routes use the same OpenAI Responses API with native structured
output; the trace records which provider, base URL, and model each run hit.
Warmups run with the identical request shape (including the output cap); a
failed warmup marks the run cold so it stays out of warm aggregates.

Cost note: the video shows no token counts or prices — token usage is pinned
per attempt in `attempts[].usage` with the model id in `meta.llm`; compute
cost yourself from the trace.
