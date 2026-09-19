/**
 * Composition wrapper — the seam between the consumer bot and gram-render.
 * Owns: rate limiting + coalescing at enqueue time, the global render
 * semaphore (held only around the JEV call), typing indicators, lastRender
 * recording for /inspect, send/edit with the 48-hour fallback, target
 * selection (Rich Messages by default, classic HTML fallback), and fixture
 * loading. gram-render stays a pure prompt+context → spec service here.
 */

import { compileClassicMessage, compileRichMessage, render } from "../../src/index.js";
import type { GramSpec, RenderResult } from "../../src/index.js";
import { FIXTURES, type FixtureId } from "./fixtures.js";
import type { ChatQueues, RateLimiter, Semaphore } from "./queue.js";
import type { ChatState, SessionStore } from "./session.js";
import { inspectTraySpec, type TrayKind } from "./screens.js";
import { TelegramApiError, type OutgoingPayload, type TelegramApi } from "./tg.js";

export const GENERIC_ERROR = "Something went wrong on my side — try again in a moment.";

export interface BotDeps {
  tg: TelegramApi;
  sessions: SessionStore;
  queues: ChatQueues;
  semaphore: Semaphore;
  rate: RateLimiter;
}

export type EnqueueOutcome =
  | { status: "started" }
  | { status: "busy" }
  | { status: "limited"; reason: "gap" | "quota"; retryAfterMs: number };

/** Human text for a rejected render, phrased for a message reply. */
export function limitReply(outcome: Extract<EnqueueOutcome, { status: "busy" | "limited" }>): string {
  if (outcome.status === "busy") return "One moment — your last render is still running.";
  const minutes = Math.max(1, Math.round(outcome.retryAfterMs / 60_000));
  return outcome.reason === "gap"
    ? "Renders are throttled — try again in a few seconds."
    : `Demo limit: 20 renders/hour — try again in ~${minutes} min.`;
}

export interface Composer {
  /** Queue a render task with coalescing + rate limiting (fire-and-forget). */
  enqueue(chatId: number, task: () => Promise<void>): EnqueueOutcome;
  /** Load a fixture into the session (no rendering). */
  loadFixture(chatId: number, id: FixtureId): void;
  composeFresh(chatId: number, prompt: string, tray?: TrayKind): Promise<void>;
  /** initialSpec edit with the user's prompt; falls back to fresh compose. */
  applyEdit(chatId: number, prompt: string): Promise<void>;
  /** Re-render the current fixture after a consumer action mutated state. */
  reRender(chatId: number): Promise<void>;
}

// --- target selection: Rich Messages by default (Bot API 10.1+), with an
// automatic fallback to classic HTML for tokens on an older Bot API. The
// flag flips only when sendRichMessage itself is unsupported, i.e. before
// any rich message exists, so edit targets stay consistent. ---

let richOk: boolean | null = null; // null = untested on this token

/** Compile a spec for sending/editing using the bot's current target. */
export function compileOutgoing(spec: GramSpec): OutgoingPayload {
  return richOk === false ? compileClassicMessage(spec) : compileRichMessage(spec);
}

function isRichUnsupported(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    error.method === "sendRichMessage" &&
    (/not found/i.test(error.description) || /not supported/i.test(error.description))
  );
}

