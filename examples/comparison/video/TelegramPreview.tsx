import type { CSSProperties, ReactNode } from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import type { ButtonElement, GramElement, GramSpec, StatusLevel } from "../../../src/spec/schema.js";
import { avatarGradient, THEME } from "./theme.js";

/**
 * Telegram conversation preview of a GramSpec — one shared renderer for BOTH
 * sides of the comparison (same shell, only the generated message content
 * differs). Styled after Telegram Desktop's night theme so each panel reads
 * like an actual chat screenshot: flat dark chat surface, bottom-anchored
 * conversation under a centered date chip, a gradient no-photo userpic beside
 * the sender name, a bubble that hugs its content with an in-bubble clock,
 * textual blocks mirroring what `compileClassicMessage` puts on the wire, and
 * the inline keyboard attached beneath the bubble at bubble width — styled
 * buttons included, since the wire artifact carries per-button styles.
 *
 * `birthFrames` drives the materialization animation: each element id maps to
 * the frame its block first became available (LLM side: recorded gated
 * partial renders; gram-render side: recorded step snapshots). Ids without an
 * entry render statically.
 */

const BOT_NAME = "Order Bot";

/**
 * Telegram widens a message so its keyboard's buttons fit their equal share
 * of the row without truncating; this floor gives that behavior a concrete
 * minimum (two ~15px labels like this fixture's at even split). Labels longer
 * than the equal share ellipsize, as Telegram does when it can't equalize.
 */
const MIN_MESSAGE_WIDTH = 296;

const LEVEL_EMOJI: Record<StatusLevel, string> = {
  success: "✅",
  info: "ℹ️",
  warning: "⚠️",
  error: "❌",
};

const LEVEL_COLORS: Record<StatusLevel, string> = {
  success: THEME.telegram.success,
  info: THEME.telegram.primary,
  warning: THEME.telegram.warning,
  error: THEME.telegram.danger,
};

/** Wire fill for inline-keyboard buttons by their per-button style. */
const BUTTON_BG: Record<string, string> = {
  primary: THEME.telegram.primary,
  success: THEME.telegram.success,
  danger: THEME.telegram.danger,
};

/** Entrance for one block: quick fade + rise, deterministic per birth frame. */
const Reveal: React.FC<{ frame: number | null; children: ReactNode }> = ({ frame, children }) => {
  const current = useCurrentFrame();
  if (frame === null) return <>{children}</>;
  const appear = interpolate(current, [frame, frame + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const rise = interpolate(current, [frame, frame + 8], [10, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return <div style={{ opacity: appear, transform: `translateY(${rise}px)` }}>{children}</div>;
};

/** Telegram's centered date chip, e.g. "19 September" (trace-derived). */
const DateChip: React.FC<{ text: string | undefined }> = ({ text }) =>
  text === undefined ? null : (
    <div
      style={{
        alignSelf: "center",
        marginBottom: 10,
        background: "rgba(0,0,0,0.3)",
        borderRadius: 12,
        padding: "3px 10px",
        fontSize: 13,
        color: "#ffffff",
        fontFamily: THEME.fontSans,
      }}
    >
      {text}
    </div>
  );

/** Telegram's floating "typing…" indicator — bottom-left pill, bouncing dots. */
const Typing: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        background: "rgba(0,0,0,0.35)",
        borderRadius: 12,
        padding: "10px 14px",
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
      }}
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: THEME.telegram.muted,
            transform: `translateY(${-3 * Math.abs(Math.sin(frame / 9 - index * 0.9))}px)`,
          }}
        />
      ))}
    </div>
  );
};

/**
 * One incoming bot message: gradient no-photo userpic (Telegram picks it from
 * the display name — deterministic) + sender name above the bubble column.
 * The avatar bottom-aligns with the message, like a real chat.
 */
const MessageGroup: React.FC<{ children: ReactNode }> = ({ children }) => {
  const gradient = avatarGradient(BOT_NAME);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-end", alignSelf: "flex-start" }}>
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 999,
          background: `linear-gradient(180deg, ${gradient[0]}, ${gradient[1]})`,
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {BOT_NAME.charAt(0).toUpperCase()}
      </div>
      {/* The column shrink-wraps to its widest child, so the keyboard rows
          attached below share the bubble's width — like real inline keyboards.
          The floor is Telegram's "the message widens for its keyboard" rule:
          row buttons split evenly, so the whole message grows to keep the
          widest label untruncated at its equal share. */}
      <div
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "stretch",
          minWidth: MIN_MESSAGE_WIDTH,
          maxWidth: 600,
        }}
      >
        <div style={{ color: THEME.telegram.sender, fontSize: 13, fontWeight: 600, margin: "0 0 3px 2px" }}>
          {BOT_NAME}
        </div>
        {children}
      </div>
    </div>
  );
};

