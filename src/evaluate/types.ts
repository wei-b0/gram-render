/**
 * The evaluator contract — a pure choice protocol, deliberately identical in
 * shape to json-render's so custom adapters are trivial.
 *
 * JEV answers only with discrete choices plus calibrated probabilities; it
 * never writes text. The composer validates every answer against the offered
 * criteria.
 */

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Map of answer key → human description. The evaluator must pick one key. */
  criteria: Record<string, string>;
}

export interface EvaluateArgs {
  /** Arbitrary JSON state the questions are evaluated against. */
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
  signal?: AbortSignal;
}

export interface EvaluationAnswer {
  choice: string;
  /** Calibrated confidence in [0, 1], derived from the probability distribution. */
  confidence?: number;
  /** Full probability distribution over criteria keys, when available. */
  probabilities?: Record<string, number>;
}

export interface EvaluationResult {
  /** One answer per question, keyed by question name. */
  answers: Record<string, EvaluationAnswer>;
  usage?: { inputTokens?: number };
  model?: string;
}

export type Evaluator = (args: EvaluateArgs) => Promise<EvaluationResult>;
