import type { Ref } from "react";
import { usePublishSheetJoin } from "./sheet-join-context";
import { useSelectionTravelling } from "./strip-selection-travel";

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
  usePublishSheetJoin(travelling ? "canvas" : null, null);
  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="tab-selection-traveller"
      hidden={!travelling}
      // The join rule in `index.css` paints it exactly like a joined tab box:
      // the canvas fill, the sheet's border, open at the bottom.
      {...(travelling ? { "data-sheet-joined": "top" } : {})}
      className="pointer-events-none absolute top-0 left-0 rounded-xl border"
    />
  );
}
