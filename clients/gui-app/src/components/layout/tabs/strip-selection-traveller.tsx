import type { CSSProperties, Ref } from "react";
import { usePublishSheetJoin } from "./sheet-join-context";
import {
  useSelectionTravelling,
  useTravelOutline,
} from "./strip-selection-travel";

/**
 * The stand-in selected box that slides between tabs; see
 * `strip-selection-travel.ts`. Rendered first in the strip's scroller, so it
 * paints under every tab.
 */
export function StripSelectionTraveller({
  ref,
}: {
  readonly ref: Ref<HTMLSpanElement>;
}) {
  const travelling = useSelectionTravelling();
  // The destination's outline colour, so the traveller and its bridge are
  // the box they stand in for (`TabChromeBackground`), never the sheets'
  // border under a coloured tab.
  const outline = useTravelOutline();
  usePublishSheetJoin(travelling ? "canvas" : null, outline);
  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="tab-selection-traveller"
      hidden={!travelling}
      // The join rule in `index.css` paints it exactly like a joined tab box:
      // the canvas fill, the outline, open at the bottom.
      {...(travelling ? { "data-sheet-joined": "top" } : {})}
      className="pointer-events-none absolute top-0 left-0 rounded-xl border"
      style={
        outline === null
          ? undefined
          : ({ "--join-outline": outline } as CSSProperties)
      }
    />
  );
}
