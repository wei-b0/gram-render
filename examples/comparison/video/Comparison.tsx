import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { ComparisonTrace } from "../types.js";
import { computeTimeline, dateChipText, elapsedMs, LLM_TIME_SCALE, sentAtText } from "./timeline.js";
import { THEME } from "./theme.js";
import { Panel } from "./Panel.js";
import type { PanelState } from "./Panel.js";
import { TelegramPreview } from "./TelegramPreview.js";
import type { GramSpec } from "../../../src/spec/schema.js";

/**
 * The comparison composition: a pure replay of a captured trace. Every frame
 * is a deterministic function of (trace, frame) — no network, no clock, no
 * randomness. Two hero surfaces, nothing else: each side's Telegram UI
 * materializes under its label, with one enormous timer underneath. The left
 * (LLM) side plays as a 2.5× timelapse of real trace time — every on-screen
 * number is a recorded trace value; the right side plays 1:1.
 */

const seconds = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(2)}s`;

/**
 * Element id → the frame its block first appeared, walked in recorded order
 * (root-reachable only). Pure function of the trace — the left side's frames
 * are warped by LLM_TIME_SCALE like every other LLM timestamp.
 */
function collectBirthFrames(
  entries: Array<{ atMs: number; spec: GramSpec | null }>,
  fps: number,
  introEnd: number,
  scale: number,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.spec === null) continue;
    const frame = introEnd + Math.ceil(((entry.atMs / 1000) * fps) / scale);
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const element = entry.spec!.elements[id];
      if (element === undefined) return;
      if (map[id] === undefined) map[id] = frame;
      if ("children" in element) for (const child of element.children) visit(child);
      if (element.type === "Message") for (const row of element.keyboard) visit(row);
    };
    visit(entry.spec.root);
  }
  return map;
}

export const Comparison: React.FC<{ trace: ComparisonTrace | null }> = ({ trace }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (trace === null) {
    return (
      <AbsoluteFill style={{ background: THEME.bg, color: THEME.label, alignItems: "center", justifyContent: "center", fontFamily: THEME.fontSans }}>
        no trace loaded
      </AbsoluteFill>
    );
  }

  const timeline = computeTimeline(trace, fps);
  const raceMs = elapsedMs(frame, fps, timeline.introEnd);
  // The race window in video ms (bothDone/introEnd are frames) — running
  // clocks cap here so a side stops counting once the race is over.
  const raceCapMs = ((timeline.bothDone - timeline.introEnd) / fps) * 1000;
  // The left side is a timelapse: video race time × scale = real trace time.
  const llmTraceMs = raceMs * LLM_TIME_SCALE;
  const llmCapTraceMs = raceCapMs * LLM_TIME_SCALE;

  // LEFT — LLM side: the Telegram UI materializes from the gated partial
  // renders; once the full parse gates valid, the final spec takes over.
  const visiblePartials = trace.llm.partialRenders.filter((partial) => partial.atMs <= llmTraceMs);
  const lastPartial = visiblePartials.length > 0 ? visiblePartials[visiblePartials.length - 1]!.spec : null;
  const llmValidMs = trace.summary.llmValidMs;
  const llmValid = llmValidMs !== null && llmTraceMs >= llmValidMs;
  const llmInvalid = llmValidMs === null && frame >= timeline.bothDone;
  const llmSpec = llmValid ? (trace.llm.finalSpec ?? lastPartial) : lastPartial;
  const llmClock = llmValid ? seconds(llmValidMs) : seconds(Math.min(llmTraceMs, llmCapTraceMs));
  const llmState: PanelState = llmValid ? "valid" : llmInvalid ? "invalid" : "running";
  const llmDoneFrame = llmValid ? timeline.llmFirstValidFrame : llmInvalid ? timeline.bothDone : null;

  // RIGHT — gram-render + JEV side: real-time replay of the step snapshots.
  const visibleSteps = trace.gramRender.events.filter((event) => event.type === "step" && event.atMs <= raceMs);
  const lastStep = visibleSteps[visibleSteps.length - 1];
  const stepSpec = lastStep?.type === "step" ? lastStep.spec : null;
  const gramValidMs = trace.summary.gramValidMs;
  const gramValid = gramValidMs !== null && raceMs >= gramValidMs;
  const gramInvalid = gramValidMs === null && frame >= timeline.bothDone;
  const completeSpec = trace.gramRender.events.find((event) => event.type === "complete");
  const gramSpec = gramValid
    ? ((completeSpec?.type === "complete" ? completeSpec.spec : null) ?? stepSpec)
    : stepSpec;
  const gramClock = gramValid ? seconds(gramValidMs) : seconds(Math.min(raceMs, raceCapMs));
  const gramState: PanelState = gramValid ? "valid" : gramInvalid ? "invalid" : "running";
  const gramDoneFrame = gramValid ? timeline.gramFirstValidFrame : gramInvalid ? timeline.bothDone : null;

  // In-chat date chip + bubble timestamps: real captured instants (t0 plus
  // each side's recorded first-UI ms), formatted UTC so frames stay identical.
  const dateText = dateChipText(trace.t0Epoch);
  const llmSentAt = sentAtText(trace.t0Epoch, trace.summary.llmFirstUiMs);
  const gramSentAt = sentAtText(trace.t0Epoch, trace.summary.gramFirstUiMs);

  const headerOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Block-level materialization: each block appears at the frame it first
  // became available in the recorded sequence (partials / step snapshots).
  const llmBirths = collectBirthFrames(
    [
      ...trace.llm.partialRenders.map((partial) => ({ atMs: partial.atMs, spec: partial.spec })),
      { atMs: trace.summary.llmValidMs ?? 0, spec: trace.llm.finalSpec },
    ],
    fps,
    timeline.introEnd,
    LLM_TIME_SCALE,
  );
  const gramBirths = collectBirthFrames(
    trace.gramRender.events.map((event) => ({ atMs: event.atMs, spec: event.spec })),
    fps,
    timeline.introEnd,
    1,
  );

  return (
    <AbsoluteFill style={{ background: THEME.bg, fontFamily: THEME.fontSans }}>
      {/* Header — the only chrome: no names, no fixture, no metric. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderBottom: `1px solid ${THEME.divider}`,
          opacity: headerOpacity,
        }}
      >
        <div style={{ color: THEME.labelBright, fontSize: 19, letterSpacing: 1.2, opacity: 0.6 }}>
          same prompt · same data · same schema
        </div>
      </div>

      {/* Two hero surfaces + two timers. Nothing more. */}
      <div style={{ position: "absolute", top: 56, bottom: 0, left: 0, right: 0, display: "flex", flexDirection: "row" }}>
        <Panel label="LLM" clockText={llmClock} state={llmState} doneFrame={llmDoneFrame}>
          <TelegramPreview spec={llmSpec} birthFrames={llmBirths} dateText={dateText} sentAt={llmSentAt} />
        </Panel>
        <div style={{ width: 1, background: THEME.divider, margin: "26px 0" }} />
        <Panel label="gram-render + JEV" clockText={gramClock} state={gramState} doneFrame={gramDoneFrame}>
          <TelegramPreview spec={gramSpec} birthFrames={gramBirths} dateText={dateText} sentAt={gramSentAt} />
        </Panel>
      </div>
    </AbsoluteFill>
  );
};
