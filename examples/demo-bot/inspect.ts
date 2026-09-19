/**
 * /inspect — rebuilds the last render's decision trail from data the
 * library already exposes (RenderResult.steps, compile diagnostics). The
 * chosen option ids are resolved back to their human descriptions by
 * re-deriving candidates locally — zero JEV calls, fully deterministic.
 * Nothing here is invented: anything unresolvable is shown raw.
 */

import {
  deriveCandidates,
  inspectClassicMessage,
  inspectRichMessage,
} from "../../src/index.js";
import type { GramSpec } from "../../src/index.js";
import type { LastRender } from "./session.js";
import { SpecBuilder, addButton } from "./screens.js";

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function describeAnswers(lastRender: LastRender): string[] {
  let questions: ReturnType<typeof deriveCandidates>["questions"] = [];
  try {
    questions = deriveCandidates(lastRender.prompt, lastRender.context).questions;
  } catch {
    questions = [];
  }
  const byKey = new Map(questions.map((question) => [question.key, question]));
  const lines: string[] = [];
  for (const step of lastRender.steps.slice(0, 3)) {
    const answers = Object.entries(step.answers ?? {}).slice(0, 6);
    for (const [key, answer] of answers) {
      const option = byKey.get(key)?.options.find((candidate) => candidate.id === answer.choice);
      const confidence = answer.confidence !== undefined ? answer.confidence.toFixed(2) : "?";
      let probabilities = "";
      if (answer.probabilities) {
        const top = Object.entries(answer.probabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([id, p]) => `${id} ${p.toFixed(2)}`)
          .join(" / ");
        if (top) probabilities = ` · ${top}`;
      }
      lines.push(`${key} → ${clip(option?.description ?? answer.choice, 80)} (${confidence}${probabilities})`);
    }
  }
  return lines;
}

function diagnosticsLine(spec: GramSpec, target: "classic" | "rich"): string {
  const diagnostics = target === "rich" ? inspectRichMessage(spec).diagnostics : inspectClassicMessage(spec).diagnostics;
  const first = diagnostics.errors[0]?.message ?? diagnostics.warnings[0];
  if (diagnostics.errors.length === 0 && diagnostics.warnings.length === 0) return `${target}: ok`;
  return `${target}: ${diagnostics.errors.length} error(s), ${diagnostics.warnings.length} warning(s)${
    first ? ` — ${clip(first, 80)}` : ""
  }`;
}

export function buildInspectSpec(lastRender: LastRender): GramSpec {
  const b = new SpecBuilder();
  const t1 = b.add("Text", {
    text: `Last render (${lastRender.mode}) — "${clip(lastRender.prompt, 80)}"`,
  });
  const t2 = b.add("Text", {
    text: `${lastRender.calls} JEV call(s) · ${(lastRender.elapsedMs / 1000).toFixed(1)}s · ${
      lastRender.inputTokens ?? "?"
    } input tokens · ${lastRender.warnings.length} warning(s)`,
  });

  const stepFields: string[] = [];
  lastRender.steps.slice(0, 3).forEach((step, index) => {
    const confidence = step.confidence !== undefined ? ` (confidence ${step.confidence.toFixed(2)})` : "";
    stepFields.push(
      b.add("Field", { label: `${index + 1}. ${step.kind}`, value: clip(step.description, 90) + confidence }),
    );
  });

  const answerLines = describeAnswers(lastRender);
  const answersList = answerLines.length > 0 ? b.add("List", { items: answerLines }) : null;

  const warningItems = lastRender.warnings.slice(0, 3);
  const warningsList = warningItems.length > 0 ? b.add("List", { items: warningItems }) : null;

  const q = b.add("Quote", {
    text: "JEV only chose among these pre-derived options — every word came from your data or your prompt.",
  });
  const n = b.add("Note", {
    text: `${diagnosticsLine(lastRender.spec, "classic")} · ${diagnosticsLine(lastRender.spec, "rich")}`,
  });

  const children = [t1, t2, ...stepFields];
  if (answersList) children.push(answersList);
  if (warningsList) children.push(warningsList);
  children.push(q, n);

  const root = b.message(children, [
    [addButton(b, { label: "Preview as classic message", action: "insp_classic", style: "primary" }), addButton(b, { label: "Back", action: "nav_home" })],
  ]);
  return b.done(root);
}
