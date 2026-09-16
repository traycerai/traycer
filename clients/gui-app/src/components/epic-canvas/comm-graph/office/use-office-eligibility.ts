/**
 * Whether this office is allowed to DO anything.
 *
 * Four ways a mounted office can be off screen, and until now it answered to
 * two of them. A background epic tab is kept mounted under `display:none`; a
 * pane's unselected tab bodies stay mounted in an LRU; a tile can be scrolled
 * out of the canvas; and the whole document can be hidden or the window
 * minimised. The canvas paused its frame loop for the last two and kept
 * planning, syncing and holding a floor's worth of pixels for the first two.
 *
 * One boolean composes all four, and it gates everything the office costs:
 * the first plan, `scene.sync`, `tick`, the draw and the static layer.
 *
 * A VISIBLE BUT UNFOCUSED SPLIT PANE STAYS ELIGIBLE. "Only the view in focus
 * renders" is read as "on screen": both halves of a split are on screen, and
 * freezing the one you are not typing in reads as a hang rather than as a
 * saving. If the literal reading is wanted instead, the focused-pane signal
 * becomes a fifth input here - it is deliberately not threaded through the
 * tile today, so that choice stays one place.
 */
import { useEffect, useState } from "react";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";

export interface OfficeEligibilityInput {
  /** The canvas element's own intersection state, from its observer. */
  readonly intersecting: boolean;
}

/**
 * `document.visibilityState`, live. A minimised window and a background
 * browser tab both arrive here and nowhere else - no React signal reports
 * them, because nothing about the React tree changed.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    const apply = (): void => setVisible(!document.hidden);
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
    };
  }, []);
  return visible;
}

export function useOfficeEligibility(input: OfficeEligibilityInput): {
  readonly eligible: boolean;
} {
  const paneVisible = usePaneVisible();
  const bodySelected = useTabBodySelected();
  const documentVisible = useDocumentVisible();
  return {
    eligible:
      paneVisible && bodySelected && documentVisible && input.intersecting,
  };
}
