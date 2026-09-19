/**
 * gram-render showcase bot — entry point.
 *
 * Run:  npm run bot        (needs .env: TELEGRAM_BOT_TOKEN + TYPESAFE_API_KEY)
 *
 * This bot is a CONSUMER of the gram-render library. The library never talks
 * to Telegram and never executes actions: prompts + context go in, validated
 * GramSpecs come out, this file's transport compiles and sends them, and
 * fixture actions in fixtures.ts mutate consumer-owned state before a
 * re-render.
 *
 * Posture: indefinite long polling (no webhook — a showcase needs no public
 * HTTPS), per-chat FIFO queues, a global JEV render semaphore, per-chat rate
 * limits, a 6 h idle TTL, a debounced JSON session snapshot, and generic
 * public errors (details go to the console only).
 */

import { fileURLToPath } from "node:url";
import { loadDotEnv, readConfig } from "./env.js";
import { createActions } from "./actions.js";
import { createComposer, type BotDeps } from "./compose.js";
import { createCommands, registerCommands } from "./commands.js";
import { createChatQueues, createRateLimiter, createSemaphore } from "./queue.js";
import { createSessionStore } from "./session.js";
import { createTg } from "./tg.js";

loadDotEnv(fileURLToPath(new URL("../../.env", import.meta.url)));

const config = readConfig();
if (!config.token) {
  console.error("TELEGRAM_BOT_TOKEN is required (put it in .env or the environment).");
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tg = createTg(config.token);

const me = (await tg.call<{ username?: string }>("getMe")) as { username?: string };
console.log(`gram-render showcase bot → @${me.username ?? "?"}`);
try {
  await registerCommands(tg);
} catch (error) {
  console.warn("[demo-bot] setMyCommands failed (command menu may be missing):", error);
}

const sessions = createSessionStore(config.sessionPath);
sessions.load();
sessions.startSweep();

const bot: BotDeps = {
  tg,
  sessions,
  queues: createChatQueues(),
  semaphore: createSemaphore(2), // global cap on concurrent JEV renders
  rate: createRateLimiter({ minGapMs: 3000, maxPerHour: 20 }),
};
const composer = createComposer(bot);
const actions = createActions({ bot, composer, repoUrl: config.repoUrl });
const commands = createCommands({ bot, composer, repoUrl: config.repoUrl });

if (!process.env["TYPESAFE_API_KEY"] && !process.env["GRAM_RENDER_API_KEY"]) {
  console.warn(
    "[demo-bot] no TypeSafe API key — screens and navigation work, but renders will fail until GRAM_RENDER_API_KEY (or TYPESAFE_API_KEY) is set.",
  );
}

function shutdown(signal: string): void {
  console.log(`[demo-bot] ${signal} — flushing sessions and exiting.`);
  sessions.dispose();
  sessions.flush();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function dispatch(update: any): Promise<void> {
  const query = update.callback_query;
  if (query?.message?.chat?.id != null) {
    await actions.handleCallback(query.message.chat.id as number, query);
    return;
  }
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (typeof chatId !== "number" || typeof text !== "string" || !text.trim()) return;
  await commands.handleMessage(chatId, text);
}

let offset = 0;
let first = true;
console.log("[demo-bot] long-polling…");
while (true) {
  let updates: any[];
  try {
    updates = (await tg.call("getUpdates", {
      timeout: 25,
      offset,
      allowed_updates: ["message", "callback_query"],
      ...(first ? { drop_pending_updates: true } : {}),
    })) as any[];
    first = false;
  } catch (error) {
    console.error("[poll]", error);
    await sleep(3000);
    continue;
  }
  for (const update of updates) {
    offset = update.update_id + 1;
    // Fire-and-forget: a slow JEV render must not stall polling for other
    // chats. Per-chat ordering is preserved by the chat queues inside.
    void dispatch(update).catch((error) => console.error("[update]", error));
  }
}
