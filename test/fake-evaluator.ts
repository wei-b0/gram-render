import type { ChoiceQuestion, Evaluator, EvaluateArgs, EvaluationResult } from "../src/index.js";

export interface FakeCall {
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

export interface FakeEvaluatorOptions {
  /** Answers by exact question name. Unmatched questions fall back by pattern. */
  answers?: Record<string, string>;
  /** Confidence attached to every answer. Default 0.9. */
  confidence?: number;
  /** Reported input tokens per call. Default 100. */
  usage?: number;
}

export interface FakeEvaluator extends Evaluator {
  calls: FakeCall[];
}

/**
 * Scripted evaluator for deterministic composition tests. Exact-name answers
 * win; unmatched questions answer "yes" for `fulfillable`, "omit" for
 * derived-group questions, and "finish" for the edit `next` question — unless
 * the fallback option says otherwise.
 */
export function fakeEvaluator(options: FakeEvaluatorOptions = {}): FakeEvaluator {
  const confidence = options.confidence ?? 0.9;
  const usage = options.usage ?? 100;
  const calls: FakeCall[] = [];
  const evaluate: FakeEvaluator = async (args: EvaluateArgs): Promise<EvaluationResult> => {
    calls.push({ state: args.state, questions: args.questions });
    const answers: EvaluationResult["answers"] = {};
    for (const name of Object.keys(args.questions)) {
      const scripted = options.answers?.[name];
      const choice =
        scripted ??
        (name === "fulfillable"
          ? "yes"
          : name === "next"
            ? "finish"
            : "omit");
      if (!(choice in args.questions[name]!.criteria)) {
        throw new Error(`fake evaluator: scripted answer "${choice}" for "${name}" is not in criteria`);
      }
      answers[name] = { choice, confidence };
      if (options.answers === undefined || scripted !== undefined) {
        answers[name]!.probabilities = { [choice]: confidence };
      }
    }
    return { answers, usage: { inputTokens: usage }, model: "fake" };
  };
  (evaluate as FakeEvaluator).calls = calls;
  return evaluate;
}

export interface SequenceEvaluator extends Evaluator {
  calls: FakeCall[];
}

/**
 * Evaluator that replays a scripted sequence of `next` answers — one per call,
 * matching the edit loop's one-question-per-call protocol. Falls back to
 * "finish" when the script runs out.
 */
export function sequenceEvaluator(
  choices: string[],
  options: { confidence?: number; usage?: number } = {},
): SequenceEvaluator {
  const confidence = options.confidence ?? 0.9;
  const usage = options.usage ?? 50;
  const calls: FakeCall[] = [];
  let index = 0;
  const evaluate = async (args: EvaluateArgs): Promise<EvaluationResult> => {
    calls.push({ state: args.state, questions: args.questions });
    const question = args.questions["next"];
    if (!question) throw new Error("sequenceEvaluator: no 'next' question in call");
    const choice = choices[index++] ?? "finish";
    if (!(choice in question.criteria)) {
      throw new Error(
        `sequenceEvaluator: choice "${choice}" (step ${index}) not in criteria [${Object.keys(question.criteria).join(", ")}]`,
      );
    }
    return { answers: { next: { choice, confidence } }, usage: { inputTokens: usage }, model: "fake" };
  };
  (evaluate as SequenceEvaluator).calls = calls;
  return evaluate;
}
