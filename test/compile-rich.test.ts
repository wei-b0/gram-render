import { describe, expect, it } from "vitest";
import { compileRichMessage, inspectRichMessage, RICH_LIMITS } from "../src/compile/rich.js";
import { telegramDiagnostics } from "../src/validate/telegram.js";
import type { GramSpec } from "../src/spec/schema.js";
import { ValidationError } from "../src/errors.js";

function specWith(...blocks: { type: string; props: Record<string, unknown> }[]): GramSpec {
  const elements: GramSpec["elements"] = {
    m1: { type: "Message", props: {}, children: [], keyboard: [] },
  };
  const rowButtons: string[] = [];
  blocks.forEach((block, index) => {
    const id = `x${index}`;
    elements[id] = block as never;
    if (block.type === "Button") rowButtons.push(id);
    else (elements["m1"] as { children: string[] }).children.push(id);
  });
  if (rowButtons.length > 0) {
    elements["r0"] = { type: "ButtonRow", props: {}, children: rowButtons } as never;
    (elements["m1"] as { keyboard: string[] }).keyboard.push("r0");
  }
  return { version: 1, root: "m1", elements } as GramSpec;
}

describe("compileRichMessage", () => {
  it("maps every component to its rich block", () => {
    const spec = specWith(
      { type: "Heading", props: { text: "Fleet" } },
      { type: "Text", props: { text: "Overview" } },
      { type: "Divider", props: {} },
      { type: "Status", props: { level: "warning", text: "mail-digest degraded" } },
      { type: "Code", props: { text: "tail -f", language: "bash" } },
      { type: "Quote", props: { text: "plain" } },
      { type: "Quote", props: { text: "long", expandable: true } },
      { type: "Alert", props: { level: "error", text: "down" } },
      { type: "Alert", props: { level: "warning", title: "Degraded", text: "mail-digest" } },
      { type: "Note", props: { text: "Use /use to select" } },
    );
    const { payload } = inspectRichMessage(spec);
    const blocks = payload!.rich_message.blocks;
    expect(blocks[0]).toEqual({ type: "heading", text: "Fleet", size: 3 });
    expect(blocks[1]).toEqual({ type: "paragraph", text: "Overview" });
    expect(blocks[2]).toEqual({ type: "divider" });
    expect(blocks[3]).toEqual({ type: "paragraph", text: "⚠️ mail-digest degraded" });
    expect(blocks[4]).toEqual({ type: "pre", text: "tail -f", language: "bash" });
    expect(blocks[5]).toEqual({ type: "blockquote", blocks: [{ type: "paragraph", text: "plain" }] });
    expect(blocks[6]).toEqual({ type: "expandable_blockquote", text: "long" });
    expect(blocks[7]).toEqual({ type: "paragraph", text: ["❌", "down"] });
    expect(blocks[8]).toEqual({ type: "paragraph", text: ["⚠️", { type: "bold", text: "Degraded" }, " — ", "mail-digest"] });
    expect(blocks[9]).toEqual({ type: "footer", text: "Use /use to select" });
  });

  it("renders Field with bold label and optional mono value", () => {
    const { payload } = inspectRichMessage(
      specWith(
        { type: "Field", props: { label: "Status", value: "running" } },
        { type: "Field", props: { label: "Pane", value: "pane-7", mono: true } },
      ),
    );
    const blocks = payload!.rich_message.blocks;
    expect(blocks[0]).toEqual({
      type: "paragraph",
      text: [{ type: "bold", text: "Status:" }, " ", "running"],
    });
    expect(blocks[1]).toEqual({
      type: "paragraph",
      text: [{ type: "bold", text: "Pane:" }, " ", { type: "code", text: "pane-7" }],
    });
  });

  it("renders List with numbered items when ordered", () => {
    const { payload } = inspectRichMessage(
      specWith(
        { type: "List", props: { items: ["first", "second"] } },
        { type: "List", props: { items: ["one"], ordered: true } },
      ),
    );
    const blocks = payload!.rich_message.blocks;
    expect(blocks[0]).toEqual({ type: "list", items: [{ blocks: [{ type: "paragraph", text: "first" }] }, { blocks: [{ type: "paragraph", text: "second" }] }] });
    expect(blocks[1]).toEqual({ type: "list", items: [{ blocks: [{ type: "paragraph", text: "one" }], type: "1" }] });
  });

  it("renders Section as a size-5 heading with flattened children", () => {
    const spec = specWith({ type: "Divider", props: {} });
    spec.elements["sec"] = { type: "Section", props: { title: "cart-resolver" }, children: ["x0"] };
    (spec.elements["m1"] as { children: string[] }).children = ["sec"];
    const { payload } = inspectRichMessage(spec);
    expect(payload!.rich_message.blocks).toEqual([
      { type: "heading", text: "cart-resolver", size: 5 },
      { type: "divider" },
    ]);
  });

  it("renders Table with header cells, borders, and compact flag", () => {
    const { payload } = inspectRichMessage(
      specWith({
        type: "Table",
        props: {
          columns: ["Agent", "Status"],
          rows: [["cart-resolver", "running"]],
          compact: true,
        },
      }),
    );
    expect(payload!.rich_message.blocks[0]).toEqual({
      type: "table",
      is_bordered: true,
      is_compact: true,
      cells: [
        [
          { text: "Agent", is_header: true, align: "left", valign: "top" },
          { text: "Status", is_header: true, align: "left", valign: "top" },
        ],
        [
          { text: "cart-resolver", align: "left", valign: "top" },
          { text: "running", align: "left", valign: "top" },
        ],
      ],
    });
  });

  it("appends keyboard rows as buttons blocks in order", () => {
    const spec = specWith(
      { type: "Text", props: { text: "Body" } },
      { type: "Button", props: { label: "Docs", url: "https://example.com" } },
      { type: "Button", props: { label: "Restart", action: "restart", payload: { agent: "mail" }, style: "danger" } },
      { type: "Button", props: { label: "Off", disabled: true } },
    );
    spec.elements["x9"] = { type: "Button", props: { label: "Extra", action: "extra" } } as never;
    spec.elements["r1"] = { type: "ButtonRow", props: {}, children: ["x9"] } as never;
    (spec.elements["m1"] as { keyboard: string[] }).keyboard = ["r0", "r1"];
    const { payload } = inspectRichMessage(spec);
    const blocks = payload!.rich_message.blocks;
    expect(blocks[1]).toEqual({ type: "buttons", buttons: [
      { text: "Docs", url: "https://example.com" },
      { text: "Restart", callback_data: '["restart",{"agent":"mail"}]', style: "danger" },
      { text: "Off", disabled: {} },
    ] });
    expect(blocks[2]).toEqual({ type: "buttons", buttons: [{ text: "Extra", callback_data: "extra" }] });
  });

  it("spreads into sendRichMessage and editMessageText bodies", () => {
    const payload = compileRichMessage(specWith({ type: "Text", props: { text: "Hi" } }));
    const sendBody = { chat_id: 962521656, ...payload };
    const editBody = { chat_id: 962521656, message_id: 42, ...payload };
    expect(sendBody.rich_message.blocks[0]).toEqual({ type: "paragraph", text: "Hi" });
    expect(editBody.rich_message.blocks).toHaveLength(1);
  });
});

