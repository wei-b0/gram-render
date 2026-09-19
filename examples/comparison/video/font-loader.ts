import { continueRender, delayRender } from "remotion";

/**
 * Synchronizes the @fontsource web fonts (imported in index.ts) with
 * Remotion's render clock. CSS-registered fonts load lazily; without a
 * delayRender handle Remotion can capture frames before the woff2 fetches
 * finish — and since the composition must never rely on system fallback
 * fonts (a render machine may have none), the text would come out blank.
 * Hold the first frame until every family has settled.
 */
if (typeof document !== "undefined") {
  const handle = delayRender("bundled fonts");
  const loads: Array<Promise<FontFace[]>> = [
    document.fonts.load('400 16px "Inter"'),
    document.fonts.load('500 16px "Inter"'),
    document.fonts.load('600 16px "Inter"'),
    document.fonts.load('700 16px "Inter"'),
    document.fonts.load('400 16px "JetBrains Mono"'),
    document.fonts.load('700 16px "JetBrains Mono"'),
    // Status emoji (✅ ℹ️ ⚠️ ❌), rendered through the monochrome outline
    // fallback declared in theme.ts (color-emoji formats don't paint here).
    document.fonts.load('16px "Noto Emoji"', "✅ℹ️⚠️❌"),
  ];
  // A failed font must not hang the render — release the frame either way.
  Promise.all(loads)
    .then(() => continueRender(handle))
    .catch(() => continueRender(handle));
}
