/**
 * Quickstart: compose a Telegram message for a small order record, then edit
 * the result with a follow-up prompt.
 *
 * Run with a TypeSafe key: TYPESAFE_API_KEY=apikey_… npm run example
 * (or GRAM_RENDER_API_KEY=… — see createEvaluator).
 */

import { compileClassicMessage, composeSpec, type GramSpec } from "../src/index.js";

const ORDER = {
  id: "#1842", customer: "Maya Patel", status: "processing", payment: "paid",
  items: [
    { name: "Linen shirt", qty: 2, price: "$39.00" },
    { name: "Canvas tote", qty: 1, price: "$24.00" },
  ],
  total: "$102.00",
};

async function main(): Promise<void> {
  console.log("=== compose ===\n");

  let spec: GramSpec | null = null;
  for await (const event of composeSpec({
    prompt: 'Show this order. Quote "Order #1842" as the heading. Expose the actions.',
    context: {
      order: ORDER,
      actions: [
        { label: "Mark as packed", action: "mark_packed", payload: { order: "#1842" }, style: "primary" },
        { label: "Cancel order", action: "cancel_order", payload: { order: "#1842" }, style: "danger" },
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
    prompt: 'Remove the cancel action. Also add a divider and the text "Packed orders ship daily".',
    initialSpec: spec,
    context: { order: ORDER },
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
