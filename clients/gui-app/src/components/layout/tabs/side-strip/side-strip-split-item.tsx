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
import { cn } from "@/lib/utils";
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
import { useSplitMemberLabel } from "../header-tab-presentation";
import { SplitQuickActions } from "../split-quick-actions";
import { SplitFocusIcon } from "../split-tab-chrome";
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
import { SideSplitIcon, SideSplitRow } from "./side-split-row";
import { SideStripTabRow } from "./side-strip-tab-row";
import {
  SIDE_SPLIT_CAPTION_CLASS,
  SIDE_SPLIT_DETAIL_INSET_CLASS,
  SIDE_SPLIT_HALF_EMPTY_CLASS,
} from "./side-strip-tokens";
import { StripAgentGroup } from "./strip-agent-group";
import { PairNeedsYouDetail, PairToReviewDetail } from "./strip-section-detail";
import { needsYouLineOf } from "./strip-section-row";
import {
  memberRowOf,
  type NeedsYouRow,
  type StripTaskRow,
  type ToReviewRow,
} from "./strip-sections";
import { useStripTaskGroup, type StripTaskGroup } from "./strip-task-group";
import { joinedAttribute, useSideTabJoin } from "./side-tab-join";
import {
  SideTabRow,
  type SideRowFrame,
  type SideTabRowShape,
  type SideTabRowVariant,
} from "./side-tab-row";
import { NO_LIVE_AGENTS } from "./side-tab-live-agents";

/**
 * A split pair: one reorder frame (the split's drop slot, never a merge target)
 * around one row of the split icon and two halves, each a tab of its own. The
 * icon is the top bar's split actions button. In the Activity view the row
 * draws its halves' Needs you or To review line, and each half's agents
 * follow it, the left half's first, under a caption naming that half when
 * both halves list agents.
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
  const leftSection = memberRowOf(props.members, memberTab(item.left));
  const rightSection = memberRowOf(props.members, memberTab(item.right));
  const leftGroup = useStripTaskGroup(
    memberTab(item.left),
    focusedSide === "left",
    leftSection,
  );
  const rightGroup = useStripTaskGroup(
    memberTab(item.right),
    focusedSide === "right",
    rightSection,
  );
  const leftLabel = useSplitMemberLabel(item.left);
  const rightLabel = useSplitMemberLabel(item.right);
  const shapeOf = (side: "left" | "right"): SideTabRowShape =>
    props.isActive && focusedSide !== side ? "on-screen-half" : "half";
  const member = (side: "left" | "right"): ReactNode => (
    <SideSplitMember
      member={side === "left" ? item.left : item.right}
      group={side === "left" ? leftGroup : rightGroup}
      section={side === "left" ? leftSection : rightSection}
      partner={memberTab(side === "left" ? item.right : item.left)}
      side={side}
      focused={focusedSide === side}
      shape={shapeOf(side)}
      splitId={item.id}
      stripIndex={stripIndex}
      memberIndex={
        side === "left"
          ? props.memberOffset
          : props.memberOffset + Number(item.left.kind === "tab")
      }
      variant={props.variant}
      inBlock={props.inBlock}
      dropIndicator={
        (side === "left" && props.dropIndicator === "before") ||
        (side === "right" && props.dropIndicator === "after")
          ? props.dropIndicator
          : null
      }
      handlers={props.handlers}
    />
  );
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
    "aria-label": `Split view: ${leftLabel} and ${rightLabel}`,
    "data-active": props.isActive ? "true" : "false",
    ...joinedAttribute(joined),
  };
  const quickActionsTab = memberTab(item.left) ?? memberTab(item.right);
  const expanded = props.variant === "expanded";
  const halves = [
    { row: leftSection, group: leftGroup },
    { row: rightSection, group: rightGroup },
  ];
  // A half whose expanded agents below say all its requests drops off the line.
  const needsYou = halves.flatMap((half) => {
    if (half.row?.section !== "needs-you") return [];
    const line = needsYouLineOf(half.row, half.group);
    return line === null ? [] : [line];
  });
  const toReview = halves.flatMap((half) =>
    half.row?.section === "to-review" ? [half.row] : [],
  );
  // A caption tells two halves' agents apart; one half's need no name.
  const captioned = halves.every((half) => (half.group?.rows.length ?? 0) > 0);
  return (
    <m.div
      ref={setFrameRef}
      initial={false}
      animate={{ opacity: isDragging ? 0 : 1 }}
      style={{ y }}
      transition={transition}
      data-strip-item-id={item.id}
      data-strip-item-mergeable="false"
      data-strip-lane={props.lane ?? undefined}
      className="relative flex flex-col"
    >
      <SideSplitRow
        frame={pairFrame}
        variant={props.variant}
        testId={`split-tab-group-${item.id}`}
        icon={
          quickActionsTab === null ? (
            <SideSplitIcon
              splitId={item.id}
              focusedSide={item.focusedSide}
              engaged={props.isActive}
            />
          ) : (
            <SplitQuickActions
              splitId={item.id}
              tab={quickActionsTab}
              focusedSide={item.focusedSide}
              engaged={props.isActive}
              placement={expanded ? "side-row" : "rail"}
              onSplitCommand={props.handlers.onSplitCommand}
            />
          )
        }
        left={member("left")}
        right={member("right")}
        detail={
          expanded ? (
            <PairDetail needsYou={needsYou} toReview={toReview} />
          ) : null
        }
      />
      {expanded ? (
        <>
          <StripAgentGroup
            group={leftGroup}
            caption={
              captioned ? (
                <SplitHalfCaption
                  splitId={item.id}
                  side="left"
                  title={leftLabel}
                />
              ) : null
            }
          />
          <StripAgentGroup
            group={rightGroup}
            caption={
              captioned ? (
                <SplitHalfCaption
                  splitId={item.id}
                  side="right"
                  title={rightLabel}
                />
              ) : null
            }
          />
        </>
      ) : null}
    </m.div>
  );
}

/**
 * The pair's second line in the Activity view: its Needs you line while a half
 * needs the person, else its To review line while a half is unread, else none.
 */
