import { create } from "zustand";

/**
 * The brief glow a single reopened tab gets once it is selected.
 *
 * It tints the join's own outline rather than drawing a box of its own: the
 * selected tab and the bridge under it are two elements, and only both
 * together trace the real silhouette with its concave feet. So the flag is
 * one store both read (the strip for the tab, `SheetJoinBridge` for the
 * bridge) and `index.css` owns the paint. Must match `join-glow` there.
 */
const JOIN_GLOW_MS = 1100;

interface JoinGlowState {
  readonly glowing: boolean;
}

export const useJoinGlowStore = create<JoinGlowState>()(() => ({
  glowing: false,
}));

let startFrame: number | null = null;
let endTimer: number | null = null;

export function playJoinGlow(): void {
  stopJoinGlow();
  // Off for one frame first, so a glow that is already running restarts its
  // CSS animation instead of carrying on from wherever it was.
  startFrame = window.requestAnimationFrame(() => {
    startFrame = null;
    useJoinGlowStore.setState({ glowing: true });
    endTimer = window.setTimeout(() => {
      endTimer = null;
      useJoinGlowStore.setState({ glowing: false });
    }, JOIN_GLOW_MS);
  });
}

/** A glow still running, or about to start, belongs to the tab it was played for. */
export function stopJoinGlow(): void {
  if (startFrame !== null) window.cancelAnimationFrame(startFrame);
  if (endTimer !== null) window.clearTimeout(endTimer);
  startFrame = null;
  endTimer = null;
  if (useJoinGlowStore.getState().glowing)
    useJoinGlowStore.setState({ glowing: false });
}
