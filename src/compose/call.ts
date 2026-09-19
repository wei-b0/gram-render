import type { Evaluator, EvaluateArgs, EvaluationResult } from "../evaluate/types.js";
import { CompositionError } from "../errors.js";

/**
 * Shared evaluator plumbing: call accounting, answer validation, and usage
 * aggregation. Used by both the batched and sequential composers.
 */

export interface CallRecord {
  answers: EvaluationResult["answers"];
  elapsedMs: number;
  inputTokens: number | null;
}

export interface UsageTracker {
  calls: number;
  inputTokens: number | null;
  /** Add per-call usage; null-poisons the total when usage is missing. */
  addUsage(inputTokens: number | null): void;
}

export function createUsageTracker(): UsageTracker {
  let poisoned = false;
  const tracker: UsageTracker = {
    calls: 0,
    inputTokens: null,
    addUsage(tokens) {
      if (tokens === null) {
        poisoned = true;
        tracker.inputTokens = null;
        return;
      }
      // Sum normally until a call omits usage; from then on the total is null.
      if (!poisoned) tracker.inputTokens = (tracker.inputTokens ?? 0) + tokens;
    },
  };
  return tracker;
}

/** Invoke the evaluator, validate one answer per question against its offered criteria, and track usage. */
export async function callEvaluator(
  evaluate: Evaluator,
  args: EvaluateArgs,
  tracker: UsageTracker,
): Promise<CallRecord> {
  tracker.calls += 1;
  const startedAt = Date.now();
  const result = await evaluate(args);
  const elapsedMs = Date.now() - startedAt;

  const inputTokens = result.usage?.inputTokens ?? null;
  tracker.addUsage(inputTokens);

  const answers: EvaluationResult["answers"] = {};
  for (const [name, question] of Object.entries(args.questions)) {
    const answer = result.answers[name];
    if (!answer || typeof answer.choice !== "string") {
      throw new CompositionError(`Evaluator did not answer question "${name}".`);
    }
    if (!(answer.choice in question.criteria)) {
      throw new CompositionError(`Evaluator answered "${answer.choice}" for question "${name}", which is not one of the offered criteria.`);
    }
    if (answer.confidence !== undefined && (answer.confidence < 0 || answer.confidence > 1)) {
      throw new CompositionError(`Evaluator returned an out-of-range confidence (${answer.confidence}) for question "${name}".`);
    }
    answers[name] = answer;
  }
  return { answers, elapsedMs, inputTokens };
}

/** Lowest confidence across a set of answers (undefined when none carry confidence). */
export function minConfidenceOf(answers: EvaluationResult["answers"]): number | undefined {
  const values = Object.values(answers)
    .map((answer) => answer.confidence)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.min(...values) : undefined;
}
