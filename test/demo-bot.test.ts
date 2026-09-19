/**
 * Demo-bot unit tests — pure modules only: concurrency primitives, fixtures,
 * screens, and the /inspect panel builder. No network, no JEV, no Telegram.
 */

import { describe, expect, it } from "vitest";
import {
  deriveCandidates,
  inspectClassicMessage,
  inspectRichMessage,
  parseGramSpec,
} from "../src/index.js";
import type { CompositionStep, GramSpec } from "../src/index.js";
import {
  applyFixtureAction,
  FIXTURES,
  FIXTURE_IDS,
  KNOWN_ACTIONS,
} from "../examples/demo-bot/fixtures.js";
import { buildInspectSpec } from "../examples/demo-bot/inspect.js";
import {
  createChatQueues,
  createRateLimiter,
  createSemaphore,
} from "../examples/demo-bot/queue.js";
import {
  aboutSpec,
  callbackBytes,
  gallerySpec,
  homeSpec,
  howSpec,
  inspectTraySpec,
  playgroundSpec,
} from "../examples/demo-bot/screens.js";
import type { LastRender } from "../examples/demo-bot/session.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("demo-bot queue primitives", () => {
  it("semaphore caps concurrent holders and hands slots off FIFO", async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    await sem.acquire();
    const order: string[] = [];
    const c = sem.acquire().then(() => order.push("c"));
    const d = sem.acquire().then(() => order.push("d"));
    expect(sem.pending).toBe(2);
    sem.release();
    await c;
    sem.release();
    await d;
    expect(order).toEqual(["c", "d"]);
    sem.release();
    sem.release();
    expect(sem.pending).toBe(0);
  });

  it("chat queues serialize per chat and survive a thrown task", async () => {
    const queues = createChatQueues();
    const events: string[] = [];
    const slow = queues.run(1, async () => {
      await delay(20);
      events.push("slow-1");
      return "s";
    });
    const fast = queues.run(1, async () => {
      events.push("fast-1");
      return "f";
    });
    const boom = queues.run(1, async () => {
      events.push("boom-1");
      throw new Error("boom");
    });
    const after = queues.run(1, async () => {
      events.push("after-1");
      return "a";
    });
    const other = queues.run(2, async () => {
      events.push("other-2");
      return "o";
    });
    await Promise.allSettled([slow, fast, boom, after, other]);
    // Chat 2 runs concurrently; isolate chat 1's stream.
    const chat1 = events.filter((event) => !event.endsWith("-2"));
    // Chat 1 runs strictly in submit order despite the delayed first task.
    expect(chat1).toEqual(["slow-1", "fast-1", "boom-1", "after-1"]);
    expect(events).toContain("other-2");
    await expect(boom).rejects.toThrow("boom"); // caller sees the failure…
    expect(await after).toBe("a"); // …but the queue keeps going
    expect(await other).toBe("o");
  });

  it("rate limiter enforces gap, hourly quota, and prunes old entries", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter({ minGapMs: 1000, maxPerHour: 3 }, () => t);
    expect(limiter.check(1)).toEqual({ ok: true });
    limiter.record(1);
    expect(limiter.check(1)).toEqual({ ok: false, reason: "gap", retryAfterMs: 1000 });
    t += 999;
    expect(limiter.check(1).ok).toBe(false);
    t += 1;
    expect(limiter.check(1)).toEqual({ ok: true });
    limiter.record(1);
    t += 1000;
    limiter.record(1); // third start within the hour
    t += 1000;
    const quota = limiter.check(1);
    expect(quota.ok).toBe(false);
    if (!quota.ok) {
      expect(quota.reason).toBe("quota");
      expect(quota.retryAfterMs).toBeGreaterThan(0);
    }
    // A different chat is unaffected.
    expect(limiter.check(2)).toEqual({ ok: true });
    // Once the hour rolls over, the window is pruned and the chat resets.
    t += 3_600_000;
    expect(limiter.check(1)).toEqual({ ok: true });
  });
});