export function createComposer(deps: BotDeps): Composer {
  const { tg, sessions, queues, semaphore, rate } = deps;

  /** Send a spec as a new message; falls back to classic on old Bot APIs. */
  async function sendSpec(chatId: number, spec: GramSpec): Promise<number> {
    const payload = compileOutgoing(spec);
    try {
      return await tg.send(chatId, payload);
    } catch (error) {
      if (isRichUnsupported(error)) {
        richOk = false;
        console.warn("[target] sendRichMessage unsupported on this token — falling back to classic HTML.");
        return await tg.send(chatId, compileClassicMessage(spec));
      }
      throw error;
    }
  }

  async function runComposition(
    chatId: number,
    prompt: string,
    initialSpec?: RenderResult["spec"],
  ): Promise<RenderResult | null> {
    const state = sessions.stateOf(chatId);
    try {
      return await tg.withTyping(chatId, async () => {
        await semaphore.acquire();
        try {
          return await render({
            prompt,
            context: state.context,
            ...(initialSpec ? { initialSpec } : {}),
          });
        } finally {
          semaphore.release();
        }
      });
    } catch (error) {
      console.error("[render]", error);
      await tg.reply(chatId, GENERIC_ERROR);
      return null;
    }
  }

  function recordLastRender(
    state: ChatState,
    mode: "compose" | "edit" | "action",
    prompt: string,
    result: RenderResult,
  ): void {
    if (!result.spec) return;
    state.lastRender = {
      mode,
      prompt,
      context: structuredClone(state.context),
      spec: result.spec,
      steps: result.steps,
      calls: result.calls,
      elapsedMs: result.elapsedMs,
      inputTokens: result.inputTokens,
      warnings: result.warnings,
      at: Date.now(),
    };
  }

  async function deliverSpec(chatId: number, state: ChatState, result: RenderResult): Promise<void> {
    if (state.messageId != null) {
      try {
        await tg.edit(chatId, state.messageId, compileOutgoing(result.spec!));
        return;
      } catch (error) {
        // >48 h or message gone — fall back to a fresh send.
        console.error("[edit fallback]", error);
      }
    }
    state.messageId = await sendSpec(chatId, result.spec!);
  }

  /** Send (or replace) the small "Inspect last render" tray message. */
  async function sendTray(chatId: number, state: ChatState): Promise<void> {
    if (state.trayMessageId != null) await tg.deleteMessage(chatId, state.trayMessageId);
    try {
      state.trayMessageId = await sendSpec(chatId, inspectTraySpec());
    } catch (error) {
      console.error("[tray]", error);
    }
  }

  return {
    enqueue(chatId, task) {
      const state = sessions.stateOf(chatId);
      if (state.pendingRender) return { status: "busy" };
      const check = rate.check(chatId);
      if (!check.ok) return { status: "limited", reason: check.reason, retryAfterMs: check.retryAfterMs };
      rate.record(chatId);
      state.pendingRender = true;
      void queues.run(chatId, async () => {
        try {
          await task();
        } finally {
          state.pendingRender = false;
          sessions.markDirty();
        }
      });
      return { status: "started" };
    },

    loadFixture(chatId, id) {
      const state = sessions.stateOf(chatId);
      state.context = FIXTURES[id].context();
      state.spec = null;
      state.messageId = null;
      state.fixtureId = id;
      sessions.markDirty();
    },

    async composeFresh(chatId, prompt, tray) {
      const state = sessions.stateOf(chatId);
      const result = await runComposition(chatId, prompt);
      if (!result || result.stopReason !== "finish" || !result.spec) {
        await tg.reply(
          chatId,
          `JEV couldn't compose a view from that (stopReason=${result?.stopReason ?? "error"}). Try rephrasing — or /start for the guided demo.`,
        );
        return;
      }
      recordLastRender(state, "compose", prompt, result);
      state.spec = result.spec;
      try {
        await deliverSpec(chatId, state, result);
      } catch (error) {
        console.error("[send]", error);
        await tg.reply(chatId, GENERIC_ERROR);
        return;
      }
      if (tray) await sendTray(chatId, state);
      sessions.markDirty();
    },

    async applyEdit(chatId, prompt) {
      const state = sessions.stateOf(chatId);
      if (!state.spec || state.messageId == null) {
        await this.composeFresh(chatId, prompt);
        return;
      }
      const result = await runComposition(chatId, prompt, state.spec);
      if (!result || result.stopReason !== "finish" || !result.spec) {
        await tg.reply(
          chatId,
          `JEV couldn't map that to an edit (stopReason=${result?.stopReason ?? "error"}). Rephrase, or /reset to start over.`,
        );
        return;
      }
      recordLastRender(state, "edit", prompt, result);
      state.spec = result.spec;
      try {
        await tg.edit(chatId, state.messageId, compileOutgoing(result.spec));
      } catch (error) {
        console.error("[edit fallback]", error);
        try {
          state.messageId = await sendSpec(chatId, result.spec);
        } catch (sendError) {
          console.error("[send]", sendError);
          await tg.reply(chatId, GENERIC_ERROR);
        }
      }
      sessions.markDirty();
    },

    async reRender(chatId) {
      const state = sessions.stateOf(chatId);
      const prompt =
        (state.fixtureId ? FIXTURES[state.fixtureId as FixtureId]?.prompt : undefined) ??
        state.lastRender?.prompt;
      if (!prompt) return;
      const result = await runComposition(chatId, prompt);
      if (!result || result.stopReason !== "finish" || !result.spec) return; // keep last good view
      recordLastRender(state, "action", prompt, result);
      state.spec = result.spec;
      try {
        await deliverSpec(chatId, state, result);
      } catch (error) {
        console.error("[re-render]", error);
      }
      sessions.markDirty();
    },
  };
}
