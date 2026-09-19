/**
 * Comparison benchmark runner — real runs only, one command:
 *
 *   npm run compare:run                 # 3 warm runs + aggregates
 *   npm run compare:run -- --runs 5 --model openai/gpt-6-astra
 *   npm run compare:run -- --cold       # skip warmups (cold numbers)
 *   npm run compare:run -- --runs 1 --out examples/comparison/traces/canonical.json
 *
 * LLM side: OpenRouter when OPENROUTER_API_KEY is set (base
 * https://openrouter.ai/api/v1, vendor-prefixed model slugs), otherwise direct
 * OpenAI via OPENAI_API_KEY. Either way it is the OpenAI Responses API with
 * native structured output, and the trace records provider + base URL.
 *
 * Preflight (untimed): env loading, client/evaluator construction, warmups.
 * Then both sides start under a single shared t0 and race concurrently; every
 * observable event is captured into a trace JSON. Nothing here renders video.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { createEvaluator } from "../../src/index.js";
import type { Evaluator } from "../../src/index.js";
import { ORDER_FIXTURE } from "./fixture.js";
import { runGramRenderSide } from "./providers/gram.js";
import { runLlmSide, warmupLlm } from "./providers/llm.js";
import type { LlmStreamClient } from "./providers/llm.js";
import { buildComparisonTrace, RunSummarySchema, summarizeRuns } from "./trace.js";
import type { ComparisonTrace, GramSide, LlmSide } from "./types.js";

const TRACES_DIR = fileURLToPath(new URL("./traces/", import.meta.url));
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENAI_MODEL = "gpt-6-astra";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-6-astra";

function loadDotEnv(): void {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]!]) {
        process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env */
  }
}

