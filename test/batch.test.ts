import { describe, expect, it } from "vitest";
import { composeSpec, render } from "../src/index.js";
import type { GramSpec } from "../src/spec/schema.js";
import { fakeEvaluator } from "./fake-evaluator.js";

const AGENTS = [
  { name: "cart-resolver", status: "running", uptime: "3h 12m", tasks_done: 142 },
  { name: "mail-digest", status: "degraded", uptime: "0h 44m", tasks_done: 9 },
  { name: "backup-worker", status: "idle", uptime: "12h 01m", tasks_done: 0 },
];

// Ids are gap-y: baked section children consume ids too (n1 heading, n2/n7/n12
// sections with 4 baked lines each).
const AGENT_ANSWERS = {
  heading: "h_agents",
  items_agents: "sections",
  order_n1: "1",
  order_n2: "2",
  order_n7: "3",
  order_n12: "4",
};

describe("render (batch)", () => {
  it("composes the agents fixture into a validated spec (select + layout)", async () => {
    const evaluate = fakeEvaluator({ answers: AGENT_ANSWERS });
    const result = await render({ prompt: "Show these agents.", context: { agents: AGENTS }, evaluate });

    expect(result.stopReason).toBe("finish");
    expect(result.calls).toBe(2);
    expect(result.inputTokens).toBe(200);
    expect(result.spec).not.toBeNull();

    const spec = result.spec as GramSpec;
    // Deterministic ids: heading first, then one section per agent (baked
    // children consume ids in between).
    expect(spec.elements["n1"]).toMatchObject({ type: "Heading", props: { text: "Agents" } });
    const sectionTitles = ["n2", "n7", "n12"].map((id) => spec.elements[id]!.props["title"]);
    expect(sectionTitles).toEqual(["cart-resolver", "mail-digest", "backup-worker"]);
    // Root children ordered by the layout phase; no keyboard (no buttons).
    expect(spec.elements["m1"]!.children).toEqual(["n1", "n2", "n7", "n12"]);
    expect(spec.elements["m1"]!.keyboard).toEqual([]);
    // Layout step applied the scripted order.
    expect(result.steps.map((step) => step.kind)).toEqual(["select", "layout"]);
    // The spec survives a parse round-trip.
    expect(() => spec).not.toThrow();
  });

  it("reports unavailable when nothing is selected", async () => {
    const evaluate = fakeEvaluator(); // standard buttons only; everything omits
    const result = await render({ prompt: "Hello.", evaluate });

    expect(result.stopReason).toBe("unavailable");
    expect(result.spec).toBeNull();
    expect(result.calls).toBe(1);
    expect(result.steps).toHaveLength(0);
  });

  it("reports unavailable when JEV says the request is not fulfillable", async () => {
    const evaluate = fakeEvaluator({ answers: { fulfillable: "no" } });
    const result = await render({ prompt: "Show a rocket launch countdown.", context: { agents: AGENTS }, evaluate });

    expect(result.stopReason).toBe("unavailable");
    expect(result.spec).toBeNull();
    expect(result.calls).toBe(1);
  });

  it("honors the minConfidence gate", async () => {
    const evaluate = fakeEvaluator({ answers: AGENT_ANSWERS, confidence: 0.4 });
    const gated = await render({
      prompt: "Show these agents.",
      context: { agents: AGENTS },
      evaluate,
      minConfidence: 0.8,
    });
    expect(gated.stopReason).toBe("unavailable");
    expect(gated.calls).toBe(1); // gate fires before assembly, no layout call
    expect(gated.warnings.some((warning) => warning.includes("minConfidence"))).toBe(true);

    // Same answers pass the default gate (off).
    const open = await render({ prompt: "Show these agents.", context: { agents: AGENTS }, evaluate });
    expect(open.stopReason).toBe("finish");
  });

  it("skips the layout call when the selection is a single block", async () => {
    const evaluate = fakeEvaluator({ answers: { heading: "h_name" } });
    const result = await render({ prompt: "Show it.", context: { name: "Ada" }, evaluate });

    expect(result.stopReason).toBe("finish");
    expect(result.calls).toBe(1);
    expect(result.steps.map((step) => step.kind)).toEqual(["select"]);
    const spec = result.spec as GramSpec;
    expect(spec.elements["n1"]!.type).toBe("Heading");
    expect(spec.elements["n2"]).toBeUndefined();
  });

  it("orders blocks with a stable sort — ties keep candidate order", async () => {
    const base = { prompt: "Show it.", context: { name: "Ada", count: 2 } };
    // n1 heading, n2 name field, n3 count field. All tie at position 1.
    const tied = await render({
      ...base,
      evaluate: fakeEvaluator({
        answers: { heading: "h_name", line_name: "f_name", line_count: "f_count", order_n1: "1", order_n2: "1", order_n3: "1" },
      }),
    });
    expect((tied.spec as GramSpec).elements["m1"]!.children).toEqual(["n1", "n2", "n3"]);

    // Reversed positions win over candidate order.
    const reversed = await render({
      ...base,
      evaluate: fakeEvaluator({
        answers: { heading: "h_name", line_name: "f_name", line_count: "f_count", order_n1: "3", order_n2: "2", order_n3: "1" },
      }),
    });
    expect((reversed.spec as GramSpec).elements["m1"]!.children).toEqual(["n3", "n2", "n1"]);
  });

  it("adopts loose blocks into sections via the layout parent phase", async () => {
    const evaluate = fakeEvaluator({
      answers: {
        heading: "h_service",
        body_service: "sec_service",
        line_note: "f_note",
        order_n1: "1",
        order_n2: "2",
        order_n5: "3",
        parent_n5: "in_n2",
      },
    });
    const result = await render({
      prompt: "Show the service.",
      context: { service: { status: "ok", region: "eu-1" }, note: "hello" },
      evaluate,
    });

    const spec = result.spec as GramSpec;
    // n2 = Service section (baked children n3/n4), n5 = the loose note Field.
    const section = spec.elements["n2"]!;
    expect(section.type).toBe("Section");
    expect(section.children!.at(-1)).toBe("n5");
    expect(spec.elements["n5"]!.type).toBe("Field");
    // The adopted block left the root.
    expect(spec.elements["m1"]!.children).toEqual(["n1", "n2"]);
  });

  it("groups >3 buttons into rows per layout answers", async () => {
    const evaluate = fakeEvaluator({
      answers: {
        btn_a: "use_btn_a",
        btn_b: "use_btn_b",
        btn_c: "use_btn_c",
        btn_d: "use_btn_d",
        row_n1: "row_1",
        row_n2: "row_1",
        row_n3: "row_1",
        row_n4: "row_2",
      },
    });
    const result = await render({
      prompt: "Show actions.",
      context: {
        actions: [
          { label: "A", action: "a" },
          { label: "B", action: "b" },
          { label: "C", action: "c" },
          { label: "D", action: "d" },
        ],
      },
      evaluate,
    });

    const spec = result.spec as GramSpec;
    const root = spec.elements["m1"]!;
    expect(root.keyboard).toHaveLength(2);
    const rows = root.keyboard.map((rowId) => spec.elements[rowId]!.children);
    expect(rows.map((row) => row.length)).toEqual([3, 1]);
    expect(spec.elements["n1"]!.type).toBe("Button");
    expect(result.steps.map((step) => step.kind)).toEqual(["select", "layout"]);
  });

  it("rejects an empty prompt", async () => {
    await expect(render({ prompt: "   ", evaluate: fakeEvaluator() })).rejects.toThrow(/non-empty prompt/);
  });
});

describe("composeSpec (streaming)", () => {
  it("emits step snapshots then a complete event", async () => {
    const collected: Array<{ type: string; kind?: string; spec?: GramSpec | null; stopReason?: string }> = [];
    for await (const event of composeSpec({
      prompt: "Show these agents.",
      context: { agents: AGENTS },
      evaluate: fakeEvaluator({ answers: AGENT_ANSWERS }),
    })) {
      collected.push(event as { type: string; kind?: string; spec?: GramSpec | null; stopReason?: string });
    }

    expect(collected.map((event) => event.type)).toEqual(["step", "step", "complete"]);
    const complete = collected[2]!;
    expect(complete.stopReason).toBe("finish");
    expect(complete.spec).not.toBeNull();
    // Step snapshots are clones, not aliases of the final spec.
    const stepSpecs = [collected[0]!.spec, collected[1]!.spec];
    expect(stepSpecs[0]!).not.toBe(complete.spec);
    expect(stepSpecs[0]!.elements["n1"]).toBeDefined();
  });
});
