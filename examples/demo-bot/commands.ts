/**
 * Message router — commands, the playground JSON path, and free-text
 * prompts. Renders are always handed to the composer (rate-limited,
 * coalesced, per-chat queued); this layer only validates input and speaks.
 */

import { compileClassicMessage } from "../../src/index.js";
import type { GramSpec } from "../../src/index.js";
import { limitReply, type BotDeps, type Composer } from "./compose.js";
import { FIXTURES } from "./fixtures.js";
import { buildInspectSpec } from "./inspect.js";
import { aboutSpec, gallerySpec, homeSpec, playgroundSpec } from "./screens.js";

export interface CommandDeps {
  bot: BotDeps;
  composer: Composer;
  repoUrl: string;
}

export const BOT_COMMANDS = [
  { command: "start", description: "Home — what this bot does" },
  { command: "demo", description: "Guided demo: a live order card" },
  { command: "examples", description: "Browse 5 example fixtures" },
  { command: "play", description: "Paste your own JSON" },
  { command: "inspect", description: "How the last render was decided" },
  { command: "reset", description: "Clear this chat's session" },
  { command: "about", description: "About gram-render" },
  { command: "help", description: "Same as /about" },
];

/** Below gram-render's 8 000-char evaluator cap, so context always reaches JEV. */
const JSON_MAX_CHARS = 6000;
const PROMPT_MAX_CHARS = 4000; // ComposeOptions.prompt limit

export async function registerCommands(tg: BotDeps["tg"]): Promise<void> {
  await tg.call("setMyCommands", { commands: BOT_COMMANDS });
}

export function createCommands(deps: CommandDeps): {
  handleMessage(chatId: number, text: string): Promise<void>;
} {
  const tg = deps.bot.tg;

  async function sendScreen(chatId: number, spec: GramSpec): Promise<void> {
    try {
      await tg.send(chatId, compileClassicMessage(spec));
    } catch (error) {
      console.error("[screen]", error);
    }
  }

  return {
    async handleMessage(chatId, text) {
      const state = deps.bot.sessions.stateOf(chatId);
      const trimmed = text.trim();

      if (trimmed.startsWith("/")) {
        const command = trimmed.split(/\s+/)[0]!.toLowerCase();
        switch (command) {
          case "/start":
            await sendScreen(chatId, homeSpec(deps.repoUrl));
            return;
          case "/demo": {
            deps.composer.loadFixture(chatId, "order");
            const outcome = deps.composer.enqueue(chatId, () =>
              deps.composer.composeFresh(chatId, FIXTURES["order"]!.prompt, "inspect"),
            );
            if (outcome.status !== "started") await tg.reply(chatId, limitReply(outcome));
            return;
          }
          case "/examples":
            await sendScreen(chatId, gallerySpec());
            return;
          case "/play":
            await sendScreen(chatId, playgroundSpec());
            return;
          case "/inspect":
            if (!state.lastRender) {
              await tg.reply(chatId, "Run a render first — /demo or /examples, then /inspect explains the most recent one.");
              return;
            }
            await sendScreen(chatId, buildInspectSpec(state.lastRender));
            return;
          case "/reset": {
            if (state.trayMessageId != null) await tg.deleteMessage(chatId, state.trayMessageId);
            deps.bot.sessions.reset(chatId);
            await tg.reply(chatId, "Cleared. Send /start for the home screen.");
            return;
          }
          case "/about":
          case "/help":
            await sendScreen(chatId, aboutSpec());
            return;
          default:
            await tg.reply(chatId, "Unknown command — /about lists everything I understand.");
            return;
        }
      }

      // --- playground: a JSON object pasted as a message ---
      if (trimmed.startsWith("{")) {
        if (trimmed.length > JSON_MAX_CHARS) {
          await tg.reply(chatId, `That's ${trimmed.length} characters — keep JSON under 6 000.`);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          await tg.reply(chatId, "That didn't parse as JSON — send /play for the rules.");
          return;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          await tg.reply(chatId, "Send a single JSON object (not an array).");
          return;
        }
        state.context = parsed as Record<string, unknown>;
        state.spec = null;
        state.messageId = null;
        state.fixtureId = null;
        deps.bot.sessions.markDirty();
        const keys = Object.keys(state.context);
        await tg.reply(
          chatId,
          `Loaded — ${keys.length} top-level key(s): ${keys.slice(0, 6).join(", ")}${
            keys.length > 6 ? ", …" : ""
          }. Type any prompt to render it, e.g. "Show a compact overview." (/inspect explains each render.)`,
        );
        return;
      }

      // --- free text: an edit when a view exists, a fresh compose otherwise ---
      const prompt = trimmed.slice(0, PROMPT_MAX_CHARS);
      const outcome = deps.composer.enqueue(chatId, async () => {
        await deps.composer.applyEdit(chatId, prompt);
      });
      if (outcome.status !== "started") await tg.reply(chatId, limitReply(outcome));
    },
  };
}