interface Args {
  runs: number;
  /** Resolved after env loading when unset (defaults differ per provider). */
  model?: string;
  cold: boolean;
  maxOutputTokens: number;
  minConfidence: number;
  out?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { runs: 3, cold: false, maxOutputTokens: 4096, minConfidence: 0.7 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runs") args.runs = Number(argv[++i]);
    else if (arg === "--model") args.model = argv[++i]!;
    else if (arg === "--cold") args.cold = true;
    else if (arg === "--max-output-tokens") args.maxOutputTokens = Number(argv[++i]);
    else if (arg === "--min-confidence") args.minConfidence = Number(argv[++i]);
    else if (arg === "--out") args.out = argv[++i]!;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error("--runs must be a positive integer");
  return args;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

function openaiVersion(): string {
  // The SDK's exports map hides package.json from createRequire; read the
  // file directly (repo layout: examples/comparison → ../../node_modules).
  try {
    const path = fileURLToPath(new URL("../../node_modules/openai/package.json", import.meta.url));
    return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/** Untimed JEV warmup: one real round trip on a minimal question, discarded. */
async function warmupJev(evaluate: Evaluator): Promise<number> {
  const started = performance.now();
  await evaluate({
    state: { order: { id: "#1842", status: "processing" } },
    questions: {
      warm: { type: "choice", instructions: "Warmup ping — pick the first key.", criteria: { first: "First", second: "Second" } },
    },
  });
  return performance.now() - started;
}

function failedLlmSide(message: string): LlmSide {
  const gate = { ok: false as const, stage: "parse" as const, issues: [message], normalized: false };
  return {
    deltas: [],
    checks: [],
    partialRenders: [],
    attempts: [{ startedMs: 0, endedMs: 0, firstTokenMs: null, finalGate: gate, error: message }],
    firstTokenMs: null,
    firstValidMs: null,
    finalText: "",
    finalSpec: null,
    finalGate: gate,
  };
}

function failedGramSide(message: string): GramSide {
  return {
    deriveMs: null,
    calls: [],
    events: [],
    firstUiMs: null,
    firstValidMs: null,
    finalGate: { ok: false, stage: "parse", issues: [message], normalized: false },
    error: message,
  };
}

function describeSide(validMs: number | null, gateStage: string, error?: string): string {
  if (error !== undefined) return `ERROR (${error})`;
  if (validMs === null) return `invalid (${gateStage})`;
  return `${Math.round(validMs)}ms`;
}

function runLine(k: number, total: number, trace: ComparisonTrace): string {
  const warm = trace.meta.warm ? "warm" : "cold";
  // Report the final attempt's state — earlier attempts may have failed and
  // been retried (retry time stays inside the measured window).
  const llmError = trace.llm.attempts.at(-1)?.error;
  const llm = `LLM ${trace.meta.llm.model}: ${describeSide(trace.summary.llmValidMs, trace.llm.finalGate.stage, llmError)}`;
  const gram = `gram-render+JEV: ${describeSide(trace.summary.gramValidMs, trace.gramRender.finalGate.stage, trace.gramRender.error)}`;
  return `run ${k}/${total} (${warm})  ${llm}  |  ${gram}  →  ${trace.summary.winner}`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  loadDotEnv();

  const openrouterKey = process.env["OPENROUTER_API_KEY"];
  const openaiKey = process.env["OPENAI_API_KEY"];
  const useOpenRouter = openrouterKey !== undefined && openrouterKey !== "";
  const apiKey = useOpenRouter ? openrouterKey : openaiKey;
  if (!apiKey) {
    console.error("Neither OPENROUTER_API_KEY nor OPENAI_API_KEY is set — add one to .env (the LLM side cannot run without it).");
    process.exit(1);
  }
  const provider: "openai" | "openrouter" = useOpenRouter ? "openrouter" : "openai";
  const model = args.model ?? (useOpenRouter ? DEFAULT_OPENROUTER_MODEL : DEFAULT_OPENAI_MODEL);

  // Preflight — everything constructed here is untimed. maxRetries: 0 keeps
  // the SDK from adding hidden retry windows inside a measured attempt.
  const client = new OpenAI({ apiKey, maxRetries: 0, ...(useOpenRouter ? { baseURL: OPENROUTER_BASE_URL } : {}) });
  const evaluate = createEvaluator();
  const jevModel = process.env["TYPESAFE_DEFAULT_MODEL"] ?? "jev-latest";
  const jevBaseUrl = (process.env["TYPESAFE_BASE_URL"] ?? "https://api.typesafe.ai").replace(/\/+$/, "");

  let warmup: { llm: number; jev: number } | undefined;
  if (!args.cold) {
    console.log("warmup: LLM schema compile + JEV round trip (untimed, discarded)…");
    let llmWarmupMs = 0;
    let jevWarmupMs = 0;
    let failed = false;
    try {
      llmWarmupMs = await warmupLlm(client, model, args.maxOutputTokens);
    } catch (error) {
      console.warn(`  LLM warmup failed (${error instanceof Error ? error.message : String(error)}) — continuing cold.`);
      failed = true;
    }
    if (!failed) {
      try {
        jevWarmupMs = await warmupJev(evaluate);
      } catch (error) {
        console.warn(`  JEV warmup failed (${error instanceof Error ? error.message : String(error)}) — continuing cold.`);
        failed = true;
      }
    }
    if (!failed) {
      warmup = { llm: llmWarmupMs, jev: jevWarmupMs };
      console.log(`  warmup done: LLM ${Math.round(llmWarmupMs)}ms, JEV ${Math.round(jevWarmupMs)}ms`);
    }
  }

  const sha = gitSha();
  const version = openaiVersion();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const traces: ComparisonTrace[] = [];

  for (let k = 1; k <= args.runs; k++) {
    // Single shared t0 for both sides — taken after all construction.
    const t0Epoch = Date.now();
    const perfT0 = performance.now();
    const atMs = (): number => performance.now() - perfT0;

    const [llmSettled, gramSettled] = await Promise.allSettled([
      runLlmSide({ fixture: ORDER_FIXTURE, atMs, client, model, maxOutputTokens: args.maxOutputTokens }),
      runGramRenderSide({ fixture: ORDER_FIXTURE, atMs, evaluate, minConfidence: args.minConfidence }),
    ]);
    const llm = llmSettled.status === "fulfilled" ? llmSettled.value : failedLlmSide(String(llmSettled.reason));
    const gram = gramSettled.status === "fulfilled" ? gramSettled.value : failedGramSide(String(gramSettled.reason));

    const trace = buildComparisonTrace({
      fixture: ORDER_FIXTURE,
      model,
      provider,
      llm,
      gram,
      t0Epoch,
      runIndex: k,
      runsPlanned: args.runs,
      // A run whose warmup failed is effectively cold for that side (e.g. the
      // schema-compile latency may be inside the measured window) — mark it.
      warm: !args.cold && warmup !== undefined,
      warmupMs: warmup,
      maxOutputTokens: args.maxOutputTokens,
      openaiVersion: version,
      baseUrl: client.baseURL,
      jevModel,
      jevBaseUrl: jevBaseUrl,
      minConfidence: args.minConfidence,
      gitSha: sha,
      nodeVersion: process.version,
    });
    traces.push(trace);

    const tracePath = args.out !== undefined && args.runs === 1 && k === 1 ? args.out : join(TRACES_DIR, `trace-${stamp}-run${k}.json`);
    mkdirSync(dirname(tracePath), { recursive: true });
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
    console.log(runLine(k, args.runs, trace));
  }

  const summary = RunSummarySchema.parse(summarizeRuns(traces));
  const summaryPath = join(TRACES_DIR, `summary-${stamp}.json`);
  mkdirSync(TRACES_DIR, { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  const fmt = (stats: { n: number; min: number; median: number; p90: number; max: number } | null): string =>
    stats === null ? "n/a" : `median ${Math.round(stats.median)}ms (min ${Math.round(stats.min)}, p90 ${Math.round(stats.p90)}, max ${Math.round(stats.max)}, n ${stats.n})`;
  console.log("\nTime to valid GramSpec — warm runs only:");
  console.log(`  LLM:              ${fmt(summary.llm.validMs)}  (valid ${Math.round(summary.llm.validRate * 100)}%)`);
  console.log(`  gram-render+JEV:  ${fmt(summary.gramRender.validMs)}  (valid ${Math.round(summary.gramRender.validRate * 100)}%)`);
  console.log(`  winners: ${JSON.stringify(summary.winnerCounts)}`);
  console.log(`\nsummary → ${summaryPath}`);
}

await main();
