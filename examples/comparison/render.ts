/**
 * Video renderer — a pure replay of a captured trace. Zero API calls.
 *
 *   npm run compare:video -- --trace examples/comparison/traces/canonical.json
 *   npm run compare:video -- --trace … --codec gif          # 640×360 GIF
 *   npm run compare:video -- --trace … --fps 60 --scale 1   # opt-in 60 fps
 */

import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { ComparisonTraceSchema } from "./types.js";
import { computeTimeline } from "./video/timeline.js";
import { FPS, HEIGHT, WIDTH } from "./video/settings.js";
import { allowJsExtensionMapping } from "./webpack-override.js";

interface Args {
  trace: string;
  codec: "mp4" | "gif";
  fps: number;
  scale?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { trace: "examples/comparison/traces/canonical.json", codec: "mp4", fps: FPS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--trace") args.trace = argv[++i]!;
    else if (arg === "--codec") {
      const value = argv[++i]!;
      if (value !== "mp4" && value !== "gif") throw new Error(`--codec must be mp4 or gif (got ${value})`);
      args.codec = value;
    } else if (arg === "--fps") args.fps = Number(argv[++i]);
    else if (arg === "--scale") args.scale = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (!Number.isFinite(args.fps) || args.fps <= 0) throw new Error("--fps must be a positive number");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const tracePath = resolve(args.trace);
  const trace = ComparisonTraceSchema.parse(JSON.parse(readFileSync(tracePath, "utf8")));

  console.log(
    `rendering ${args.codec.toUpperCase()} from ${args.trace} (llm ${trace.summary.llmValidMs ?? "—"}ms · gram ${
      trace.summary.gramValidMs ?? "—"
    }ms · winner ${trace.summary.winner})`,
  );

  console.log("bundling composition…");
  const entryPoint = fileURLToPath(new URL("./video/index.ts", import.meta.url));
  const serveUrl = await bundle({
    entryPoint,
    webpackOverride: allowJsExtensionMapping,
    onProgress: (progress: number) => process.stdout.write(`\rbundle ${progress}%`),
  });
  process.stdout.write("\n");

  const composition = await selectComposition({ serveUrl, id: "GramComparison", inputProps: { trace } });
  const timeline = computeTimeline(trace, args.fps);
  const withTiming = { ...composition, fps: args.fps, width: WIDTH, height: HEIGHT, durationInFrames: timeline.durationInFrames };

  const isGif = args.codec === "gif";
  const outPath = resolve(
    `examples/comparison/out/compare-${new Date().toISOString().replace(/[:.]/g, "-")}.${isGif ? "gif" : "mp4"}`,
  );
  mkdirSync(resolve("examples/comparison/out"), { recursive: true });

  console.log(`rendering ${timeline.durationInFrames} frames @ ${args.fps} fps…`);
  await renderMedia({
    composition: withTiming,
    serveUrl,
    codec: isGif ? "gif" : "h264",
    inputProps: { trace },
    outputLocation: outPath,
    scale: args.scale ?? (isGif ? 1 / 3 : 1),
    ...(isGif ? { everyNthFrame: 2 } : {}),
  });

  console.log(`done → ${outPath}`);
}

await main();
