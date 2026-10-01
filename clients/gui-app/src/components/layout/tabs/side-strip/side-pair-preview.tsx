import type { ReactNode } from "react";
import { useActiveHeaderTab } from "@/components/epic-canvas/dnd/dnd-store";
import type { MergeSide } from "@/components/epic-canvas/dnd/strip-drag-model";
import { cn } from "@/lib/utils";
import { useAppearanceHeaderStripItem } from "@/stores/tabs/use-header-tabs";
import type { HeaderTab } from "@/stores/tabs/types";
import { useHeaderTabTitle } from "../header-tab-presentation";
import { SplitFocusIcon } from "../split-tab-chrome";
import {
  SIDE_SPLIT_HALF_CLASS,
  SIDE_SPLIT_HALF_PREVIEW_CLASS,
  SIDE_SPLIT_HALF_REST_CLASS,
  SIDE_TAB_TITLE_CLASS,
} from "./side-strip-tokens";

/**
 * What a row draws while a drop over it would split with it: the pair it will
 * become, in place. The split icon with the dragged task's pane filled, the
 * row's own task in one half and the dragged task in the other, on the side
 * the drop will put it, titled and outlined in info blue. It spans the row to
 * 2px from its edges, as a pair row's halves do.
 */
export function SidePairPreview(props: {
  readonly side: MergeSide;
  /** The row's own task title. */
  readonly title: string;
}): ReactNode {
  const dragged = useActiveHeaderTab();
  const item = useAppearanceHeaderStripItem(dragged?.stripItemId ?? "");
  const own = (
    <span
      className={cn(
        SIDE_SPLIT_HALF_CLASS,
        SIDE_SPLIT_HALF_REST_CLASS,
        "flex items-center",
      )}
    >
      <PreviewTitle title={props.title} />
    </span>
  );
  const incoming = (
    <span
      data-testid="side-tab-pair-preview"
      data-side={props.side}
      className={cn(
        SIDE_SPLIT_HALF_CLASS,
        SIDE_SPLIT_HALF_PREVIEW_CLASS,
        "flex items-center",
      )}
    >
      {item?.kind === "tab" ? <DraggedTitle tab={item.tab} /> : null}
    </span>
  );
  return (
    <span className="-mx-1.5 flex min-w-0 flex-1 items-center gap-1">
      <span className="flex size-6 shrink-0 items-center justify-center text-info-foreground">
        <SplitFocusIcon
          splitId="preview"
          focusedSide={props.side}
          size="size-4"
        />
      </span>
      {props.side === "left" ? incoming : own}
      {props.side === "left" ? own : incoming}
    </span>
  );
}

function DraggedTitle(props: { readonly tab: HeaderTab }): ReactNode {
  return <PreviewTitle title={useHeaderTabTitle(props.tab).displayName} />;
}

function PreviewTitle(props: { readonly title: string }): ReactNode {
  return (
    <span className={cn(SIDE_TAB_TITLE_CLASS, "block min-w-0 flex-1 truncate")}>
      {props.title}
    </span>
  );
}
