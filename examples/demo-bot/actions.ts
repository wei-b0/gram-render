/**
 * Callback router — every inline-keyboard tap the bot can emit. Navigation
 * and previews are fast (no JEV); fixture actions run the consumer-owned
 * mutation (fixtures.applyFixtureAction) and then re-render through
 * gram-render. Unknown actions get the education toast: intent belongs to
 * the consumer's callback handler, never to the library.
 */

import { compileClassicMessage } from "../../src/index.js";
import type { GramSpec } from "../../src/index.js";
import type { BotDeps, Composer, EnqueueOutcome } from "./compose.js";
import { compileOutgoing, limitReply } from "./compose.js";
import { applyFixtureAction, FIXTURES, KNOWN_ACTIONS, orderSample, type FixtureId } from "./fixtures.js";
import { buildInspectSpec } from "./inspect.js";
import { aboutSpec, gallerySpec, homeSpec, howSpec, playgroundSpec } from "./screens.js";
import type { SessionStore } from "./session.js";
import type { TelegramApi } from "./tg.js";

export interface CallbackQuery {
  id: string;
  data?: string;
  message?: { message_id?: number };
}

export interface ActionDeps {
  bot: BotDeps;
  composer: Composer;
  repoUrl: string;
}

function educationToast(action: string): string {
  return `"${action}" is your app's action — gram-render only records intent; your callback handler would execute it. See /about.`;
}

export function createActions(deps: ActionDeps): {
  handleCallback(chatId: number, query: CallbackQuery): Promise<void>;
} {
  const tg: TelegramApi = deps.bot.tg;
  const sessions: SessionStore = deps.bot.sessions;

  async function showScreen(chatId: number, messageId: number | undefined, spec: GramSpec): Promise<void> {
    const payload = compileOutgoing(spec); // rich by default; classic fallback already handled
    if (messageId != null) {
      try {
        await tg.edit(chatId, messageId, payload);
        return;
      } catch (error) {
        console.error("[nav edit]", error); // e.g. screen message older than 48 h
      }
    }
    try {
      await tg.send(chatId, payload);
    } catch (error) {
      console.error("[nav send]", error);
    }
  }

  /** Compose a freshly loaded fixture, with the inspect tray. */
  function loadAndRender(chatId: number, id: FixtureId, query: CallbackQuery): Promise<void> {
    deps.composer.loadFixture(chatId, id);
    const fixture = FIXTURES[id];
    const outcome = deps.composer.enqueue(chatId, async () => {
      await deps.composer.composeFresh(chatId, fixture.prompt, "inspect");
      await tg.answer(query.id, `Loaded ${fixture.title} — type any prompt to edit it.`);
    });
    return settle(query, outcome);
  }

  function settle(query: CallbackQuery, outcome: EnqueueOutcome): Promise<void> {
    if (outcome.status === "busy") return tg.answer(query.id, "Still working on it…");
    if (outcome.status === "limited") {
      return tg.answer(query.id, limitReply(outcome));
    }
    return Promise.resolve(); // started — the task answers with the final toast
  }

  return {
    async handleCallback(chatId, query) {
      const state = sessions.stateOf(chatId);
      const messageId = query.message?.message_id;

      let action = query.data ?? "";
      let payload: Record<string, unknown> = {};
      const decoded: unknown = (() => {
        try {
          return JSON.parse(query.data ?? "");
        } catch {
          return undefined;
        }
      })();
      if (Array.isArray(decoded) && typeof decoded[0] === "string") {
        action = decoded[0]!;
        payload = (decoded[1] ?? {}) as Record<string, unknown>;
      }

      // --- navigation screens (fast; edit the tapped message in place) ---
      if (action === "nav_home") {
        await showScreen(chatId, messageId, homeSpec(deps.repoUrl));
        await tg.answer(query.id);
        return;
      }
      if (action === "nav_how") {
        await showScreen(chatId, messageId, howSpec());
        await tg.answer(query.id);
        return;
      }
      if (action === "nav_about") {
        await showScreen(chatId, messageId, aboutSpec());
        await tg.answer(query.id);
        return;
      }
      if (action === "nav_examples") {
        await showScreen(chatId, messageId, gallerySpec());
        await tg.answer(query.id);
        return;
      }
      if (action === "nav_play") {
        await showScreen(chatId, messageId, playgroundSpec());
        await tg.answer(query.id);
        return;
      }

      // --- guided demo + gallery ---
      if (action === "nav_demo") {
        await loadAndRender(chatId, "order", query);
        return;
      }
      if (action.startsWith("ex_")) {
        const id = action.slice(3) as FixtureId;
        if (id in FIXTURES) {
          await loadAndRender(chatId, id, query);
          return;
        }
      }

      // --- playground ---
      if (action === "pg_sample") {
        state.context = orderSample();
        state.spec = null;
        state.messageId = null;
        state.fixtureId = null;
        sessions.markDirty();
        await tg.answer(query.id, "Sample loaded — type any prompt to render your data, e.g. \"Show a compact overview.\"");
        return;
      }

      // --- inspect ---
      if (action === "nav_inspect") {
        if (!state.lastRender) {
          await tg.answer(query.id, "Run a render first — /inspect explains the most recent one.");
          return;
        }
        await showScreen(chatId, messageId, buildInspectSpec(state.lastRender));
        await tg.answer(query.id);
        return;
      }
      if (action === "insp_classic") {
        if (!state.spec) {
          await tg.answer(query.id, "Nothing rendered yet — run the demo first.");
          return;
        }
        try {
          await tg.send(chatId, compileClassicMessage(state.spec));
          await tg.answer(query.id, "Classic preview sent — same spec, HTML parse_mode.");
        } catch (error) {
          console.error("[classic preview]", error);
          await tg.answer(query.id, "Classic send failed — try again in a moment.");
        }
        return;
      }

      // --- fixture actions (consumer-owned state mutation + re-render) ---
      const fixtureId = KNOWN_ACTIONS[action];
      if (fixtureId && state.fixtureId === fixtureId) {
        const outcome = deps.composer.enqueue(chatId, async () => {
          const label = applyFixtureAction(state.context, action, payload);
          if (!label) {
            await tg.answer(query.id, educationToast(action));
            return;
          }
          await deps.composer.reRender(chatId);
          await tg.answer(query.id, label);
        });
        await settle(query, outcome);
        return;
      }

      // --- everything else ---
      await tg.answer(query.id, educationToast(action));
    },
  };
}