const hairline = "1px solid rgba(255,255,255,0.08)";

/** Compact Telegram-native table: aligned monospace text, like <pre> in a bot message. */
function tableText(columns: string[] | undefined, rows: string[][]): string {
  const header = columns ?? [];
  const width = header.length || rows[0]?.length || 0;
  const colWidths: number[] = [];
  for (let c = 0; c < width; c++) {
    let w = header[c]?.length ?? 0;
    for (const row of rows) w = Math.max(w, row[c]?.length ?? 0);
    colWidths.push(w);
  }
  const line = (cells: Array<string | undefined>): string =>
    cells
      .map((cell, i) => (cell ?? "").padEnd(colWidths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const body = rows.map((row) => line(row));
  if (header.length === 0) return body.join("\n");
  // The compiler builds the header rule per column ("  "-joined). It uses the
  // box-drawing `─` (U+2500), which the bundled font subsets don't cover — the
  // em dash is the same-width stand-in that actually renders.
  const rule = colWidths.map((w) => "—".repeat(w)).join("  ");
  return [line(header), rule, ...body].join("\n");
}

export const TelegramPreview: React.FC<{
  spec: GramSpec | null;
  birthFrames?: Record<string, number>;
  dateText?: string;
  sentAt?: string | null;
}> = ({ spec, birthFrames = {}, dateText, sentAt = null }) => {
  // Flat, edge-to-edge Telegram chat surface (the benchmark canvas around it
  // stays black). No card, no header bar — a conversation, anchored to the
  // bottom of the screen like a real chat with one message in it. The content
  // itself renders zoomed (THEME.previewScale) to fill the half-frame.
  const surface: CSSProperties = {
    background: THEME.telegram.chatBg,
    flex: 1,
    minHeight: 0,
    padding: "14px 24px 32px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    overflow: "hidden",
  };
  // Flex column, not a plain block — the date chip's alignSelf and the message
  // group's left alignment only apply inside a flex container.
  const zoomed: CSSProperties = {
    zoom: THEME.previewScale,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
  };

  if (spec === null) {
    return (
      <div style={surface}>
        <div style={zoomed}>
          <DateChip text={dateText} />
          <div style={{ alignSelf: "flex-start" }}>
            <Typing />
          </div>
        </div>
      </div>
    );
  }

  const root = spec.elements[spec.root];
  const topIds = root !== undefined && "children" in root ? root.children : [];
  const keyboardIds = root !== undefined && root.type === "Message" ? root.keyboard : [];

  const reveal = (id: string, node: ReactNode): ReactNode => (
    <Reveal key={id} frame={birthFrames[id] ?? null}>
      {node}
    </Reveal>
  );

  // -- block renderers: textual, hierarchy via bold/spacing, mirroring the
  //    wire artifact compileClassicMessage emits --------------------------------

  const renderBlock = (id: string): ReactNode => {
    const element: GramElement | undefined = spec.elements[id];
    if (element === undefined) return null;
    const base: CSSProperties = { color: THEME.telegram.text, fontSize: 15, lineHeight: 1.35 };
    switch (element.type) {
      case "Heading":
        // The wire renders headings as plain <b> — bold body text, not a title.
        return reveal(id, <div style={{ ...base, fontSize: 15.5, fontWeight: 700 }}>{element.props.text}</div>);
      case "Status":
        // Wire: plain "ℹ️ text". The monochrome emoji glyph inherits the span
        // color, so the tinted glyph + white text is the level treatment.
        return reveal(
          id,
          <div style={base}>
            <span style={{ color: LEVEL_COLORS[element.props.level] }}>{LEVEL_EMOJI[element.props.level]}</span>{" "}
            {element.props.text}
          </div>,
        );
      case "Field":
        return reveal(
          id,
          <div style={base}>
            <b>{element.props.label}:</b>{" "}
            <span style={element.props.mono === true ? { fontFamily: THEME.fontMono, fontSize: 14 } : undefined}>
              {element.props.value}
            </span>
          </div>,
        );
      case "List":
        return reveal(
          id,
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {element.props.items.map((item, index) => (
              <div key={index} style={base}>
                {element.props.ordered === true ? `${index + 1}.` : "•"} {item}
              </div>
            ))}
          </div>,
        );
      case "Table":
        return reveal(
          id,
          <div
            style={{
              background: "rgba(0,0,0,0.25)",
              borderRadius: 6,
              padding: "8px 11px",
              fontFamily: THEME.fontMono,
              fontSize: 13.5,
              lineHeight: 1.5,
              color: THEME.telegram.text,
              whiteSpace: "pre",
              overflow: "hidden",
            }}
          >
            {tableText(element.props.columns, element.props.rows)}
          </div>,
        );
      case "Section":
        return reveal(
          id,
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ ...base, fontSize: 15.5, fontWeight: 700 }}>{element.props.title}</div>
            {element.children.map((childId) => (
              <div key={childId}>{renderBlock(childId)}</div>
            ))}
          </div>,
        );
      case "Note":
        return reveal(
          id,
          <div style={{ ...base, color: THEME.telegram.muted, fontSize: 13.5, fontStyle: "italic" }}>
            {element.props.text}
          </div>,
        );
      case "Text":
        return reveal(id, <div style={base}>{element.props.text}</div>);
      case "Quote":
        return reveal(
          id,
          <div style={{ ...base, borderLeft: "2px solid rgba(255,255,255,0.25)", paddingLeft: 10, color: THEME.telegram.muted }}>
            {element.props.text}
          </div>,
        );
      case "Alert":
        return reveal(
          id,
          <div style={base}>
            <span style={{ color: LEVEL_COLORS[element.props.level] }}>{LEVEL_EMOJI[element.props.level]}</span>{" "}
            {element.props.title !== undefined ? <b>{element.props.title} — </b> : null}
            {element.props.text}
          </div>,
        );
      case "Code":
        return reveal(
          id,
          <div
            style={{
              background: "rgba(0,0,0,0.25)",
              borderRadius: 6,
              padding: "8px 11px",
              fontFamily: THEME.fontMono,
              fontSize: 13,
              color: THEME.telegram.text,
              whiteSpace: "pre-wrap",
              overflow: "hidden",
            }}
          >
            {element.props.text}
          </div>,
        );
      case "Divider":
        return reveal(id, <div style={{ borderTop: hairline, margin: "4px 0" }} />);
      default:
        return null;
    }
  };

  const chip = (button: ButtonElement, key: string): ReactNode => {
    const props = button.props;
    const disabled = props.disabled === true;
    return (
      <div
        key={key}
        style={{
          flex: 1,
          // Every button in a keyboard row gets an EQUAL share of the message
          // width — Telegram equalizes the row and truncates (ellipsis) only
          // when a label can't fit its share. The message itself widens for
          // the keyboard (MIN_MESSAGE_WIDTH above) so these labels fit.
          minWidth: 0,
          height: 38,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 12px",
          background: disabled ? THEME.telegram.keyboardBg : (BUTTON_BG[props.style ?? ""] ?? THEME.telegram.keyboardBg),
          color: disabled ? "rgba(255,255,255,0.45)" : "#ffffff",
          borderRadius: 10,
          fontSize: 15,
          fontFamily: THEME.fontSans,
          fontWeight: 400,
        }}
      >
        {/* text-overflow only applies on a block container — the chip is a
            flex box, so the label element carries the clipping itself. */}
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {props.label}
        </div>
      </div>
    );
  };

  // The bubble shell itself is born with its first block (keyed on the first
  // top-level id) — bubble, clock, and first block fade in as one unit, and
  // the clamped wrapper is inert afterward so later blocks reveal on their own.
  const firstTopId = topIds[0];
  const shellBirth = firstTopId !== undefined ? (birthFrames[firstTopId] ?? null) : null;

  return (
    <div style={surface}>
      <div style={zoomed}>
        <DateChip text={dateText} />
        <MessageGroup>
          {/* The message bubble — only as large as its content, with the
              timestamp tucked into the bottom-right clock strip. */}
          <Reveal key="bubble" frame={shellBirth}>
            <div
              style={{
                background: THEME.telegram.bubble,
                borderRadius: "12px 12px 12px 4px",
                padding: "10px 14px 20px",
                position: "relative",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {topIds.map((id) => (
                <div key={id}>{renderBlock(id)}</div>
              ))}
              {sentAt !== null && sentAt !== undefined ? (
                <div
                  style={{
                    position: "absolute",
                    bottom: 5,
                    right: 11,
                    fontSize: 13,
                    lineHeight: 1,
                    color: THEME.telegram.time,
                    fontFamily: THEME.fontSans,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {sentAt}
                </div>
              ) : null}
            </div>
          </Reveal>
          {/* Inline keyboard attached right beneath the bubble. The row is the
              reveal unit so its even-split chips don't get squeezed by the
              animation wrapper. */}
          {keyboardIds.map((rowId) => {
            const row = spec.elements[rowId];
            if (row === undefined || row.type !== "ButtonRow") return null;
            return reveal(
              rowId,
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                {row.children.map((buttonId, index) => {
                  const button = spec.elements[buttonId];
                  return button !== undefined && button.type === "Button" ? chip(button, `${rowId}-${index}`) : null;
                })}
              </div>,
            );
          })}
        </MessageGroup>
      </div>
    </div>
  );
};
