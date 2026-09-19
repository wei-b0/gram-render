import { describe, expect, it } from "vitest";
import { render } from "../src/index.js";
import type { GramSpec } from "../src/spec/schema.js";
import { sequenceEvaluator } from "./fake-evaluator.js";
import { agentSpec } from "./tree.test.js";

const AGENTS = [
  { name: "cart-resolver", status: "running", uptime: "3h 12m", tasks_done: 142 },
  { name: "mail-digest", status: "degraded", uptime: "0h 44m", tasks_done: 9 },
];

function edit(choices: string[], overrides: Record<string, unknown> = {}) {
  const evaluate = sequenceEvaluator(choices);
  const promise = render({
    prompt: "Edit the message.",
    context: { agents: AGENTS },
    initialSpec: agentSpec(),
    evaluate,
    ...overrides,
  });
  return { promise, evaluate };
}

describe("render (edit mode)", () => {
  it("removes an element and keeps everything else stable", async () => {
    const { promise, evaluate } = edit(["remove:h1"]);
    const result = await promise;

    expect(result.stopReason).toBe("finish");
    expect(result.calls).toBe(2); // remove + finish
    const spec = result.spec as GramSpec;
    expect(spec.elements["h1"]).toBeUndefined();
    expect(spec.elements["m1"]!.children).toEqual(["s1", "st1"]);
    // Unaffected elements keep ids and props.
    expect(spec.elements["s1"]).toMatchObject({ type: "Section", props: { title: "cart-resolver" } });
    expect(spec.elements["b2"]!.props).toMatchObject({ label: "View logs" });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.kind).toBe("edit");
    expect(result.steps[0]!.description).toContain("Removed");
  });

  it("replaces in two phases and keeps the element's slot", async () => {
    const { promise } = edit(["replace:b1", "btn_help"], { prompt: 'Swap the Refresh button for "Help".' });
    const result = await promise;

    const spec = result.spec as GramSpec;
    expect(result.calls).toBe(3); // replace + replacement + finish
    // Same id, new content, still in its row.
    expect(spec.elements["b1"]!.type).toBe("Button");
    expect(spec.elements["b1"]!.props).toMatchObject({ label: "Help", action: "help" });
    expect(spec.elements["r1"]!.children).toEqual(["b1", "b2"]);
    expect(result.steps.map((step) => step.description)).toEqual([
      expect.stringContaining("replacement"),
      expect.stringContaining("Replaced"),
    ]);
  });

  it("replaces a section with another section, preserving its children", async () => {
    const { promise } = edit(["replace:s1", "sec_agents_2"]);
    const result = await promise;

    const spec = result.spec as GramSpec;
    const s1 = spec.elements["s1"]!;
    expect(s1.type).toBe("Section");
    expect(s1.props).toMatchObject({ title: "mail-digest" });
    expect(s1.children).toEqual(["f1", "st2"]); // old children kept
  });

  it("replaces with remove as the second-phase fallback", async () => {
    const { promise } = edit(["replace:st1", "remove"]);
    const result = await promise;

    const spec = result.spec as GramSpec;
    expect(spec.elements["st1"]).toBeUndefined();
    expect(spec.elements["m1"]!.children).toEqual(["h1", "s1"]);
  });

  it("moves a button within the keyboard", async () => {
    const { promise } = edit(["move:b2", "mv:r1:before:b1"]);
    const result = await promise;

    const spec = result.spec as GramSpec;
    expect(spec.elements["r1"]!.children).toEqual(["b2", "b1"]);
    expect(spec.elements["m1"]!.keyboard).toEqual(["r1"]);
  });

  it("adds a derived block and a button", async () => {
    const { promise } = edit(["add:heading:h_agents", "add:btn_help:use_btn_help"], {
      prompt: 'Add a heading Agents and a "Help" button.',
    });
    const result = await promise;

    const spec = result.spec as GramSpec;
    // Fresh ids continue past the seed spec's ids (h1/s1/... → n1, n2).
    expect(spec.elements["n1"]!.type).toBe("Heading");
    expect(spec.elements["m1"]!.children).toEqual(["h1", "s1", "st1", "n1"]);
    // Buttons attach to the last row while it has room (< 4 buttons).
    expect(spec.elements["n2"]!.type).toBe("Button");
    expect(spec.elements["r1"]!.children).toEqual(["b1", "b2", "n2"]);
  });

  it("hides add options once the element budget is spent", async () => {
    const { promise, evaluate } = edit(["add:heading:h_agents"], { limits: { maxElements: 10 } });
    await promise;

    // After the add, 10/10 elements are used: the second call must not offer adds.
    const secondCall = evaluate.calls[1]!;
    expect(Object.keys(secondCall.questions["next"]!.criteria).filter((key) => key.startsWith("add:"))).toEqual([]);
  });

  it("stops with 'limit' when maxSteps is exhausted", async () => {
    const { promise, evaluate } = edit(["move:h1", "mv:m1:before:s1", "move:h1"], { limits: { maxSteps: 3 } });
    const result = await promise;

    expect(result.stopReason).toBe("limit");
    expect(result.calls).toBe(3);
    expect(evaluate.calls).toHaveLength(3);
  });

  it("reports unavailable without mutating the spec", async () => {
    const { promise } = edit(["unavailable"]);
    const result = await promise;

    expect(result.stopReason).toBe("unavailable");
    expect(result.spec).toEqual(agentSpec());
    expect(result.steps).toHaveLength(0);
  });

  it("includes the pending operation in the follow-up state", async () => {
    const { promise, evaluate } = edit(["replace:b1", "btn_refresh"]);
    await promise;

    const secondState = evaluate.calls[1]!.state;
    expect(secondState["pending_operation"]).toMatchObject({ operation: "replace" });
  });
});
