/**
 * Live Telegram demo — a minimal transport shim showing what gram-render
 * output looks like in a real chat. gram-render itself never talks to
 * Telegram; this file is the only place a bot token appears, and it is
 * an example, not part of the library.
 *
 * Pipeline exercised:
 *   render() → compileClassicMessage() → sendMessage      (1st half)
 *   render(initialSpec) → compileClassicMessage() → editMessageText (2nd half)
 *
 * Env (loaded from ../.env if present, real env vars win):
 *   TELEGRAM_BOT_TOKEN  bot token from BotFather
 *   TYPESAFE_API_KEY    (or GRAM_RENDER_API_KEY) — TypeSafe JEV key
 *   GRAM_CHAT_ID        optional; auto-resolved from getUpdates otherwise
 *                       (send /start to the bot first)
 *
 * Modes:
 *   npm run live            compose → sendMessage → edit spec → editMessageText
 *   npm run live -- watch   long-poll callback queries for 60s (tap the buttons!)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render, compileClassicMessage } from "../src/index.js";
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

const ORDER = {
  id: "#1842", customer: "Maya Patel", status: "processing", payment: "paid",
  items: [
    { name: "Linen shirt", qty: 2, price: "$39.00" },
    { name: "Canvas tote", qty: 1, price: "$24.00" },
  ],
  total: "$102.00",
};

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

function printPayload(message: ClassicMessage): void {
  console.log("\n--- compiled payload ---");
  console.log(message.text);
  for (const [i, row] of (message.reply_markup?.inline_keyboard ?? []).entries()) {
    console.log(
      `row ${i + 1}: ` +
        row
          .map((button) => {
            const target = button.callback_data
              ? `callback_data (${new TextEncoder().encode(button.callback_data).length} bytes) ${button.callback_data}`
              : (button.url ?? "disabled");
            return `${button.text} → ${target}`;
          })
          .join("  |  "),
    );
  }
}

async function resolveChatId(): Promise<number> {
  const fromEnv = process.env["GRAM_CHAT_ID"];
  if (fromEnv) return Number(fromEnv);
  console.log("GRAM_CHAT_ID not set — resolving via getUpdates (send /start to the bot first)…");
  const updates = (await tg("getUpdates", { allowed_updates: ["message"] })) as any[];
  const latest = updates.filter((update) => update.message?.chat?.id !== undefined).at(-1);
  if (!latest) {
    console.error("No messages found. Open the bot in Telegram, send /start, then rerun.");
    process.exit(1);
  }
  const chatId = latest.message.chat.id as number;
  console.log(`Resolved chat_id ${chatId}`);
  return chatId;
}

// --- Modes ---

async function run(): Promise<void> {
  const me = await tg("getMe", {});
  console.log(`Bot: @${me.username}`);
  const chatId = await resolveChatId();

  console.log("\n=== 1/2 compose + sendMessage ===");
  const first = await render({
    prompt: 'Show this order. Quote "Order #1842" as the heading. Expose the actions.',
    context: {
      order: ORDER,
      actions: [
        { label: "Mark as packed", action: "mark_packed", payload: { order: "#1842" }, style: "primary" },
        { label: "Cancel order", action: "cancel_order", payload: { order: "#1842" }, style: "danger" },
      ],
    },
  });
  if (first.stopReason !== "finish" || !first.spec) {
    console.log(`Composition unavailable (stopReason=${first.stopReason}). Nothing sent.`);
    return;
  }
  const message = compileClassicMessage(first.spec);
  printPayload(message);
  const sent = await tg("sendMessage", { chat_id: chatId, ...sendBody(message) });
  console.log(`\nSent → message_id ${sent.message_id} (check Telegram)`);

  console.log("\n=== 2/2 edit spec + editMessageText (the message changes live) ===");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const edited = await render({
    prompt: 'Remove the cancel action. Add a divider and the text "Packed orders ship daily".',
    initialSpec: first.spec,
    context: { order: ORDER },
  });
  if (edited.stopReason !== "finish" || !edited.spec) {
    console.log(`Edit unavailable (stopReason=${edited.stopReason}); live message left as-is.`);
    return;
  }
  const editedMessage = compileClassicMessage(edited.spec);
  printPayload(editedMessage);
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: sent.message_id,
    ...sendBody(editedMessage),
  });
  console.log(`\nEdited in place → message_id ${sent.message_id}`);
  console.log("Now tap the remaining button, then run: npm run live -- watch");
}

async function watch(): Promise<void> {
  const seconds = Number(process.argv[3] ?? 600);
  console.log(`Long-polling callback queries for ${seconds}s — tap a button in the bot chat…`);
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const timeout = Math.min(30, Math.max(1, Math.floor(remainingMs / 1000)));
    const updates = (await tg("getUpdates", {
      timeout,
      allowed_updates: ["callback_query"],
    })) as any[];
    for (const update of updates) {
      const query = update.callback_query;
      if (!query) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(query.data as string);
      } catch {
        decoded = query.data; // bare action string
      }
      console.log(
        `tap: from=${query.from?.username ?? query.from?.id} raw=${query.data} decoded=${JSON.stringify(decoded)}`,
      );
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "gram-render demo ✓" });
    }
  }
  console.log("Watch window ended.");
}

const mode = process.argv[2] ?? "run";
(mode === "watch" ? watch() : run()).catch((error) => {
  console.error(error);
  process.exit(1);
});
