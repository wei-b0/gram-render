/**
 * Telegram transport for the demo bot — the only place a bot token is used.
 * This is CONSUMER code: gram-render (the library) never talks to Telegram.
 *
 * Hardening: 429 `retry_after` is obeyed (two retries), network errors get
 * 1/3/5 s backoff (three attempts), and "message is not modified" is treated
 * as success by `edit` (idempotent navigation taps).
 */

import type { ClassicMessage } from "../../src/compile/classic.js";
import type { RichMessagePayload } from "../../src/compile/rich.js";

/** A compiled gram-render payload, classic or rich — discriminated by `text`. */
export type OutgoingPayload = ClassicMessage | RichMessagePayload;

export class TelegramApiError extends Error {
  readonly method: string;
  readonly description: string;
  constructor(method: string, description: string) {
    super(`${method} failed: ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.description = description;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isClassic(payload: OutgoingPayload): payload is ClassicMessage {
  return "text" in payload;
}

/** Bot API body for sendMessage / editMessageText from a compiled payload. */
export function requestShape(payload: OutgoingPayload): Record<string, unknown> {
  if (isClassic(payload)) {
    return {
      text: payload.text,
      parse_mode: payload.parse_mode,
      ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
    };
  }
  return { rich_message: payload.rich_message };
}

export interface TelegramApi {
  call<T = any>(method: string, body?: Record<string, unknown>): Promise<T>;
  /** Send a compiled payload; resolves to the new message_id. */
  send(chatId: number, payload: OutgoingPayload): Promise<number>;
  /** Edit in place; "message is not modified" resolves silently. */
  edit(chatId: number, messageId: number, payload: OutgoingPayload): Promise<void>;
  reply(chatId: number, text: string): Promise<void>;
  /** Answer a callback query (the toast); stale queries fail silently. */
  answer(callbackQueryId: string, text?: string): Promise<void>;
  typing(chatId: number): Promise<void>;
  /** Keep a "typing…" indicator alive while `fn` runs. */
  withTyping<T>(chatId: number, fn: () => Promise<T>): Promise<T>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
}

export function createTg(token: string): TelegramApi {
  const base = `https://api.telegram.org/bot${token}`;

  async function call<T = any>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    let json: { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        json = (await res.json()) as typeof json;
      } catch (error) {
        if (attempt >= 2) throw error; // network: 3 attempts, 1/3/5 s backoff
        await sleep([1000, 3000, 5000][attempt]!);
        continue;
      }
      if (json.ok) return json.result as T;
      const retryAfter = json.parameters?.retry_after;
      if (typeof retryAfter === "number" && attempt < 2) {
        await sleep(Math.min(retryAfter + 1, 60) * 1000);
        continue;
      }
      throw new TelegramApiError(method, json.description ?? "unknown error");
    }
  }

  const isNotModified = (error: unknown): boolean =>
    error instanceof TelegramApiError && error.description.includes("message is not modified");

  return {
    call,
    async send(chatId, payload) {
      // Rich payloads go through sendRichMessage (Bot API 10.1+); classic
      // HTML through sendMessage. editMessageText edits both targets.
      const method = isClassic(payload) ? "sendMessage" : "sendRichMessage";
      const result = (await call(method, { chat_id: chatId, ...requestShape(payload) })) as {
        message_id: number;
      };
      return result.message_id;
    },
    async edit(chatId, messageId, payload) {
      try {
        await call("editMessageText", { chat_id: chatId, message_id: messageId, ...requestShape(payload) });
      } catch (error) {
        if (!isNotModified(error)) throw error;
      }
    },
    async reply(chatId, text) {
      await call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" }).catch(() => {});
    },
    async answer(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }).catch(
        () => {},
      );
    },
    async typing(chatId) {
      await call("sendChatAction", { chat_id: chatId, action: "typing" });
    },
    async withTyping(chatId, fn) {
      let done = false;
      void (async () => {
        while (!done) {
          await this.typing(chatId).catch(() => {});
          await sleep(4500); // Telegram typing indicators expire after ~5 s
        }
      })();
      try {
        return await fn();
      } finally {
        done = true;
      }
    },
    async deleteMessage(chatId, messageId) {
      await call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    },
  };
}
