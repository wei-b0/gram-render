/**
 * Pure concurrency primitives for the demo bot: a counting semaphore that
 * caps global JEV renders, per-chat FIFO task queues, and a per-chat rate
 * limiter. No Telegram, no timers of their own — `now` is injectable so tests
 * can drive the clock.
 */

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  /** Tasks waiting for a slot. */
  readonly pending: number;
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (active < limit && waiters.length === 0) {
        active++;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release(): void {
      const next = waiters.shift();
      if (next) {
        next(); // hand the slot straight to the next waiter
      } else if (active > 0) {
        active--;
      }
    },
    get pending(): number {
      return waiters.length;
    },
  };
}

export interface ChatQueues {
  /** Run `task` in FIFO order relative to other tasks for the same chat. */
  run<T>(chatId: number, task: () => Promise<T>): Promise<T>;
}

export function createChatQueues(): ChatQueues {
  const tails = new Map<number, Promise<unknown>>();
  return {
    run<T>(chatId: number, task: () => Promise<T>): Promise<T> {
      const tail = tails.get(chatId) ?? Promise.resolve();
      // Run the task whether the previous one resolved or rejected; the
      // stored tail swallows the error so one failure never blocks the next.
      const result = tail.then(task, task);
      tails.set(chatId, result.catch(() => undefined));
      return result;
    },
  };
}

export interface RateLimitOptions {
  /** Minimum gap between two render starts for one chat (ms). */
  minGapMs: number;
  /** Maximum render starts per chat in a trailing hour. */
  maxPerHour: number;
}

export type RateCheck = { ok: true } | { ok: false; reason: "gap" | "quota"; retryAfterMs: number };

export interface RateLimiter {
  check(chatId: number): RateCheck;
  record(chatId: number): void;
}

const HOUR_MS = 3_600_000;

export function createRateLimiter(options: RateLimitOptions, now: () => number = Date.now): RateLimiter {
  const windows = new Map<number, number[]>();
  const windowOf = (chatId: number): number[] => {
    const cutoff = now() - HOUR_MS;
    const window = (windows.get(chatId) ?? []).filter((t) => t > cutoff);
    windows.set(chatId, window);
    return window;
  };
  return {
    check(chatId: number): RateCheck {
      const window = windowOf(chatId);
      const last = window.at(-1);
      if (last !== undefined) {
        const elapsed = now() - last;
        if (elapsed < options.minGapMs) {
          return { ok: false, reason: "gap", retryAfterMs: options.minGapMs - elapsed };
        }
      }
      if (window.length >= options.maxPerHour) {
        const oldest = window[0]!;
        return { ok: false, reason: "quota", retryAfterMs: Math.max(1000, oldest + HOUR_MS - now()) };
      }
      return { ok: true };
    },
    record(chatId: number): void {
      windowOf(chatId).push(now());
    },
  };
}
