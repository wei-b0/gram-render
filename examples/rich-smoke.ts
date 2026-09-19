/**
 * Rich Messages live smoke test — sends gram-render specs to a real Telegram
 * chat via `sendRichMessage` / `editMessageText` (Bot API 10.1–10.3) and probes
 * the wire behaviors the official reference leaves undocumented.
 *
 * Requires .env (or environment): TYPESAFE_API_KEY is NOT needed here — this
 * script only compiles hand-built specs — but TELEGRAM_BOT_TOKEN and
 * GRAM_CHAT_ID are.
 *
 * Run:  npm run smoke:rich
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileRichMessage } from "../src/index.js";
import type { GramSpec } from "../src/spec/schema.js";

/** Tiny .env loader (no dependency); never overrides real env vars. */
function loadDotEnv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] === undefined) process.env[key] = match[2]!;
  }
}
loadDotEnv(fileURLToPath(new URL("../.env", import.meta.url)));

const TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
const CHAT_ID = Number(process.env["GRAM_CHAT_ID"] ?? 0);
if (!TOKEN || !CHAT_ID) {
  console.error("TELEGRAM_BOT_TOKEN and GRAM_CHAT_ID are required (put them in .env).");
  process.exit(1);
}
const TG = `https://api.telegram.org/bot${TOKEN}`;

interface TgResponse {
  ok: boolean;
  result?: any;
  description?: string;
}

/** One retry on network errors (Telegram routes occasionally stall first connect). */
async function tgRaw(method: string, body: unknown): Promise<TgResponse> {
  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${TG}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      break;
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
  return (await res.json()) as TgResponse;
}

// --- fixture specs (order flavored; every one of the 15 catalog components) ---

function fullSpec(): GramSpec {
  return {
    version: 1,
    root: "m1",
    elements: {
      m1: {
        type: "Message",
        props: {},
        children: ["h1", "t1", "tb1", "s1", "st1", "c1", "al1", "ls1", "q1", "q2", "n1"],
        keyboard: ["r1", "r2"],
      },
      h1: { type: "Heading", props: { text: "Order #1842" } },
      t1: { type: "Text", props: { text: "Fulfillment snapshot for customer Maya Patel." } },
      tb1: {
        type: "Table",
        props: {
          columns: ["Item", "Qty", "Price"],
          rows: [
            ["Linen shirt", "2", "$39.00"],
            ["Canvas tote", "1", "$24.00"],
            ["Gift wrap", "1", "$5.00"],
          ],
          compact: true,
        },
      },
      s1: { type: "Section", props: { title: "Delivery" }, children: ["f1", "f2", "f3", "q2"] },
      f1: { type: "Field", props: { label: "Status", value: "processing" } },
      f2: { type: "Field", props: { label: "Courier", value: "EX-4417", mono: true } },
      f3: { type: "Field", props: { label: "Tracking", value: "1Z999AA10123456784", mono: true } },
      st1: { type: "Status", props: { level: "info", text: "Payment confirmed — $102.00 (paid)" } },
      c1: { type: "Code", props: { text: "12:41  courier assigned (EX-4417)\n12:44  shipping label printed\n12:47  handoff scheduled for 14:00–18:00", language: "log" } },
      al1: { type: "Alert", props: { level: "warning", title: "Signature required", text: "Courier needs a signature on delivery" } },
      ls1: { type: "List", props: { items: ["Pick items from shelf B2", "Pack with padding", "Hand to courier EX-4417"], ordered: true } },
      q1: { type: "Quote", props: { text: "Nothing is invented — every string comes from your data or your prompt." } },
      q2: { type: "Quote", props: { text: "Full audit trail: 47 events since 08:41.", expandable: true } },
      n1: { type: "Note", props: { text: "Spec composed by gram-render, compiled to Rich Messages." } },
      r1: { type: "ButtonRow", props: {}, children: ["b1", "b2", "b3"] },
      b1: { type: "Button", props: { label: "Mark as packed", action: "mark_packed", payload: { order: "#1842" }, style: "primary" } },
      b2: { type: "Button", props: { label: "Track shipment", url: "https://www.example.com/track/1Z999AA10123456784" } },
      b3: { type: "Button", props: { label: "Cancel order", disabled: true } },
      r2: { type: "ButtonRow", props: {}, children: ["b4"] },
      b4: { type: "Button", props: { label: "View audit trail", action: "view_audit", payload: { order: "#1842" } } },
    },
  };
}

