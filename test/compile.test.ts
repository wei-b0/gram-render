import { describe, expect, it } from "vitest";
import {
  compileClassicMessage,
  escapeHtml,
  inspectClassicMessage,
  serializeCallbackData,
} from "../src/compile/classic.js";
import { telegramDiagnostics } from "../src/validate/telegram.js";
import type { GramSpec } from "../src/spec/schema.js";
import { ValidationError } from "../src/errors.js";
import { agentSpec } from "./tree.test.js";

function specWith(...blocks: { type: string; props: Record<string, unknown> }[]): { spec: GramSpec; ids: string[] } {
  const elements: GramSpec["elements"] = {
    m1: { type: "Message", props: {}, children: [], keyboard: [] },
  };
  const ids: string[] = [];
  const rowButtons: string[] = [];
  blocks.forEach((block, index) => {
    const id = `x${index}`;
    ids.push(id);
    elements[id] = block as never;
    if (block.type === "Button") rowButtons.push(id);
    else (elements["m1"] as { children: string[] }).children.push(id);
  });
  if (rowButtons.length > 0) {
    elements["r0"] = { type: "ButtonRow", props: {}, children: rowButtons } as never;
    (elements["m1"] as { keyboard: string[] }).keyboard.push("r0");
  }
  return { spec: { version: 1, root: "m1", elements } as GramSpec, ids };
}

describe("escapeHtml", () => {
  it("escapes the three HTML-sensitive characters", () => {
    expect(escapeHtml('<b>Tom & Jerry</b>')).toBe("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
  });
});

describe("serializeCallbackData", () => {
  it("uses the bare action without payload", () => {
    expect(serializeCallbackData("refresh", undefined)).toBe("refresh");
    expect(serializeCallbackData("refresh", {})).toBe("refresh");
  });

  it("serializes action + payload as a JSON array", () => {
    expect(serializeCallbackData("view_logs", { agent: "mail-digest" })).toBe(
      '["view_logs",{"agent":"mail-digest"}]',
    );
  });
});

describe("inspectClassicMessage", () => {
  it("renders the agents fixture into HTML + inline keyboard", () => {
    const { message } = inspectClassicMessage(agentSpec());
    expect(message).toBeDefined();
    expect(message!.parse_mode).toBe("HTML");
    expect(message!.text).toContain("<b>Running Agents</b>");
    expect(message!.text).toContain("<b>Uptime:</b> 3h 12m");
    expect(message!.text).toContain("✅ running");
    expect(message!.text).toContain("ℹ️ 3 agents online");
    // Top-level blocks joined by a blank line.
    expect(message!.text).toContain("</b>\n\n");

    const keyboard = message!.reply_markup!.inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]).toEqual([
      { text: "Refresh", callback_data: "refresh" },
      { text: "View logs", callback_data: '["view_logs",{"agent":"cart-resolver"}]' },
    ]);
  });

  it("escapes user data before wrapping in HTML tags", () => {
    const { spec } = specWith(
      { type: "Heading", props: { text: "<script>alert(1)</script>" } },
      { type: "Field", props: { label: "a<b", value: "1&2" } },
      { type: "Code", props: { text: "if (a < b && b > c) {}" } },
    );
    const { message } = inspectClassicMessage(spec);
    expect(message!.text).toContain("<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>");
    expect(message!.text).toContain("<b>a&lt;b:</b> 1&amp;2");
    expect(message!.text).toContain("<pre><code>if (a &lt; b &amp;&amp; b &gt; c) {}</code></pre>");
  });

  it("renders lists, statuses, quotes, alerts, dividers, and sections", () => {
    const { spec, ids } = specWith(
      { type: "List", props: { items: ["first", "second"], ordered: true } },
      { type: "Status", props: { level: "error", text: "agent down" } },
      { type: "Quote", props: { text: "secret", expandable: true } },
      { type: "Alert", props: { level: "warning", title: "Degraded", text: "mail-digest" } },
      { type: "Divider", props: {} },
    );
    // A section wrapping the divider.
    spec.elements["sec"] = { type: "Section", props: { title: "Group" }, children: [ids[4]!] };
    (spec.elements["m1"] as { children: string[] }).children.push("sec");
    const { message } = inspectClassicMessage(spec);
    expect(message!.text).toContain("1. first\n2. second");
    expect(message!.text).toContain("❌ agent down");
    expect(message!.text).toContain("<blockquote expandable>secret</blockquote>");
    expect(message!.text).toContain("⚠️ <b>Degraded</b> — mail-digest");
    expect(message!.text).toContain("──────────────");
    expect(message!.text).toContain("<b>Group</b>\n──────────────");
  });

  it("warns near the 4096-character limit and errors past it", () => {
    const filler = "x".repeat(3600);
    const { spec } = specWith({ type: "Text", props: { text: filler } });
    const near = inspectClassicMessage(spec);
    expect(near.diagnostics.errors).toHaveLength(0);
    expect(near.diagnostics.warnings.some((warning) => warning.includes("close to the limit"))).toBe(true);

    const { spec: big } = specWith({ type: "Text", props: { text: "x".repeat(4200) } });
    const over = inspectClassicMessage(big);
    expect(over.diagnostics.errors.some((error) => error.code === "text_too_long")).toBe(true);
    expect(() => compileClassicMessage(big)).toThrowError(ValidationError);
  });

  it("errors on callback_data over 64 bytes", () => {
    const { spec } = specWith({
      type: "Button",
      props: { label: "Big", action: "do", payload: { blob: "y".repeat(80) } },
    });
    const { message, diagnostics } = inspectClassicMessage(spec);
    expect(diagnostics.errors.some((error) => error.code === "callback_data_too_long")).toBe(true);
    // Best-effort message still compiles (button included for debugging).
    expect(message!.reply_markup!.inline_keyboard[0]![0]!.text).toBe("Big");
    expect(() => compileClassicMessage(spec)).toThrowError(/callback data is \d+ bytes/);
  });

  it("errors on buttons without a target and drops them from the keyboard", () => {
    const { spec } = specWith(
      { type: "Button", props: { label: "Broken" } },
      { type: "Button", props: { label: "Fine", action: "ok" } },
    );
    const { message, diagnostics } = inspectClassicMessage(spec);
    expect(diagnostics.errors.some((error) => error.code === "button_target_missing")).toBe(true);
    expect(message!.reply_markup!.inline_keyboard[0]).toHaveLength(1);
  });

  it("passes through url buttons, styles, and disabled buttons", () => {
    const { spec } = specWith(
      { type: "Button", props: { label: "Docs", url: "https://example.com" } },
      { type: "Button", props: { label: "Delete", action: "delete", style: "danger" } },
      { type: "Button", props: { label: "Off", disabled: true } },
    );
    const { message } = inspectClassicMessage(spec);
    expect(message!.reply_markup!.inline_keyboard[0]).toEqual([
      { text: "Docs", url: "https://example.com" },
      { text: "Delete", callback_data: "delete", style: "danger" },
      { text: "Off", disabled: {} },
    ]);
  });

  it("warns on wide keyboards", () => {
    const spec = agentSpec();
    const big = [...Array(7)].map((_, index) => ({
      type: "Button",
      props: { label: `b${index}`, action: `a${index}` },
    }));
    spec.elements["r1"] = { type: "ButtonRow", props: {}, children: big.map((_, index) => `wide${index}`) } as never;
    big.forEach((_, index) => {
      spec.elements[`wide${index}`] = big[index]! as never;
    });
    // Second row to trip the row-count warning too.
    const row2 = { type: "ButtonRow", props: {}, children: ["x"] };
    spec.elements["r2"] = row2 as never;
    spec.elements["x"] = { type: "Button", props: { label: "x", action: "x" } } as never;
    (spec.elements["m1"] as { keyboard: string[] }).keyboard = ["r1", "r2"];
    for (let index = 0; index < 9; index += 1) {
      const rowId = `wrow${index}`;
      spec.elements[rowId] = { type: "ButtonRow", props: {}, children: [] } as never;
      (spec.elements["m1"] as { keyboard: string[] }).keyboard.push(rowId);
    }
    const { diagnostics } = inspectClassicMessage(spec);
    expect(diagnostics.warnings.some((warning) => warning.includes("buttons — 3–4"))).toBe(true);
    expect(diagnostics.warnings.some((warning) => warning.includes("rows; most clients"))).toBe(true);
  });
});

