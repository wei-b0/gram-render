import { afterEach, describe, expect, it } from "vitest";
import { createEvaluator } from "../src/evaluate/typesafe.js";
import { EvaluatorError } from "../src/errors.js";
import type { ChoiceQuestion, EvaluateArgs } from "../src/index.js";

const QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions: "Pick one.",
  criteria: { a: "Option A", b: "Option B" },
};

function argsWith(questions: Record<string, ChoiceQuestion>): EvaluateArgs {
  return { state: { user_request: "test" }, questions };
}

/** A fetch mock returning a canned Response. */
function fetchMock(
  status: number,
  body: unknown,
  capture?: (url: string, init: RequestInit) => void,
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    capture?.(String(input), init ?? {});
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

afterEach(() => {
  delete process.env["GRAM_RENDER_API_KEY"];
  delete process.env["TYPESAFE_API_KEY"];
});

describe("createEvaluator", () => {
  it("posts to /v1/systemone with bearer auth and maps answers", async () => {
    let capturedUrl: string | undefined;
    let captured: RequestInit | undefined;
    const evaluate = createEvaluator({
      apiKey: "apikey_test",
      fetch: fetchMock(200, {
        model: "jev-1.13.0",
        answers: { q1: { type: "choice", choice: "a", confidence: 0.87, probabilities: { a: 0.87, b: 0.13 } } },
        usage: { input_tokens: 421, output_tokens: 3 },
      }, (url, init) => {
        capturedUrl = url;
        captured = init;
      }),
    });

    const result = await evaluate(argsWith({ q1: QUESTION }));

    expect(capturedUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect((captured!.headers as Record<string, string>)["Authorization"]).toBe("Bearer apikey_test");
    const body = JSON.parse(String(captured!.body));
    expect(body.model).toBe("jev-latest");
    expect(body.questions.q1.criteria).toEqual(QUESTION.criteria);

    expect(result.answers["q1"]).toEqual({
      choice: "a",
      confidence: 0.87,
      probabilities: { a: 0.87, b: 0.13 },
    });
    expect(result.usage).toEqual({ inputTokens: 421 });
    expect(result.model).toBe("jev-1.13.0");
  });

  it("throws a helpful error when no key is available", () => {
    expect(() => createEvaluator({ fetch: fetchMock(200, {}) })).toThrowError(/No TypeSafe API key/);
  });

  it("falls back to env keys", () => {
    process.env["GRAM_RENDER_API_KEY"] = "apikey_env";
    const evaluator = createEvaluator({ fetch: fetchMock(200, { answers: {} }) });
    expect(evaluator).toBeTypeOf("function");
  });

  it("wraps HTTP errors with status-aware hints", async () => {
    const evaluate401 = createEvaluator({ apiKey: "k", fetch: fetchMock(401, "unauthorized") });
    await expect(evaluate401(argsWith({ q1: QUESTION }))).rejects.toThrowError(/HTTP 401.*API key/s);

    const evaluate429 = createEvaluator({ apiKey: "k", fetch: fetchMock(429, "slow down") });
    await expect(evaluate429(argsWith({ q1: QUESTION }))).rejects.toThrowError(/HTTP 429.*Rate limited/s);

    const evaluate500 = createEvaluator({ apiKey: "k", fetch: fetchMock(500, "boom") });
    const error = await evaluate500(argsWith({ q1: QUESTION })).catch((caught: EvaluatorError) => caught);
    expect(error).toBeInstanceOf(EvaluatorError);
    expect(error.status).toBe(500);
  });

  it("wraps malformed responses", async () => {
    const evaluate = createEvaluator({ apiKey: "k", fetch: fetchMock(200, "<html>not json</html>") });
    await expect(evaluate(argsWith({ q1: QUESTION }))).rejects.toThrowError(/malformed/);
  });

  it("rejects non-choice answers defensively", async () => {
    const evaluate = createEvaluator({
      apiKey: "k",
      fetch: fetchMock(200, { answers: { q1: { type: "noul" } } }),
    });
    await expect(evaluate(argsWith({ q1: QUESTION }))).rejects.toThrowError(/non-choice/);
  });

  it("honors an external abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const evaluate = createEvaluator({
      apiKey: "k",
      fetch: (async () => {
        throw new Error("should not be reached without signal handling");
      }) as typeof globalThis.fetch,
    });
    await expect(evaluate({ ...argsWith({ q1: QUESTION }), signal: controller.signal })).rejects.toThrow();
  });
});
