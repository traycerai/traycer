import type { CSSProperties } from "react";
import type { ScreencastFrameSize } from "@/lib/browser-view/sessions/screencast-input-encoding";

/**
 * The painted rectangle of an `object-contain` surface, in the overlay's own
 * size-query container: whichever axis runs out first clamps the box.
 *
 * Its own module rather than a second export from `agent-cursor-overlay.tsx`,
 * which stays component-only for fast refresh.
 *
 * Exported for its own unit test: jsdom parses neither `min()` nor `cqw`/`cqh`,
 * so it drops the whole declaration and the rendered DOM carries no observable
 * trace of these strings. The strings themselves are the only pin available.
 */
export function containBox(frameSize: ScreencastFrameSize): CSSProperties {
  const width = frameSize.width.toString();
  const height = frameSize.height.toString();
  return {
    width: `min(100cqw, calc(100cqh * ${width} / ${height}))`,
    height: `min(100cqh, calc(100cqw * ${height} / ${width}))`,
  };
}
