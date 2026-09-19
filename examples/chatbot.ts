/**
 * To-fro chatbot demo — a minimal Telegram bot that wraps gram-render.
 * gram-render itself never talks to Telegram; this file is transport + demo
 * state, not part of the library.
 *
 * The conversational loop it demonstrates:
 *   you type  → JEV composes (new turn) or edits (follow-up) a GramSpec
 *               → compileClassicMessage → sendMessage / editMessageText
 *   you tap   → the demo "executes" the action on local state (gram-render
 *               only records intent) → spec re-renders → message updates live
 *
 * Chat commands: /start /new (fresh compose), /reset (forget), /help.
 * Any plain text edits the current spec via the JEV edit loop.
 * Buttons execute demo actions: restart_agent, view_logs.
 *
 * Run:  npm run bot            (polls 30 min)
 *       npm run bot -- 3600    (custom window in seconds)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render, compileClassicMessage } from "../src/index.js";
import type { GramSpec } from "../src/spec/schema.js";
import type { ClassicMessage } from "../src/compile/classic.js";

/** Tiny .env loader (no dependency); never overrides real env vars. */
function loadDotEnv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // no .env file — rely on real environment variables
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] === undefined) process.env[key] = match[2]!;
  }
}
loadDotEnv(fileURLToPath(new URL("../.env", import.meta.url)));

// --- Telegram transport (the part gram-render deliberately does not contain) ---

const TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set (put it in .env or the environment).");
  process.exit(1);
}
const TG = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method: string, body: unknown): Promise<any> {
  // One retry on network errors — Telegram routes occasionally stall the
  // first connection (observed: 10s connect timeout on both v6 and v4).
  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${TG}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      break;
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
  return json.result;
}

function sendBody(message: ClassicMessage) {
  return {
    text: message.text,
    parse_mode: message.parse_mode,
    ...(message.reply_markup ? { reply_markup: message.reply_markup } : {}),
  };
}

/** Best-effort toast; stale query IDs (>~15s) expire and this may fail — ignore. */
async function answer(queryId: string, text: string): Promise<void> {
  try {
    await tg("answerCallbackQuery", { callback_query_id: queryId, text });
  } catch {
    /* too old — nothing to do */
  }
}

// --- demo state (the "business logic" a real consumer would own) ---

// Type aliases (not interfaces) — they get implicit index signatures and are
// therefore assignable to ComposeOptions.context: Record<string, unknown>.
type DemoAgent = {
  name: string;
  status: string;
  uptime: string;
  tasks_done: number;
};
type DemoContext = {
  agents: DemoAgent[];
  actions: Array<{ label: string; action: string; payload?: Record<string, unknown>; style?: string }>;
};

function defaultContext(): Record<string, unknown> {
  return {
    agents: [
      { name: "cart-resolver", status: "running", uptime: "3h 12m", tasks_done: 142 },
      { name: "mail-digest", status: "degraded", uptime: "0h 44m", tasks_done: 9 },
      { name: "backup-worker", status: "idle", uptime: "12h 01m", tasks_done: 0 },
    ] satisfies DemoAgent[],
    actions: [
      { label: "Restart mail-digest", action: "restart_agent", payload: { agent: "mail-digest" }, style: "primary" },
      { label: "View logs", action: "view_logs", payload: { agent: "mail-digest" } },
    ],
  };
}

interface ChatState {
  context: Record<string, unknown>;
  spec: GramSpec | null;
  messageId: number | null;
}

const chats = new Map<number, ChatState>();
function stateOf(chatId: number): ChatState {
  let state = chats.get(chatId);
  if (!state) {
    state = { context: defaultContext(), spec: null, messageId: null };
    chats.set(chatId, state);
  }
  return state;
}

// --- spec → Telegram plumbing ---

const DEFAULT_PROMPT =
  'Show these agents. Quote "Agent fleet" as the heading. Expose actions for the degraded agent.';

async function reply(chatId: number, text: string): Promise<void> {
  await tg("sendMessage", { chat_id: chatId, text });
}

async function sendSpec(spec: GramSpec, chatId: number): Promise<number> {
  const message = compileClassicMessage(spec);
  const sent = await tg("sendMessage", { chat_id: chatId, ...sendBody(message) });
  return sent.message_id as number;
}

