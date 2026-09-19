import { interpolate, useCurrentFrame } from "remotion";
import { THEME } from "./theme.js";

export type PanelState = "running" | "valid" | "invalid";

/** Font-free checkmark — the bundled subsets don't cover ✓ (renders as tofu). */
const Check: React.FC<{ opacity: number; color: string }> = ({ opacity, color }) => (
  <div
    style={{
      width: 22,
      height: 11,
      borderLeft: `4px solid ${color}`,
      borderBottom: `4px solid ${color}`,
      borderRadius: 1,
      transform: "rotate(-45deg) translateY(-2px)",
      opacity,
    }}
  />
);

/**
 * One side of the comparison: label row, the Telegram preview as the hero
 * surface, and an enormous timer under it. While a side runs the timer ticks
 * with a pulsing status dot; when it finishes the number turns green and a
 * checkmark fades in — the finished side just sits there. Purely
 * presentational; Comparison.tsx does all the math.
 */
export const Panel: React.FC<{
  label: string;
  clockText: string;
  state: PanelState;
  /** Frame this side finished at (null while running) — drives the freeze effect. */
  doneFrame: number | null;
  children: React.ReactNode;
}> = ({ label, clockText, state, doneFrame, children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const done = state !== "running";
  // Settle-in of the frozen state: dot goes solid green, checkmark fades in.
  const settle = done && doneFrame !== null
    ? interpolate(frame, [doneFrame, doneFrame + 10], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;
  // Running dot pulses (deterministic — a pure function of the frame).
  const pulse = interpolate(Math.abs(Math.sin(frame / 7)), [0, 1], [0.35, 1]);
  const dotColor = state === "valid" ? THEME.valid : state === "invalid" ? THEME.invalid : THEME.label;
  const numberColor = state === "valid" ? THEME.valid : state === "invalid" ? THEME.invalid : THEME.labelBright;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        // No padding on the panel itself: the Telegram chat surface (children)
        // runs edge-to-edge as a flat conversation, not an inset card. The
        // label and timer rows carry the padding on the black benchmark canvas.
        opacity,
      }}
    >
      <div
        style={{
          color: THEME.labelBright,
          fontSize: 32,
          fontWeight: 600,
          fontFamily: THEME.fontSans,
          padding: "16px 36px 12px",
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
      {/* The timer is the only chrome under the UI — large and tabular, frozen
          in green with a check once the side is done (kept quieter than the
          zoomed conversation above it). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: "14px 36px 12px",
          background: THEME.bg,
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            background: dotColor,
            opacity: done ? 1 : pulse,
          }}
        />
        <div
          style={{
            color: numberColor,
            fontSize: 44,
            fontWeight: 500,
            fontFamily: THEME.fontMono,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          {clockText}
        </div>
        {state === "valid" ? <Check opacity={settle} color={THEME.valid} /> : null}
      </div>
    </div>
  );
};