/** Edited variant: proves editMessageText(rich_message) replaces content in place. */
function editedSpec(): GramSpec {
  const spec = fullSpec();
  (spec.elements["h1"]!.props as { text: string }).text = "Order #1842 — packed";
  (spec.elements["tb1"]!.props as { rows: string[][] }).rows[1] = ["Canvas tote", "1", "$24.00 (packed)"];
  (spec.elements["f1"]!.props as { value: string }).value = "packed";
  spec.elements["al1"] = { type: "Status", props: { level: "success", text: "Order is fully packed" } } as never;
  return spec;
}

// --- probes for undocumented wire behavior ---

interface Probe {
  name: string;
  body: Record<string, unknown>;
}

function probes(): Probe[] {
  return [
    {
      name: "richtext: plain string",
      body: { rich_message: { blocks: [{ type: "paragraph", text: "probe: plain string" }] } },
    },
    {
      // Load-bearing for Field/Alert: array mixing strings and entities.
      name: "richtext: array of strings + entities",
      body: {
        rich_message: {
          blocks: [{ type: "paragraph", text: [{ type: "bold", text: "B:" }, " plain ", { type: "code", text: "C" }] }],
        },
      },
    },
    {
      name: "richtext: bare entity object",
      body: { rich_message: { blocks: [{ type: "paragraph", text: { type: "italic", text: "solo entity" } }] } },
    },
    {
      name: "table: cell align/valign omitted",
      body: {
        rich_message: {
          blocks: [{
            type: "table",
            cells: [
              [{ text: "A", is_header: true }, { text: "B", is_header: true }],
              [{ text: "1" }, { text: "2" }],
            ],
          }],
        },
      },
    },
    {
      name: "list: unordered items without type",
      body: {
        rich_message: {
          blocks: [{
            type: "list",
            items: [{ blocks: [{ type: "paragraph", text: "alpha" }] }, { blocks: [{ type: "paragraph", text: "beta" }] }],
          }],
        },
      },
    },
    {
      name: "footer: mid-message placement",
      body: {
        rich_message: {
          blocks: [
            { type: "paragraph", text: "above" },
            { type: "footer", text: "footer in the middle" },
            { type: "paragraph", text: "below" },
          ],
        },
      },
    },
    {
      name: "details: collapsible block",
      body: {
        rich_message: {
          blocks: [{
            type: "details",
            summary: "Details",
            blocks: [{ type: "paragraph", text: "hidden content" }],
          }],
        },
      },
    },
  ];
}

async function main(): Promise<void> {
  const me = await tgRaw("getMe", {});
  if (!me.ok) {
    console.error(`getMe failed: ${me.description}`);
    process.exit(1);
  }
  console.log(`Rich smoke against @${me.result.username} → chat ${CHAT_ID}\n`);

  let failures = 0;

  // 1. Full-catalog rich message.
  const sent = await tgRaw("sendRichMessage", { chat_id: CHAT_ID, ...compileRichMessage(fullSpec()) });
  if (sent.ok) {
    console.log(`[ok] sendRichMessage full catalog (message_id ${sent.result.message_id})`);
  } else {
    failures += 1;
    console.log(`[FAIL] sendRichMessage full catalog: ${sent.description}`);
  }

  // 2. Second message + in-place edit.
  const sent2 = await tgRaw("sendRichMessage", { chat_id: CHAT_ID, ...compileRichMessage(fullSpec()) });
  if (sent2.ok) {
    const edited = await tgRaw("editMessageText", {
      chat_id: CHAT_ID,
      message_id: sent2.result.message_id,
      ...compileRichMessage(editedSpec()),
    });
    if (edited.ok) {
      console.log(`[ok] editMessageText rich_message in place (message_id ${sent2.result.message_id})`);
    } else {
      failures += 1;
      console.log(`[FAIL] editMessageText rich_message: ${edited.description}`);
    }
  } else {
    failures += 1;
    console.log(`[FAIL] sendRichMessage (edit target): ${sent2.description}`);
  }

  // 3. Undocumented-behavior probes.
  console.log("\nProbes (exploratory — record, don't gate):");
  for (const probe of probes()) {
    const res = await tgRaw("sendRichMessage", { chat_id: CHAT_ID, ...probe.body });
    const status = res.ok ? "ok  " : "FAIL";
    if (!res.ok) failures += 1;
    console.log(`  [${status}] ${probe.name}${res.ok ? "" : ` — ${res.description}`}`);
  }

  console.log(failures === 0 ? "\nAll sends succeeded." : `\n${failures} send(s) failed — adjust src/compile/rich.ts and rerun.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