describe("demo-bot fixtures", () => {
  it("keeps every fixture action within Telegram's 64-byte callback_data limit", () => {
    for (const id of FIXTURE_IDS) {
      const context = FIXTURES[id].context();
      const actions = context["actions"] as Array<{ action: string; payload: Record<string, unknown> }>;
      for (const action of actions) {
        expect(callbackBytes(action.action, action.payload), action.action).toBeLessThanOrEqual(64);
      }
    }
  });

  it("exposes every fixture action in KNOWN_ACTIONS and vice versa", () => {
    for (const id of FIXTURE_IDS) {
      const context = FIXTURES[id].context();
      const actions = context["actions"] as Array<{ action: string }>;
      for (const action of actions) {
        expect(KNOWN_ACTIONS[action.action]).toBe(id);
      }
    }
  });

  it("context() returns a fresh, unshared deep copy", () => {
    const a = FIXTURES.order.context();
    const b = FIXTURES.order.context();
    expect(a).toEqual(b);
    (a["order"] as Record<string, unknown>)["status"] = "cancelled";
    expect((b["order"] as Record<string, unknown>)["status"]).toBe("processing");
  });

  it("applies order actions and returns null for unknown or cross-fixture actions", () => {
    const ctx = FIXTURES.order.context();
    expect(applyFixtureAction(ctx, "mark_packed", {})).toBe("Packed ✓");
    const order = ctx["order"] as Record<string, unknown>;
    expect(order["status"]).toBe("packed");
    expect((order["delivery"] as Record<string, unknown>)["note"]).toContain("Packed");
    expect(applyFixtureAction(ctx, "cancel_order", {})).toBe("Order cancelled");
    expect(ctx["actions"]).toEqual([]);

    const incident = FIXTURES.incident.context();
    expect(applyFixtureAction(incident, "ack_incident", {})).toBe("Acknowledged ✓");
    expect(applyFixtureAction(incident, "resolve_incident", {})).toBe("Resolved ✓");

    const deploy = FIXTURES.deploy.context();
    expect(applyFixtureAction(deploy, "promote_build", {})).toBe("Promoted to production ✓");
    expect(applyFixtureAction(deploy, "rollback_build", {})).toBe("Rolled back");

    const usage = FIXTURES.usage.context();
    expect(applyFixtureAction(usage, "export_report", {})).toBe("Export queued");
    expect(usage["export"]).toEqual({ status: "queued", range: "30d", format: "csv" });

    const ticket = FIXTURES.ticket.context();
    expect(applyFixtureAction(ticket, "close_ticket", {})).toBe("Ticket closed ✓");
    expect(applyFixtureAction(ticket, "escalate_ticket", {})).toBe("Escalated to Tier 2");

    // Unknown action, wrong fixture, missing data — all unhandled.
    expect(applyFixtureAction(FIXTURES.order.context(), "nuclear_launch", {})).toBeNull();
    expect(applyFixtureAction(FIXTURES.order.context(), "close_ticket", {})).toBeNull();
    expect(applyFixtureAction({}, "mark_packed", {})).toBeNull();
  });
});

describe("demo-bot screens", () => {
  const SCREENS: Array<[string, () => GramSpec]> = [
    ["home", () => homeSpec("https://www.npmjs.com/package/gram-render")],
    ["gallery", gallerySpec],
    ["how", howSpec],
    ["about", aboutSpec],
    ["playground", playgroundSpec],
    ["inspect-tray", inspectTraySpec],
  ];

  it("every screen parses and compiles to classic with zero diagnostics", () => {
    for (const [name, make] of SCREENS) {
      const spec = make();
      expect(() => parseGramSpec(spec), name).not.toThrow();
      const { diagnostics } = inspectClassicMessage(spec);
      expect(diagnostics.errors, `${name}: ${diagnostics.errors[0]?.message ?? ""}`).toEqual([]);
      expect(diagnostics.warnings, `${name}: ${diagnostics.warnings[0] ?? ""}`).toEqual([]);
    }
  });

  it("keeps every screen callback button within the 64-byte limit", () => {
    for (const [name, make] of SCREENS) {
      for (const element of Object.values(make().elements)) {
        const props = element.props as Record<string, unknown>;
        if (element.type === "Button" && typeof props["action"] === "string") {
          const payload = props["payload"] as Record<string, unknown> | undefined;
          expect(callbackBytes(props["action"], payload), `${name}: ${props["action"]}`).toBeLessThanOrEqual(64);
        }
      }
    }
  });
});

describe("demo-bot /inspect panel", () => {
  it("resolves real derived option descriptions and stays under 4096 chars", () => {
    const context = FIXTURES.order.context();
    const prompt = FIXTURES.order.prompt;
    const { questions } = deriveCandidates(prompt, context);
    const question = questions.find((candidate) => candidate.options.length > 0)!;
    const option = question.options[0]!;

    const steps: CompositionStep[] = [
      {
        index: 0,
        kind: "select",
        description: "Select content",
        confidence: 0.9,
        answers: {
          [question.key]: { choice: option.id, confidence: 0.9, probabilities: { [option.id]: 0.9 } },
        },
        elapsedMs: 900,
        inputTokens: 1234,
      },
      {
        index: 1,
        kind: "layout",
        description: "Order and group blocks",
        confidence: 0.75,
        elapsedMs: 800,
        inputTokens: 2345,
      },
    ];
    const lastRender: LastRender = {
      mode: "compose",
      prompt,
      context,
      spec: homeSpec("https://www.npmjs.com/package/gram-render"),
      steps,
      calls: 2,
      elapsedMs: 1700,
      inputTokens: 3579,
      warnings: ["Context exceeded 8000 chars — trimmed."],
      at: 0,
    };

    const spec = buildInspectSpec(lastRender);
    expect(() => parseGramSpec(spec)).not.toThrow();
    const text = JSON.stringify(spec);
    // The chosen option id was resolved back to its human description.
    expect(text).toContain(option.description);
    // The never-authors property is stated, not implied.
    expect(text).toContain("JEV only chose among these pre-derived options");
    // Both compile targets get a diagnostics line (clean → "ok").
    expect(text).toContain("classic: ok");
    expect(text).toContain("rich: ok");
    expect(inspectRichMessage(spec).diagnostics.errors).toEqual([]);
    expect(text.length).toBeLessThan(4096);
  });
});
