import { z } from "zod";
import { EvaluatorError } from "../errors.js";
import type { Evaluator, EvaluationResult } from "./types.js";

/**
 * Default evaluator: a minimal HTTP adapter for the TypeSafe System One API
 * (POST /v1/systemone). Hand-rolled — no SDK dependency — so `gram-render`
 * ships with zod as its only runtime dependency. A custom evaluator (Vercel
 * AI Gateway, Cloudflare Workers AI, or a test mock) can be injected instead
 * via the `evaluate` option.
 */

export interface EvaluatorOptions {
  /** TypeSafe API key (`apikey_…`). Defaults to GRAM_RENDER_API_KEY or TYPESAFE_API_KEY. */
  apiKey?: string;
  /** Defaults to https://api.typesafe.ai (or TYPESAFE_BASE_URL). */
  baseURL?: string;
  /** Model id or alias. Defaults to `jev-latest` (or TYPESAFE_DEFAULT_MODEL). */
  model?: string;
  /** Per-call timeout in ms. Default 10 000. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.object({
      type: z.string(),
      choice: z.string().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
});

export function createEvaluator(options: EvaluatorOptions = {}): Evaluator {
  const apiKey =
    options.apiKey ??
    process.env["GRAM_RENDER_API_KEY"] ??
    process.env["TYPESAFE_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "No TypeSafe API key. Pass `apiKey` to createEvaluator, or set the GRAM_RENDER_API_KEY (or TYPESAFE_API_KEY) environment variable. Keys: https://console.typesafe.ai/settings/keys",
    );
  }
  const baseURL = (options.baseURL ?? process.env["TYPESAFE_BASE_URL"] ?? "https://api.typesafe.ai").replace(/\/+$/, "");
  const model = options.model ?? process.env["TYPESAFE_DEFAULT_MODEL"] ?? "jev-latest";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? globalThis.fetch;

  return async ({ state, questions, signal }) => {
    const signals: AbortSignal[] = signal ? [signal, AbortSignal.timeout(timeoutMs)] : [AbortSignal.timeout(timeoutMs)];
    const timeoutSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

    let response: Response;
    try {
      response = await doFetch(`${baseURL}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, state, questions }),
        signal: timeoutSignal,
      });
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      throw new EvaluatorError("Evaluation request failed before a response arrived (timeout or connection error).", { cause });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const hint = response.status === 401 ? " Check your TypeSafe API key." : response.status === 429 ? " Rate limited — retry later." : "";
      throw new EvaluatorError(`Evaluation request failed (HTTP ${response.status}).${hint}`, { status: response.status, cause: body });
    }

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(await response.json());
    } catch (cause) {
      throw new EvaluatorError("Evaluator returned a malformed response.", { cause });
    }

    const answers: EvaluationResult["answers"] = {};
    for (const [name, answer] of Object.entries(parsed.answers)) {
      if (answer.type !== "choice" || answer.choice === undefined) {
        throw new EvaluatorError(`Evaluator returned a non-choice answer for question "${name}".`, { cause: answer });
      }
      answers[name] = {
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      };
    }

    return {
      answers,
      usage: parsed.usage?.input_tokens !== undefined ? { inputTokens: parsed.usage.input_tokens } : undefined,
      model: parsed.model,
    };
  };
}