describe("rich diagnostics", () => {
  it("errors on more than 8 buttons in one block", () => {
    const buttons = Array.from({ length: 9 }, (_, index) => ({
      type: "Button",
      props: { label: `b${index}`, action: `a${index}` },
    }));
    const spec = specWith(...buttons);
    const { diagnostics } = inspectRichMessage(spec);
    expect(diagnostics.errors.some((error) => error.code === "too_many_buttons")).toBe(true);
    expect(() => compileRichMessage(spec)).toThrowError(ValidationError);
  });

  it("errors past the 500-block budget (table rows count)", () => {
    const rows = Array.from({ length: 600 }, (_, index) => [String(index), "x"]);
    const spec = specWith({ type: "Table", props: { rows } });
    const { diagnostics } = inspectRichMessage(spec);
    expect(diagnostics.errors.some((error) => error.code === "block_limit")).toBe(true);
    expect(() => compileRichMessage(spec)).toThrowError(/500-block|allow 500/);
  });

  it("warns near the block budget", () => {
    const rows = Array.from({ length: 420 }, (_, index) => [String(index)]);
    const spec = specWith({ type: "Table", props: { rows } });
    const { diagnostics } = inspectRichMessage(spec);
    expect(diagnostics.errors).toHaveLength(0);
    expect(diagnostics.warnings.some((warning) => warning.includes("close to the 500-block"))).toBe(true);
  });

  it("errors past the 32,768-character text budget", () => {
    const spec = specWith({ type: "Code", props: { text: "x".repeat(RICH_LIMITS.maxTextChars + 1) } });
    const { diagnostics } = inspectRichMessage(spec);
    expect(diagnostics.errors.some((error) => error.code === "text_too_long")).toBe(true);
    expect(() => compileRichMessage(spec)).toThrowError(ValidationError);
  });

  it("counts list items and nested quote blocks toward the budget", () => {
    const items = Array.from({ length: 250 }, (_, index) => `item ${index}`);
    const spec = specWith(
      { type: "List", props: { items } },
      { type: "List", props: { items } },
      { type: "Quote", props: { text: "quote" } },
    );
    const { diagnostics } = inspectRichMessage(spec);
    // 2 list blocks + 500 items + 1 blockquote = 503 → error
    expect(diagnostics.errors.some((error) => error.code === "block_limit")).toBe(true);
  });

  it("exposes rich diagnostics through telegramDiagnostics", () => {
    const spec = specWith({ type: "Note", props: { text: "fine" } });
    expect(telegramDiagnostics(spec, "rich")).toEqual({ errors: [], warnings: [] });
    expect(telegramDiagnostics(spec)).toEqual({ errors: [], warnings: [] }); // classic default
  });
});