function PairDetail(props: {
  readonly needsYou: ReadonlyArray<NeedsYouRow>;
  readonly toReview: ReadonlyArray<ToReviewRow>;
}): ReactNode {
  if (props.needsYou.length > 0) {
    return (
      <PairNeedsYouDetail
        halves={props.needsYou}
        className={SIDE_SPLIT_DETAIL_INSET_CLASS}
      />
    );
  }
  if (props.toReview.length > 0) {
    return (
      <PairToReviewDetail
        halves={props.toReview}
        className={SIDE_SPLIT_DETAIL_INSET_CLASS}
      />
    );
  }
  return null;
}

function memberTab(member: HeaderStripMember): HeaderTab | null {
  return member.kind === "tab" ? member.tab : null;
}

/** Whose agents follow: a 12px split icon with that half's pane filled, then its title. */
function SplitHalfCaption(props: {
  readonly splitId: string;
  readonly side: "left" | "right";
  readonly title: string;
}): ReactNode {
  return (
    <span
      data-testid={`split-half-caption-${props.side}`}
      className={SIDE_SPLIT_CAPTION_CLASS}
    >
      <SplitFocusIcon
        splitId={`${props.splitId}-${props.side}`}
        focusedSide={props.side}
        size="size-3"
      />
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
    </span>
  );
}

interface SideSplitMemberProps {
  readonly member: HeaderStripMember;
  /** The agents nested under this half's task, drawn after the pair. */
  readonly group: StripTaskGroup | null;
  /** What this half draws in the Activity view's section; `null` in the Layered view. */
  readonly section: StripTaskRow | null;
  /** The other half's tab, which scopes an empty half's own menu. */
  readonly partner: HeaderTab | null;
  readonly side: "left" | "right";
  readonly focused: boolean;
  readonly shape: SideTabRowShape;
  readonly splitId: string;
  readonly stripIndex: number;
  readonly memberIndex: number;
  readonly variant: SideTabRowVariant;
  readonly inBlock: boolean;
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
      shape={props.shape}
      inBlock={props.inBlock}
      dropIndicator={props.dropIndicator}
      joined={null}
      group={props.group}
      section={props.section}
    />
  );
}

/**
 * An empty half of a split: "Choose a view" in a dashed outline, or
 * "Unavailable" in the error tone for a half whose tab is gone. Its click
 * focuses that side so the content area can offer its choices, and its menu is
 * the slot's own.
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
  const unavailable = props.slot.kind === "unavailable";
  const label = unavailable ? props.slot.label : "Choose a view";
  const icon = <Plus className="size-4" />;
  const frame: SideRowFrame = {
    role: "tab",
    tabIndex: 0,
    "aria-selected": props.focused,
    "aria-label": unavailable ? label : "Choose a view for this split side",
    "data-testid": `split-tab-placeholder-${side}`,
    onClick: focusSide,
    onFocus: focusSide,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      focusSide();
    },
    className: cn(
      "cursor-pointer [-webkit-app-region:no-drag]",
      unavailable
        ? "text-destructive hover:text-destructive"
        : cn(
            "italic",
            props.variant === "expanded" && SIDE_SPLIT_HALF_EMPTY_CLASS,
          ),
    ),
  };
  const row = (
    <SideTabRow
      frame={frame}
      variant={props.variant}
      shape={props.shape}
      active={props.focused}
      session={null}
      tint={null}
      inBlock={props.inBlock}
      titleIcon={unavailable ? null : <Plus className="size-3.5 me-1" />}
      tile={{ kind: "icon", icon }}
      badge={null}
      agents={NO_LIVE_AGENTS}
      status={null}
      section={null}
      disclosure={null}
      title={label}
      hoverCardBody={label}
      hoverCardOnOverflow={false}
      leaderBadge={null}
      close={null}
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
      <ContextMenuTrigger asChild>
        <div className="contents">{props.children}</div>
      </ContextMenuTrigger>
      <SplitSlotMenuContent
        partner={props.partner}
        onSplitCommand={props.onSplitCommand}
      />
    </ContextMenu>
  );
}
