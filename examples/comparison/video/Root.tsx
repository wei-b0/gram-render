import { Composition } from "remotion";
import type { ComparisonTrace } from "../types.js";
import { computeTimeline } from "./timeline.js";
import { FPS, HEIGHT, WIDTH } from "./settings.js";
import { Comparison } from "./Comparison.js";

export interface ComparisonProps {
  trace: ComparisonTrace | null;
}

/**
 * Duration is derived from the trace via calculateMetadata — the composition
 * is exactly as long as the captured run needs (intro + race + hold, min 8 s).
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="GramComparison"
      component={Comparison}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ trace: null }}
      calculateMetadata={({ props }: { props: ComparisonProps }) => ({
        durationInFrames: props.trace === null ? FPS * 8 : computeTimeline(props.trace, FPS).durationInFrames,
        fps: FPS,
        width: WIDTH,
        height: HEIGHT,
      })}
    />
  );
};
