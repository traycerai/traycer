import { useState, type CSSProperties } from "react";
import { usePublishSheetJoin } from "./sheet-join-context";
import { cn } from "@/lib/utils";
import { TAB_BOX_CLASS } from "./tab-chrome-tokens";
import { useWhollyInTabStrip } from "./use-wholly-in-tab-strip";

/**
 * The selected header tab's box. `joined` runs it into its task's sheet (the
 * sheet join in `index.css`, which supersedes staging round 1's F4 "boxy"
 * ruling): from md the box takes the canvas fill and the sheet's border,
 * opens at the bottom, and the column's bridge runs it down onto the sheet.
 * Joined, the whole outline - the box's sides and top, then the bridge's sides
 * and its two feet - is drawn in `borderColor` (`--join-outline`), so a
 * coloured tab traces its full silhouette in its colour exactly as an
 * uncoloured one does in the sheets' border. Unjoined - the layout editor's
 * session tab, or below md - it is the self-contained box in the sheets' own
 * material.
 */
export function TabChromeBackground(props: {
  readonly fill: string;
  readonly borderColor: string;
  readonly joined: boolean;
  readonly className: string | undefined;
}) {
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const inStrip = useWhollyInTabStrip(node, props.joined);
  usePublishSheetJoin(
    props.joined && inStrip ? "canvas" : null,
    props.borderColor,
  );
  return (
    <span
      ref={setNode}
      aria-hidden
      data-testid="tab-chrome-box"
      {...(props.joined && inStrip ? { "data-sheet-joined": "top" } : {})}
      className={cn(
        TAB_BOX_CLASS,
        "border border-(--swatch-border) bg-(--swatch)",
        props.className,
      )}
      style={
        {
          "--swatch": props.fill,
          "--swatch-border": props.borderColor,
          "--join-outline": props.borderColor,
        } as CSSProperties
      }
    />
  );
}

/**
 * A coloured tab's colour where the tab has no box of its own to wear it: an
 * edge-to-edge line along the tab's bottom, the treatment every coloured tab
 * had before #2021 swapped it for a short centred dash. Restored for every
 * coloured tab - lone, group member or split member - because the dash is what
 * the owner reported as the regression on a lone tab. Adjacent group members'
 * lines also sit flush, which is what still reads a group as one unit.
 */
export function TabColorEdgeLine(props: { readonly color: string }) {
  return (
    <span
      aria-hidden
      data-testid="tab-color-edge-line"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[1.5px] bg-(--swatch)"
      style={{ "--swatch": props.color } as CSSProperties}
    />
  );
}
