import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as m from "motion/react-m";
import { useAppearanceHeaderStripItem } from "@/stores/tabs/use-header-tabs";
import type { HeaderTab } from "@/stores/tabs/types";
import { useHeaderTabDisplacementTransition } from "../tab-chrome-tokens";
import {
  useStripTabItem,
  type HeaderTabDndConfig,
} from "../use-strip-tab-item";
import { useStripItemDisplacement } from "../use-strip-item-displacement";
import {
  stripTabItemInputOf,
  type SideStripItemProps,
} from "./side-strip-item-input";
import { SideSplitItem } from "./side-strip-split-item";
import { SideStripTabRow } from "./side-strip-tab-row";
import { StripAgentGroup } from "./strip-agent-group";
import { memberRowOf } from "./strip-sections";
import { useStripTaskGroup } from "./strip-task-group";
import { useSideTabJoin } from "./side-tab-join";

/** One strip item, a lone tab or a split pair, with its reorder frame. */
export const SideStripItem = memo(function SideStripItem(
  props: SideStripItemProps,
): ReactNode {
  const item = useAppearanceHeaderStripItem(props.itemId);
  if (item === null) return null;
  if (item.kind === "split") return <SideSplitItem {...props} item={item} />;
  return <SideTabItem {...props} tab={item.tab} />;
});

/** A lone tab: its reorder frame, displaced along y, around its row. */
function SideTabItem(
  props: SideStripItemProps & { readonly tab: HeaderTab },
): ReactNode {
  const transition = useHeaderTabDisplacementTransition();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const y = useStripItemDisplacement({
    nodeRef: frameRef,
    offset: props.offset,
    transition,
  });
  const dnd = useMemo<HeaderTabDndConfig>(
    () => ({
      stripItemId: props.itemId,
      index: props.stripIndex,
      isDropSlot: true,
    }),
    [props.itemId, props.stripIndex],
  );
  const input = stripTabItemInputOf(
    {
      tab: props.tab,
      index: props.memberOffset,
      dnd,
      isActive: props.isActive,
    },
    props.handlers,
  );
  const { rootRef, ...item } = useStripTabItem(input);
  const [rowNode, setRowNode] = useState<HTMLDivElement | null>(null);
  const bindRow = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef(node);
      setRowNode(node);
    },
    [rootRef],
  );
  const joined = useSideTabJoin(
    props.isActive && !item.isDragging,
    rowNode,
    props.tab,
  );
  const section = memberRowOf(props.members, props.tab);
  const group = useStripTaskGroup(props.tab, props.isActive, section);
  return (
    <m.div
      ref={frameRef}
      initial={false}
      // Hidden on the frame the overlay first paints, so the column never
      // shows two copies of the dragged row.
      animate={{ opacity: item.isDragging ? 0 : 1 }}
      style={{ y }}
      transition={transition}
      data-strip-item-id={props.itemId}
      data-strip-item-mergeable="true"
      data-strip-lane={props.lane ?? undefined}
      className="relative flex flex-col"
    >
      <SideStripTabRow
        item={item}
        rootRef={bindRow}
        input={input}
        variant={props.variant}
        shape="row"
        inBlock={props.inBlock}
        dropIndicator={props.dropIndicator}
        joined={joined}
        group={group}
        section={section}
      />
      <StripAgentGroup group={group} caption={null} />
    </m.div>
  );
}