async function editSpec(spec: GramSpec, chatId: number, messageId: number): Promise<void> {
  const message = compileClassicMessage(spec);
  await tg("editMessageText", { chat_id: chatId, message_id: messageId, ...sendBody(message) });
}

async function composeFresh(state: ChatState, chatId: number, prompt: string): Promise<void> {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  const result = await render({ prompt, context: state.context });
  if (result.stopReason !== "finish" || !result.spec) {
    await reply(chatId, `JEV could not compose from that (stopReason=${result.stopReason}). Try rephrasing.`);
    return;
  }
  state.spec = result.spec;
  state.messageId = await sendSpec(result.spec, chatId);
  console.log(`[compose] chat ${chatId}: ${result.calls} call(s), ${result.inputTokens ?? "?"} tokens`);
}

async function applyEdit(state: ChatState, chatId: number, prompt: string): Promise<void> {
  if (!state.spec || state.messageId === null) {
    await composeFresh(state, chatId, prompt);
    return;
  }
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  const result = await render({ prompt, initialSpec: state.spec, context: state.context });
  if (result.stopReason !== "finish" || !result.spec) {
    await reply(chatId, `JEV could not map that to an edit (stopReason=${result.stopReason}).`);
    return;
  }
  state.spec = result.spec;
  try {
    await editSpec(result.spec, chatId, state.messageId);
  } catch {
    // e.g. message older than 48h — fall back to a fresh message
    state.messageId = await sendSpec(result.spec, chatId);
  }
  console.log(`[edit] chat ${chatId}: ${result.calls} call(s)`);
}

/** A hand-written GramSpec — specs are plain JSON; consumers may build them directly. */
function logsSpec(agentName: string, lines: string[]): GramSpec {
  return {
    version: 1,
    root: "m1",
    elements: {
      m1: { type: "Message", props: {}, children: ["h1", "c1"], keyboard: [] },
      h1: { type: "Heading", props: { text: `${agentName} — recent logs` } },
      c1: { type: "Code", props: { text: lines.join("\n") } },
    },
  };
}

// --- callback actions (consumer-owned execution; gram-render never runs these) ---

async function reRenderLive(state: ChatState, chatId: number): Promise<void> {
  if (!state.spec || state.messageId === null) return;
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  const result = await render({ prompt: DEFAULT_PROMPT, context: state.context });
  if (result.stopReason === "finish" && result.spec) {
    state.spec = result.spec;
    try {
      await editSpec(result.spec, chatId, state.messageId);
    } catch {
      state.messageId = await sendSpec(result.spec, chatId);
    }
    console.log(`[action] chat ${chatId}: spec re-rendered from mutated state`);
  }
}

async function handleCallback(
  state: ChatState,
  chatId: number,
  query: { id: string; data?: string },
): Promise<void> {
  const raw = String(query.data ?? "");
  let action = raw;
  let payload: Record<string, unknown> | undefined;
  try {
    const decoded: unknown = JSON.parse(raw);
    if (Array.isArray(decoded) && typeof decoded[0] === "string") {
      action = decoded[0];
      payload = decoded[1];
    }
  } catch {
    /* bare action string */
  }

  switch (action) {
    case "show_demo": {
      await answer(query.id, "Loading demo…");
      state.context = defaultContext();
      state.spec = null;
      state.messageId = null;
      await composeFresh(state, chatId, DEFAULT_PROMPT);
      break;
    }
    case "restart_agent": {
      await answer(query.id, "Restarting…");
      const agents = state.context["agents"] as DemoAgent[] | undefined;
      const agent = agents?.find((entry) => entry.name === payload?.["agent"]);
      if (agent) {
        agent.status = "running";
        agent.uptime = "0h 01m";
        agent.tasks_done = 0;
        await reRenderLive(state, chatId); // state changed → UI re-renders
      }
      break;
    }
    case "view_logs": {
      await answer(query.id, "Fetching log tail…");
      const agentName = String(payload?.["agent"] ?? "agent");
      const lines = [
        `${new Date().toISOString()} WARN  ${agentName} imap fetch retry 3/5`,
        `${new Date().toISOString()} ERROR ${agentName} smtp relay timeout (relay-2)`,
        `${new Date().toISOString()} INFO  ${agentName} queue depth 41`,
      ];
      // Hand-built spec: no JEV call needed when the consumer knows the content.
      await tg("sendMessage", { chat_id: chatId, ...sendBody(compileClassicMessage(logsSpec(agentName, lines))) });
      break;
    }
    default:
      await answer(query.id, `No handler for "${action}" in this demo.`);
  }
}

