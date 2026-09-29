import { useState, type CSSProperties } from "react";
import { usePublishSheetJoin } from "./sheet-join-context";
import { cn } from "@/lib/utils";
import { TAB_BOX_CLASS, TAB_COLOR_MARK_CLASS } from "./tab-chrome-tokens";
import { useWhollyInTabStrip } from "./use-wholly-in-tab-strip";

/**
 * The selected header tab's box. `joined` runs it into its task's sheet (the
 * sheet join in `index.css`, which supersedes staging round 1's F4 "boxy"
 * ruling): from md the box takes the canvas fill and the sheet's border,
 * opens at the bottom, and the column's bridge runs it down onto the sheet.
 * Unjoined - the layout editor's session tab or below md - it
 * is the self-contained box in the sheets' own material.
 */
export function TabChromeBackground(props: {
  readonly fill: string;
  readonly borderColor: string;
  readonly joined: boolean;
  readonly className: string | undefined;
}) {
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const inStrip = useWhollyInTabStrip(node, props.joined);
  usePublishSheetJoin(props.joined && inStrip ? "canvas" : null);
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
        } as CSSProperties
      }
    />
  );
}

/** A tab's colour where no box wears it: see `TAB_COLOR_MARK_CLASS`. */
export function TabColorMark(props: { readonly color: string }) {
  return (
    <span
      aria-hidden
      data-testid="tab-color-mark"
      className={TAB_COLOR_MARK_CLASS}
      style={{ "--swatch": props.color } as CSSProperties}
    />
  );
}
