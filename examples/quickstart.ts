/**
 * Quickstart: compose a Telegram status message for a small agent fleet,
 * then edit the result with a follow-up prompt.
 *
 * Run with a TypeSafe key: TYPESAFE_API_KEY=apikey_… npm run example
 * (or GRAM_RENDER_API_KEY=… — see createEvaluator).
 */

import { compileClassicMessage, composeSpec, type GramSpec } from "../src/index.js";

const AGENTS = [
  { name: "cart-resolver", status: "running", uptime: "3h 12m", tasks_done: 142 },
  { name: "mail-digest", status: "degraded", uptime: "0h 44m", tasks_done: 9 },
  { name: "backup-worker", status: "idle", uptime: "12h 01m", tasks_done: 0 },
];

async function main(): Promise<void> {
  console.log("=== compose ===\n");

  let spec: GramSpec | null = null;
  for await (const event of composeSpec({
    prompt: 'Show these agents. Quote "Agent fleet" as the heading and surface actions for the degraded one.',
    context: {
      agents: AGENTS,
      actions: [
        { label: "Restart mail-digest", action: "restart_agent", payload: { agent: "mail-digest" }, style: "primary" },
        { label: "View logs", action: "view_logs", payload: { agent: "mail-digest" } },
      ],
    },
  })) {
    if (event.type === "step") {
      console.log(`[step ${event.step.index}] ${event.step.kind}: ${event.step.description}`);
      if (event.step.confidence !== undefined) console.log(`           confidence ${event.step.confidence.toFixed(2)}`);
    } else {
      spec = event.spec;
      console.log(`[complete] stopReason=${event.stopReason} calls=${event.calls} tokens=${event.inputTokens ?? "?"}ms=${event.elapsedMs}`);
      for (const warning of event.warnings) console.log(`[warn] ${warning}`);
    }
  }

  if (!spec) {
    console.log("No spec produced (unavailable).");
    return;
  }

  console.log("\n--- GramSpec ---");
  console.log(JSON.stringify(spec, null, 2));

  const message = compileClassicMessage(spec);
  console.log("\n--- classic Telegram payload ---");
  console.log(`parse_mode: ${message.parse_mode}`);
  console.log(message.text);
  if (message.reply_markup) {
    for (const [rowIndex, row] of message.reply_markup.inline_keyboard.entries()) {
      console.log(`row ${rowIndex + 1}: ${row.map((button) => `${button.text} (${button.callback_data ?? button.url ?? "disabled"})`).join("  |  ")}`);
    }
  }

  console.log("\n=== edit ===\n");
  for await (const event of composeSpec({
    prompt: 'Remove the logs action. Also add a divider and the text "All systems monitored".',
    initialSpec: spec,
    context: { agents: AGENTS },
  })) {
    if (event.type === "step") {
      console.log(`[step ${event.step.index}] ${event.step.description}`);
    } else {
      console.log(`[complete] stopReason=${event.stopReason} calls=${event.calls}`);
      if (event.spec) {
        const edited = compileClassicMessage(event.spec);
        console.log("\n--- edited message ---");
        console.log(edited.text);
        if (edited.reply_markup) {
          for (const row of edited.reply_markup.inline_keyboard) {
            console.log(row.map((button) => button.text).join("  |  "));
          }
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
