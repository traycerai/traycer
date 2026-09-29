import {
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Plus } from "lucide-react";
import * as m from "motion/react-m";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { useDroppable } from "@dnd-kit/core";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { SplitSide } from "@/stores/tabs/layout";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import type { HeaderTab } from "@/stores/tabs/types";
import type {
  HeaderStripItem,
  HeaderStripMember,
} from "@/stores/tabs/use-header-tabs";
import {
  HEADER_TAB_SLOT_DND_TYPE,
  getHeaderStripItemSlotDropId,
  type HeaderTabSlotDropData,
} from "../header-tab-dnd";
import { splitSlotLabel } from "../header-tab-presentation";
import { useHeaderTabDisplacementTransition } from "../tab-chrome-tokens";
import { SplitSlotMenuContent } from "../tab-strip-context-menu";
import {
  useStripTabItem,
  type HeaderTabDndConfig,
} from "../use-strip-tab-item";
import { useStripItemDisplacement } from "../use-strip-item-displacement";
import {
  stripTabItemInputOf,
  type DropIndicator,
  type SideStripHandlers,
  type SideStripItemProps,
} from "./side-strip-item-input";
import { SideSplitRowPair } from "./side-split-row-pair";
import { SideStripLiveAgentsSlot } from "./side-strip-live-agents-slot";
import { SideStripTabRow } from "./side-strip-tab-row";
import { joinedAttribute, useSideTabJoin } from "./side-tab-join";
import {
  SideTabRow,
  type SideGroupLine,
  type SideRowFrame,
  type SideTabRowVariant,
} from "./side-tab-row";
import { NO_LIVE_AGENTS } from "./side-tab-live-agents";

/**
 * A split pair: one reorder frame (the split's drop slot, never a merge
 * target) around two joined member rows, the left member on top (S-08). No
 * quick-actions control: the split commands are in each member's menu (S-31).
 */
