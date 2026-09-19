import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root.js";

// Bundled web fonts (see theme.ts): the composition must render identical
// frames on any machine, including ones with no system fonts installed.
// Monochrome Noto Emoji / Noto Sans Symbols 2 are used deliberately: Chrome
// Headless Shell cannot paint color-emoji font formats (loads but paints
// tofu), while outline webfonts go through the normal glyph pipeline.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/noto-emoji/400.css";
import "./font-loader.js";

registerRoot(RemotionRoot);
