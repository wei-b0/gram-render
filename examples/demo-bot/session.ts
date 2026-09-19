/**
 * Per-chat session state for the demo bot: what data is loaded, the current
 * spec/message, the last render record (for /inspect), and idle TTL with a
 * debounced JSON snapshot so a restart doesn't wipe live demos.
 *
 * The snapshot is a development convenience, not a database — it lives at
 * `.bot-sessions.json` (gitignored) and tolerates corrupt entries.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CompositionStep, GramSpec } from "../../src/index.js";

/** How long a chat stays warm without any activity. */
export const SESSION_TTL_MS = 6 * 3_600_000;

/** One JEV render as recorded for /inspect (context frozen at render time). */
export interface LastRender {
  mode: "compose" | "edit" | "action";
  prompt: string;
  context: Record<string, unknown>;
  spec: GramSpec;
  steps: CompositionStep[];
  calls: number;
  elapsedMs: number;
  inputTokens: number | null;
  warnings: string[];
  at: number;
}

export interface ChatState {
  /** Consumer-owned application data — the bot mutates it on fixture actions. */
  context: Record<string, unknown>;
  spec: GramSpec | null;
  messageId: number | null;
  /** The small "Inspect last render" message that follows demo renders. */
  trayMessageId: number | null;
  fixtureId: string | null;
  lastRender: LastRender | null;
  /** A render task is queued or running (coalesces duplicate triggers). */
  pendingRender: boolean;
  updatedAt: number;
}

function freshState(now: number): ChatState {
  return {
    context: {},
    spec: null,
    messageId: null,
    trayMessageId: null,
    fixtureId: null,
    lastRender: null,
    pendingRender: false,
    updatedAt: now,
  };
}

export interface SessionStore {
  stateOf(chatId: number): ChatState;
  reset(chatId: number): void;
  markDirty(): void;
  /** Write the snapshot immediately (shutdown path). */
  flush(): void;
  load(): void;
  startSweep(): void;
  dispose(): void;
}

interface PersistedChat {
  context: Record<string, unknown>;
  spec: GramSpec | null;
  messageId: number | null;
  trayMessageId: number | null;
  fixtureId: string | null;
  lastRender: LastRender | null;
  updatedAt: number;
}

interface Snapshot {
  version: 2;
  savedAt: string;
  chats: Record<string, PersistedChat>;
}

/** Drop probability maps (the bulky part; not needed after a restart). */
function slimSteps(steps: CompositionStep[]): CompositionStep[] {
  return steps.map((step) => ({
    ...step,
    answers: step.answers
      ? Object.fromEntries(
          Object.entries(step.answers).map(([key, answer]) => [
            key,
            { choice: answer.choice, confidence: answer.confidence },
          ]),
        )
      : undefined,
  }));
}

export function createSessionStore(sessionPath: string, now: () => number = Date.now): SessionStore {
  const chats = new Map<number, ChatState>();
  let dirty = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let sweeper: ReturnType<typeof setInterval> | null = null;

  function persist(): void {
    const snapshot: Snapshot = { version: 2, savedAt: new Date().toISOString(), chats: {} };
    for (const [chatId, state] of chats) {
      snapshot.chats[String(chatId)] = {
        context: state.context,
        spec: state.spec,
        messageId: state.messageId,
        trayMessageId: state.trayMessageId,
        fixtureId: state.fixtureId,
        lastRender: state.lastRender
          ? { ...state.lastRender, steps: slimSteps(state.lastRender.steps) }
          : null,
        updatedAt: state.updatedAt,
      };
    }
    const tmp = `${sessionPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, sessionPath);
  }

  return {
    stateOf(chatId) {
      let state = chats.get(chatId);
      if (!state) {
        state = freshState(now());
        chats.set(chatId, state);
      }
      state.updatedAt = now();
      return state;
    },
    reset(chatId) {
      chats.delete(chatId);
      this.markDirty();
    },
    markDirty() {
      dirty = true;
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (!dirty) return;
        dirty = false;
        try {
          persist();
        } catch (error) {
          console.error("[sessions] snapshot failed:", error);
        }
      }, 2000);
      debounce.unref?.();
    },
    flush() {
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      if (!dirty) return;
      dirty = false;
      try {
        persist();
      } catch (error) {
        console.error("[sessions] flush failed:", error);
      }
    },
    load() {
      let raw: string;
      try {
        raw = readFileSync(sessionPath, "utf8");
      } catch {
        return;
      }
      let snapshot: Snapshot;
      try {
        snapshot = JSON.parse(raw) as Snapshot;
      } catch {
        console.warn("[sessions] snapshot unreadable — starting fresh");
        return;
      }
      if (snapshot.version !== 2) {
        console.warn(`[sessions] snapshot version ${String((snapshot as { version?: number }).version)} is from an older build — starting fresh`);
        return;
      }
      for (const [chatId, saved] of Object.entries(snapshot.chats ?? {})) {
        try {
          chats.set(Number(chatId), { ...freshState(saved.updatedAt), ...saved, pendingRender: false });
        } catch {
          // skip corrupt entries
        }
      }
    },
    startSweep() {
      sweeper = setInterval(() => {
        const cutoff = now() - SESSION_TTL_MS;
        for (const [chatId, state] of chats) {
          if (state.updatedAt < cutoff) chats.delete(chatId);
        }
      }, 15 * 60_000);
      sweeper.unref?.();
    },
    dispose() {
      if (sweeper) clearInterval(sweeper);
      if (debounce) clearTimeout(debounce);
    },
  };
}
