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

let endTimer: number | null = null;

export function playJoinGlow(): void {
  if (endTimer !== null) window.clearTimeout(endTimer);
  // Off for one frame first, so a glow that is already running restarts its
  // CSS animation instead of carrying on from wherever it was.
  useJoinGlowStore.setState({ glowing: false });
  window.requestAnimationFrame(() => {
    useJoinGlowStore.setState({ glowing: true });
    endTimer = window.setTimeout(() => {
      endTimer = null;
      useJoinGlowStore.setState({ glowing: false });
    }, JOIN_GLOW_MS);
  });
}