export function SideSplitItem(
  props: SideStripItemProps & {
    readonly item: Extract<HeaderStripItem, { readonly kind: "split" }>;
  },
): ReactNode {
  const { item, stripIndex } = props;
  const dropData = useMemo<HeaderTabSlotDropData>(
    () => ({
      kind: HEADER_TAB_SLOT_DND_TYPE,
      index: stripIndex,
      isTrailing: false,
    }),
    [stripIndex],
  );
  const { setNodeRef } = useDroppable({
    id: getHeaderStripItemSlotDropId(item.id),
    data: dropData,
  });
  const isDragging = useEpicDndStore(
    (state) => state.activeHeaderTab?.stripItemId === item.id,
  );
  const transition = useHeaderTabDisplacementTransition();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const y = useStripItemDisplacement({
    nodeRef: frameRef,
    offset: props.offset,
    transition,
  });
  const setFrameRef = useCallback(
    (node: HTMLDivElement | null) => {
      frameRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  const focusedSide = props.isActive ? item.focusedSide : null;
  const member = (side: "left" | "right"): ReactNode => (
    <SideSplitMember
      member={side === "left" ? item.left : item.right}
      partner={memberTab(side === "left" ? item.right : item.left)}
      side={side}
      focused={focusedSide === side}
      splitId={item.id}
      stripIndex={stripIndex}
      memberIndex={
        side === "left"
          ? props.memberOffset
          : props.memberOffset + Number(item.left.kind === "tab")
      }
      variant={props.variant}
      groupLine={
        props.groupLine === null
          ? null
          : {
              color: props.groupLine,
              seat: side === "left" ? "pair-top" : "pair-bottom",
            }
      }
      dropIndicator={
        (side === "left" && props.dropIndicator === "before") ||
        (side === "right" && props.dropIndicator === "after")
          ? props.dropIndicator
          : null
      }
      handlers={props.handlers}
    />
  );
  // The focused half's live agents, right under that half and inside the
  // pair, so the pair stays one drag and join unit (D9).
  const liveAgents = (side: "left" | "right"): ReactNode =>
    focusedSide === side ? (
      <SideStripLiveAgentsSlot
        tab={memberTab(item[side])}
        active={props.isActive}
      />
    ) : null;
  // The pair joins as one unit.
  const [pairNode, setPairNode] = useState<HTMLDivElement | null>(null);
  const edge = use(ColumnEdgeContext);
  const joined = useSideTabJoin(
    props.isActive && !isDragging,
    pairNode,
    edge === null ? null : memberTab(item[edge]),
  );
  const pairFrame: SideRowFrame = {
    ref: setPairNode,
    role: "group",
    "aria-label": "Split tab group",
    "data-active": props.isActive ? "true" : "false",
    ...joinedAttribute(joined),
  };
  return (
    <m.div
      ref={setFrameRef}
      initial={false}
      animate={{ opacity: isDragging ? 0 : 1 }}
      style={{ y }}
      transition={transition}
      data-strip-item-id={item.id}
      data-strip-item-mergeable="false"
      className="relative flex flex-col"
    >
      <SideSplitRowPair
        frame={pairFrame}
        variant={props.variant}
        testId={`split-tab-group-${item.id}`}
        first={
          <>
            {member("left")}
            {liveAgents("left")}
          </>
        }
        second={
          <>
            {member("right")}
            {liveAgents("right")}
          </>
        }
      />
    </m.div>
  );
}

function memberTab(member: HeaderStripMember): HeaderTab | null {
  return member.kind === "tab" ? member.tab : null;
}

interface SideSplitMemberProps {
  readonly member: HeaderStripMember;
  /** The other half's tab, which scopes an empty half's own menu. */
  readonly partner: HeaderTab | null;
  readonly side: "left" | "right";
  readonly focused: boolean;
  readonly splitId: string;
  readonly stripIndex: number;
  readonly memberIndex: number;
  readonly variant: SideTabRowVariant;
  readonly groupLine: SideGroupLine | null;
  readonly dropIndicator: DropIndicator;
  readonly handlers: SideStripHandlers;
}

function SideSplitMember(props: SideSplitMemberProps): ReactNode {
  const { member } = props;
  if (member.kind === "fillable") {
    return <SideFillableMember {...props} slot={member.slot} />;
  }
  return <SideSplitTabMember {...props} tab={member.tab} />;
}

function SideSplitTabMember(
  props: SideSplitMemberProps & { readonly tab: HeaderTab },
): ReactNode {
  const dnd = useMemo<HeaderTabDndConfig>(
    () => ({
      stripItemId: props.splitId,
      index: props.stripIndex,
      isDropSlot: false,
    }),
    [props.splitId, props.stripIndex],
  );
  const input = stripTabItemInputOf(
    {
      tab: props.tab,
      index: props.memberIndex,
      dnd,
      isActive: props.focused,
    },
    props.handlers,
  );
  const { rootRef, ...item } = useStripTabItem(input);
  return (
    <SideStripTabRow
      item={item}
      rootRef={rootRef}
      input={input}
      variant={props.variant}
      groupLine={props.groupLine}
      dropIndicator={props.dropIndicator}
      joined={null}
    />
  );
}

/**
 * An empty half of a split: a muted row titled for what it offers, whose click
 * focuses that side so the content area can offer its choices.
 */
function SideFillableMember(
  props: SideSplitMemberProps & {
    readonly slot: Exclude<SplitSide, { readonly kind: "tab" }>;
  },
): ReactNode {
  const { splitId, side, partner } = props;
  const focusSide = useCallback(() => {
    tabCommandCoordinator.focusSplitSide({ splitId, side });
  }, [side, splitId]);
  const label = splitSlotLabel(props.slot);
  const icon = <Plus className="size-4" />;
  const frame: SideRowFrame = {
    role: "tab",
    tabIndex: 0,
    "aria-selected": props.focused,
    "aria-label":
      props.slot.kind === "unavailable"
        ? label
        : "Choose a view for this split side",
    "data-testid": `split-tab-placeholder-${side}`,
    onClick: focusSide,
    onFocus: focusSide,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      focusSide();
    },
    className: "cursor-pointer italic [-webkit-app-region:no-drag]",
  };
  const row = (
    <SideTabRow
      frame={frame}
      variant={props.variant}
      active={props.focused}
      session={null}
      tint={null}
      autoTint={null}
      groupLine={props.groupLine}
      leading={icon}
      tile={{ kind: "icon", icon }}
      badge={null}
      agents={NO_LIVE_AGENTS}
      title={label}
      hoverCardBody={label}
      leaderBadge={null}
      close={null}
      waitingLabel={null}
      dropIndicator={props.dropIndicator}
      pairPreview={null}
      dragSource={false}
    />
  );
  if (partner === null) return row;
  return (
    <FillableSlotMenu
      partner={partner}
      onSplitCommand={props.handlers.onSplitCommand}
    >
      {row}
    </FillableSlotMenu>
  );
}

/**
 * The empty half's own menu, scoped to its partner. The title-bar drag
 * regions stand down while it is open (S-44), so its items fire over the
 * strip's drag spacer.
 */
function FillableSlotMenu(props: {
  readonly partner: HeaderTab;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  useTitleBarDragSuppression(`split-slot-menu:${useId()}`, open);
  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger
        render={<div className="contents">{props.children}</div>}
      />
      <SplitSlotMenuContent
        partner={props.partner}
        onSplitCommand={props.onSplitCommand}
      />
    </ContextMenu>
  );
}