// --- update dispatch ---

/** Hand-built "how to use" spec — sent on startup and via /help. */
function guideSpec(): GramSpec {
  return {
    version: 1,
    root: "m1",
    elements: {
      m1: { type: "Message", props: {}, children: ["h1", "t1", "l1", "q1"], keyboard: ["r1"] },
      h1: { type: "Heading", props: { text: "gram-render demo bot" } },
      t1: { type: "Text", props: { text: "Every UI message I send is a GramSpec composed by JEV." } },
      l1: {
        type: "List",
        props: {
          items: [
            "Paste a JSON object → it becomes the data context",
            "Send a prompt → I compose the UI from it",
            "Send more text → the live message edits in place (JEV edit loop)",
            "Tap buttons → demo actions run, spec re-renders from new state",
            "/new — fresh UI • /reset — forget UI • /help — this guide",
          ],
        },
      },
      q1: { type: "Quote", props: { text: "Nothing is invented — every string comes from your data or your prompt." } },
      r1: { type: "ButtonRow", props: {}, children: ["b1"] },
      b1: { type: "Button", props: { label: "Show sample UI", action: "show_demo" } },
    },
  };
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const state = stateOf(chatId);
  const trimmed = text.trim();

  // A JSON object message swaps the data context for subsequent prompts —
  // prompt + context in → UI out, with your data.
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        state.context = parsed as Record<string, unknown>;
        state.spec = null;
        state.messageId = null;
        const keys = Object.keys(parsed as Record<string, unknown>).length;
        await reply(chatId, `Data loaded (${keys} top-level keys). Now send a prompt — or "show" for a default overview.`);
        return;
      }
    } catch {
      /* not JSON — fall through to prompt handling */
    }
  }

  if (trimmed === "show") {
    await composeFresh(state, chatId, "Show this data as a status overview.");
    return;
  }

  if (text.startsWith("/")) {
    const command = text.split(/\s+/)[0]!;
    if (command === "/start" || command === "/new") {
      await composeFresh(state, chatId, DEFAULT_PROMPT);
    } else if (command === "/reset") {
      state.spec = null;
      state.messageId = null;
      await reply(chatId, "Cleared. Type anything and I'll compose a fresh UI from the demo data.");
    } else {
      // /help and friends — the guide is itself a GramSpec.
      await tg("sendMessage", { chat_id: chatId, ...sendBody(compileClassicMessage(guideSpec())) });
    }
    return;
  }
  if (state.spec) {
    await applyEdit(state, chatId, text);
  } else {
    await composeFresh(state, chatId, text);
  }
}

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] ?? 1800);
  const me = await tg("getMe", {});
  console.log(`To-fro bot online: @${me.username} — polling for ${seconds}s`);

  // Send the usage guide to the configured chat on startup (GRAM_CHAT_ID in .env).
  const guideChat = process.env["GRAM_CHAT_ID"];
  if (guideChat) {
    await tg("sendMessage", { chat_id: Number(guideChat), ...sendBody(compileClassicMessage(guideSpec())) });
    console.log(`[guide] sent usage guide to chat ${guideChat}`);
  }
  const deadline = Date.now() + seconds * 1000;
  let offset = 0;
  while (Date.now() < deadline) {
    let updates: any[];
    try {
      updates = (await tg("getUpdates", {
        timeout: 25,
        offset,
        allowed_updates: ["message", "callback_query"],
      })) as any[];
    } catch (error) {
      console.log(`[poll] ${(error as Error).message} — retrying in 3s`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const chatId: number | undefined =
        update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
      try {
        if (update.callback_query && chatId !== undefined) {
          await handleCallback(stateOf(chatId), chatId, update.callback_query);
        } else if (update.message?.text && chatId !== undefined) {
          await handleMessage(chatId, update.message.text);
        }
      } catch (error) {
        console.error("[update error]", error);
        if (chatId !== undefined) {
          const text = error instanceof Error ? error.message : String(error);
          await reply(chatId, `⚠️ demo error: ${text.slice(0, 300)}`).catch(() => {});
        }
      }
    }
  }
  console.log("Bot window ended.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
