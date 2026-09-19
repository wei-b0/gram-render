/**
 * Visual theme for the comparison composition: black background, two equal
 * panels, Telegram-styled preview surfaces. Colors are static — no
 * `Date.now()`, no randomness, no network. Determinism is a hard requirement:
 * the same trace must render byte-identical frames.
 */

export const THEME = {
  // The Telegram conversation renders zoomed so the message fills its half of
  // the frame like a zoomed-in screenshot. `zoom` (not transform) keeps the
  // bottom-anchored layout math intact.
  previewScale: 1.8,
  bg: "#000000",
  divider: "#1b2027",
  label: "#8b949e",
  labelBright: "#e6edf3",
  accent: "#58a6ff",
  valid: "#3fb950",
  invalid: "#f85149",
  codeWell: "#0d1117",
  codeText: "#c9d1d9",
  codeBorder: "#21262d",
  headline: "#e6edf3",
  telegram: {
    chatBg: "#0e1621",
    bubble: "#182533",
    text: "#ffffff",
    muted: "#7d8e9e",
    // In-bubble timestamp — kept as its own key so it can diverge from muted.
    time: "#7d8e9e",
    // Sender names — Telegram dark-theme blue.
    sender: "#6ab3f3",
    // Unstyled inline-keyboard button fill (Telegram dark keyboard blue).
    keyboardBg: "#2b5278",
    primary: "#3390ec",
    success: "#4fae4e",
    warning: "#e8a33d",
    danger: "#ec3942",
  },
  // Fonts are bundled via @fontsource CSS imports in video/index.ts — never
  // rely on system fonts (the render machine may have none, and byte-identical
  // frames on any machine is a hard requirement). "Noto Emoji" (monochrome
  // outline — Chrome Headless Shell cannot paint color-emoji font formats)
  // stays in the stack as a fallback for any emoji arriving in spec text.
  fontMono: '"JetBrains Mono", "Noto Emoji", monospace',
  fontSans: '"Inter", "Noto Emoji", sans-serif',
} as const;

/**
 * Telegram renders a no-photo userpic as a gradient chosen deterministically
 * from the display name — same name, same colors, everywhere. These are the
 * default userpic gradient pairs, and `avatarGradient` mirrors that behavior
 * (FNV-1a over code units — no randomness, so frames stay byte-identical).
 */
const AVATAR_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#ff885e", "#ff516a"],
  ["#ffcd6a", "#ffa85c"],
  ["#82b1ff", "#665fff"],
  ["#a0de7e", "#54cb68"],
  ["#53edd6", "#28c9b7"],
  ["#72d5fd", "#2a9ef1"],
  ["#e0a2f3", "#d669ed"],
];

export function avatarGradient(name: string): readonly [string, string] {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return AVATAR_GRADIENTS[(hash >>> 0) % AVATAR_GRADIENTS.length]!;
}
