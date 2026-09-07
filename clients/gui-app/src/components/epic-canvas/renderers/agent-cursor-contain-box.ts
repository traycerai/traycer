import type { CSSProperties } from "react";
import type { ScreencastFrameSize } from "@/lib/browser-view/sessions/screencast-input-encoding";

/**
 * Its own module rather than a second export from `agent-cursor-overlay.tsx`, which stays component-only for fast refresh.
 * Exported for its own unit test: jsdom parses neither `min()` nor `cqw`/`cqh`, so it drops the whole declaration and the rendered DOM carries no observable trace of these strings.
 */
export function containBox(frameSize: ScreencastFrameSize): CSSProperties {
  const width = frameSize.width.toString();
  const height = frameSize.height.toString();
  return {
    width: `min(100cqw, calc(100cqh * ${width} / ${height}))`,
    height: `min(100cqh, calc(100cqw * ${height} / ${width}))`,
  };
}
