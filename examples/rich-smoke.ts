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

// --- fixture specs (agent-fleet flavored; every one of the 15 catalog components) ---

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
      h1: { type: "Heading", props: { text: "Agent fleet" } },
      t1: { type: "Text", props: { text: "Live view mirrored from the upstream server." } },
      tb1: {
        type: "Table",
        props: {
          columns: ["Agent", "Status", "cwd"],
          rows: [
            ["cart-resolver", "🟢 working", "~/work/app"],
            ["mail-digest", "🔶 degraded", "~/work/mail"],
            ["backup-worker", "⚪ idle", "/srv/backup"],
          ],
          compact: true,
        },
      },
      s1: { type: "Section", props: { title: "mail-digest" }, children: ["f1", "f2", "f3", "q2"] },
      f1: { type: "Field", props: { label: "Status", value: "degraded" } },
      f2: { type: "Field", props: { label: "Pane", value: "pane-7", mono: true } },
      f3: { type: "Field", props: { label: "cwd", value: "~/work/mail", mono: true } },
      st1: { type: "Status", props: { level: "info", text: "3 agents online" } },
      c1: { type: "Code", props: { text: "WARN  imap fetch retry 3/5\nERROR smtp relay timeout (relay-2)", language: "log" } },
      al1: { type: "Alert", props: { level: "warning", title: "Degraded", text: "mail-digest needs attention" } },
      ls1: { type: "List", props: { items: ["Approve the restart", "View logs", "Ignore for 1h"], ordered: true } },
      q1: { type: "Quote", props: { text: "Nothing is invented — every string comes from your data or your prompt." } },
      q2: { type: "Quote", props: { text: "Full startup log: 47 lines since 08:00.", expandable: true } },
      n1: { type: "Note", props: { text: "Spec composed by gram-render, compiled to Rich Messages." } },
      r1: { type: "ButtonRow", props: {}, children: ["b1", "b2", "b3"] },
      b1: { type: "Button", props: { label: "Restart mail-digest", action: "restart_agent", payload: { agent: "mail-digest" }, style: "primary" } },
      b2: { type: "Button", props: { label: "Docs", url: "https://core.telegram.org/bots/api" } },
      b3: { type: "Button", props: { label: "Off", disabled: true } },
      r2: { type: "ButtonRow", props: {}, children: ["b4"] },
      b4: { type: "Button", props: { label: "View logs", action: "view_logs", payload: { agent: "mail-digest" } } },
    },
  };
}

/** Edited variant: proves editMessageText(rich_message) replaces content in place. */
function editedSpec(): GramSpec {
  const spec = fullSpec();
  (spec.elements["h1"]!.props as { text: string }).text = "Agent fleet — 1 restarted";
  (spec.elements["tb1"]!.props as { rows: string[][] }).rows[1] = ["mail-digest", "🟢 running", "~/work/mail"];
  (spec.elements["f1"]!.props as { value: string }).value = "running";
  spec.elements["al1"] = { type: "Status", props: { level: "success", text: "mail-digest is healthy" } } as never;
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