describe("telegramDiagnostics", () => {
  it("matches the compiler diagnostics", () => {
    expect(telegramDiagnostics(agentSpec())).toEqual({ errors: [], warnings: [] });
  });
});

describe("Table, Note, and mono Field rendering", () => {
  it("renders a table as an aligned monospace grid with header and rule", () => {
    const { spec } = specWith({
      type: "Table",
      props: {
        columns: ["Agent", "Status"],
        rows: [
          ["cart-resolver", "running"],
          ["mail-digest", "degraded"],
        ],
      },
    });
    const { message } = inspectClassicMessage(spec);
    const pre = /<pre>([\s\S]*?)<\/pre>/.exec(message!.text)![1]!;
    const lines = pre.split("\n");
    expect(lines[0]).toBe("Agent          Status"); // "cart-resolver" (13) sets column width + 2-space gap
    expect(lines[1]).toBe("─────────────  ────────");
    expect(lines[2]).toBe("cart-resolver  running");
    expect(lines[3]).toBe("mail-digest    degraded");
    expect(message!.text.startsWith("<pre>")).toBe(true);
  });

  it("truncates wide table cells proportionally", () => {
    const { spec } = specWith({
      type: "Table",
      props: {
        rows: [
          ["a".repeat(60), "b".repeat(45)],
          ["c", "d"],
        ],
      },
    });
    const { message } = inspectClassicMessage(spec);
    expect(message!.text).toContain("…");
    // Total rendered line width stays near the ~100-char budget.
    const firstDataRow = /<pre>([\s\S]*?)<\/pre>/.exec(message!.text)![1]!.split("\n")[0]!;
    expect(firstDataRow.length).toBeLessThanOrEqual(100);
  });

  it("escapes table cells", () => {
    const { spec } = specWith({ type: "Table", props: { rows: [["<b>&", "x"]] } });
    const { message } = inspectClassicMessage(spec);
    expect(message!.text).toContain("&lt;b&gt;&amp;");
  });

  it("renders Note as an italic line", () => {
    const { spec } = specWith({ type: "Note", props: { text: "Use /use <name> to select" } });
    const { message } = inspectClassicMessage(spec);
    expect(message!.text).toBe("<i>Use /use &lt;name&gt; to select</i>");
  });

  it("renders a mono Field value inside <code>", () => {
    const { spec } = specWith(
      { type: "Field", props: { label: "Pane", value: "pane-7", mono: true } },
      { type: "Field", props: { label: "Cwd", value: "~/work" } },
    );
    const { message } = inspectClassicMessage(spec);
    expect(message!.text).toContain("<b>Pane:</b> <code>pane-7</code>");
    expect(message!.text).toContain("<b>Cwd:</b> ~/work");
  });
});
