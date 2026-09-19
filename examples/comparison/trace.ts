/**
 * Pure trace builders — assembling a {@link ComparisonTrace} from captured
 * sides and aggregating N runs into a summary. No I/O, so everything here is
 * unit-testable; run.ts only adds argument parsing, orchestration, and file
 * writes.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { GRAM_SPEC_WIRE_SCHEMA } from "./providers/gram-spec-schema.js";
import type { ComparisonFixture } from "./fixture.js";
import type { ComparisonTrace, GramSide, LlmSide, TraceSummary } from "./types.js";
import { ComparisonTraceSchema } from "./types.js";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface TraceInputs {
  fixture: ComparisonFixture;
  model: string;
  provider: "openai" | "openrouter";
  llm: LlmSide;
  gram: GramSide;
  t0Epoch: number;
  runIndex: number;
  runsPlanned: number;
  warm: boolean;
  warmupMs?: { llm: number; jev: number };
  openaiVersion: string;
  baseUrl: string;
  maxOutputTokens: number;
  jevModel: string;
  jevBaseUrl: string;
  minConfidence?: number;
  gitSha?: string;
  nodeVersion?: string;
}

export function buildComparisonTrace(inputs: TraceInputs): ComparisonTrace {
  const meta = {
    schemaVersion: 1 as const,
    runIndex: inputs.runIndex,
    runsPlanned: inputs.runsPlanned,
    warm: inputs.warm,
    startedAtIso: new Date(inputs.t0Epoch).toISOString(),
    gitSha: inputs.gitSha ?? "unknown",
    nodeVersion: inputs.nodeVersion ?? process.version,
    fixtureId: inputs.fixture.id,
    prompt: inputs.fixture.prompt,
    promptSha256: sha256(inputs.fixture.prompt),
    contextSha256: sha256(JSON.stringify(inputs.fixture.context)),
    llm: {
      provider: inputs.provider,
      model: inputs.model,
      api: "responses" as const,
      textFormat: "json_schema" as const,
      schemaSha256: sha256(JSON.stringify(GRAM_SPEC_WIRE_SCHEMA)),
      openaiVersion: inputs.openaiVersion,
      baseUrl: inputs.baseUrl,
      maxOutputTokens: inputs.maxOutputTokens,
    },
    jev: { model: inputs.jevModel, baseUrl: inputs.jevBaseUrl },
    ...(inputs.minConfidence !== undefined ? { minConfidence: inputs.minConfidence } : {}),
    ...(inputs.warmupMs ? { warmupMs: inputs.warmupMs } : {}),
  };
  const summary = buildTraceSummary(inputs.llm, inputs.gram);
  return ComparisonTraceSchema.parse({
    meta,
    t0Epoch: inputs.t0Epoch,
    llm: inputs.llm,
    gramRender: inputs.gram,
    summary,
  });
}

export function buildTraceSummary(llm: LlmSide, gram: GramSide): TraceSummary {
  const llmValidMs = llm.firstValidMs;
  const gramValidMs = gram.firstValidMs;
  let winner: TraceSummary["winner"];
  if (llmValidMs === null && gramValidMs === null) winner = "none";
  else if (gramValidMs === null) winner = "llm";
  else if (llmValidMs === null) winner = "gramRender";
  else winner = llmValidMs < gramValidMs ? "llm" : gramValidMs < llmValidMs ? "gramRender" : "tie";
  return {
    llmValidMs,
    gramValidMs,
    // The LLM side's "first UI" is its first gated partial render; partial
    // states never count toward firstValidMs.
    llmFirstUiMs: llm.partialRenders[0]?.atMs ?? null,
    gramFirstUiMs: gram.firstUiMs,
    winner,
  };
}

// ---------------------------------------------------------------------------
// N-run aggregates
// ---------------------------------------------------------------------------

export const StatsSchema = z.object({
  n: z.number(),
  min: z.number(),
  median: z.number(),
  p90: z.number(),
  max: z.number(),
});
export type Stats = z.infer<typeof StatsSchema>;

/** Nearest-rank percentiles over a non-empty sample; null when empty. */
export function statsOf(values: number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const p90 = sorted[Math.min(n - 1, Math.max(0, Math.ceil(0.9 * n) - 1))]!;
  return { n, min: sorted[0]!, median, p90, max: sorted[n - 1]! };
}

export const RunSummarySchema = z.object({
  generatedAtIso: z.string(),
  runsPlanned: z.number(),
  runsRecorded: z.number(),
  /** Aggregates are computed over warm runs only (cold runs counted separately). */
  warmRuns: z.number(),
  coldRuns: z.number(),
  llm: z.object({
    validRate: z.number(),
    validMs: StatsSchema.nullable(),
    firstUiMs: StatsSchema.nullable(),
    firstTokenMs: StatsSchema.nullable(),
  }),
  gramRender: z.object({
    validRate: z.number(),
    validMs: StatsSchema.nullable(),
    firstUiMs: StatsSchema.nullable(),
  }),
  winnerCounts: z.record(z.string(), z.number()),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export function summarizeRuns(runs: ComparisonTrace[]): RunSummary {
  const warm = runs.filter((run) => run.meta.warm);
  const pool = warm.length > 0 ? warm : runs;
  const count = (values: Array<number | null>): Array<number> =>
    values.filter((value): value is number => value !== null);
  return {
    generatedAtIso: new Date().toISOString(),
    runsPlanned: runs.length,
    runsRecorded: runs.length,
    warmRuns: warm.length,
    coldRuns: runs.length - warm.length,
    llm: {
      validRate: pool.filter((run) => run.summary.llmValidMs !== null).length / pool.length,
      validMs: statsOf(count(pool.map((run) => run.summary.llmValidMs))),
      firstUiMs: statsOf(count(pool.map((run) => run.summary.llmFirstUiMs))),
      firstTokenMs: statsOf(count(pool.map((run) => run.llm.firstTokenMs))),
    },
    gramRender: {
      validRate: pool.filter((run) => run.summary.gramValidMs !== null).length / pool.length,
      validMs: statsOf(count(pool.map((run) => run.summary.gramValidMs))),
      firstUiMs: statsOf(count(pool.map((run) => run.summary.gramFirstUiMs))),
    },
    winnerCounts: countWinners(pool.map((run) => run.summary.winner)),
  };
}

function countWinners(winners: Array<TraceSummary["winner"]>): Record<string, number> {
  const counts: Record<string, number> = { llm: 0, gramRender: 0, tie: 0, none: 0 };
  for (const winner of winners) counts[winner] = (counts[winner] ?? 0) + 1;
  return counts;
}
