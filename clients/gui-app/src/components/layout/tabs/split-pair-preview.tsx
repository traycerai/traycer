import type { ReactNode } from "react";
import { useActiveHeaderTab } from "@/components/epic-canvas/dnd/dnd-store";
import type { MergeSide } from "@/components/epic-canvas/dnd/strip-drag-model";
import { cn } from "@/lib/utils";
import { useAppearanceHeaderStripItem } from "@/stores/tabs/use-header-tabs";
import type { HeaderTab } from "@/stores/tabs/types";
import { useHeaderTabTitle } from "./header-tab-presentation";
import { SplitFocusIcon } from "./split-tab-chrome";
import {
  SIDE_SPLIT_HALF_CLASS,
  SIDE_SPLIT_HALF_PREVIEW_CLASS,
  SIDE_SPLIT_HALF_REST_CLASS,
  SIDE_TAB_TITLE_CLASS,
} from "./side-strip/side-strip-tokens";

/** How each strip lays the pair out inside the item it previews on. */
const PLACEMENT = {
  // Across the row to 2px from its edges, as a pair row's halves are.
  side: {
    frame: "-mx-1.5 flex-1",
    iconSlot: "size-6",
    icon: "size-4",
    half: SIDE_SPLIT_HALF_CLASS,
    title: cn(SIDE_TAB_TITLE_CLASS, "truncate"),
  },
  // Over the tab's own box, so the halves sit concentric inside its corners.
  // A tab too narrow for the icon and two titles gives up the icon first.
  "top-bar": {
    frame: "absolute inset-0.5 z-20 px-0.5",
    iconSlot: "size-6 @max-[8rem]:hidden",
    icon: "size-5",
    half: "h-7 min-w-0 flex-1 basis-0 rounded-lg px-2",
    title: "header-tab-title-text",
  },
} as const;

/**
 * What a task draws while a drop over it would split with it: the pair it will
 * become, in place. The split icon with the dragged task's pane filled, the
 * task's own title in one half and the dragged task in the other, on the side
 * the drop will put it, titled and outlined in info blue.
 */
export function SplitPairPreview(props: {
  readonly placement: keyof typeof PLACEMENT;
  readonly side: MergeSide;
  /** The previewing task's own title. */
  readonly title: string;
  /** On the dragged task's half. */
  readonly testId: string;
}): ReactNode {
  const placement = PLACEMENT[props.placement];
  const dragged = useActiveHeaderTab();
  const item = useAppearanceHeaderStripItem(dragged?.stripItemId ?? "");
  const own = (
    <span
      className={cn(
        placement.half,
        SIDE_SPLIT_HALF_REST_CLASS,
        "flex items-center",
      )}
    >
      <PreviewTitle title={props.title} className={placement.title} />
    </span>
  );
  const incoming = (
    <span
      data-testid={props.testId}
      data-side={props.side}
      className={cn(
        placement.half,
        SIDE_SPLIT_HALF_PREVIEW_CLASS,
        "flex items-center",
      )}
    >
      {item?.kind === "tab" ? (
        <DraggedTitle tab={item.tab} className={placement.title} />
      ) : null}
    </span>
  );
  return (
    <span className={cn("flex min-w-0 items-center gap-1", placement.frame)}>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center text-info-foreground",
          placement.iconSlot,
        )}
      >
        <SplitFocusIcon
          splitId="preview"
          focusedSide={props.side}
          size={placement.icon}
        />
      </span>
      {props.side === "left" ? incoming : own}
      {props.side === "left" ? own : incoming}
    </span>
  );
}

function DraggedTitle(props: {
  readonly tab: HeaderTab;
  readonly className: string;
}): ReactNode {
  return (
    <PreviewTitle
      title={useHeaderTabTitle(props.tab).displayName}
      className={props.className}
    />
  );
}

function PreviewTitle(props: {
  readonly title: string;
  readonly className: string;
}): ReactNode {
  return (
    <span className={cn("block min-w-0 flex-1", props.className)}>
      {props.title}
    </span>
  );
}
