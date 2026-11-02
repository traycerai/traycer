import { use, type ReactNode } from "react";
import * as m from "motion/react-m";
import { useHeaderTabOverlayFadeTransition } from "../tab-chrome-tokens";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { joinedAttribute, useSideTabJoin } from "./side-tab-join";
import { Plus } from "lucide-react";
import {
  useEpicDndStore,
  type HeaderTabDragGhost,
} from "@/components/epic-canvas/dnd/dnd-store";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { useRegisteredEpicTitleGenerating } from "@/lib/epic-selectors";
import { useSideStripCollapsed } from "@/stores/layout/side-tab-strip-store";
import {
  groupNeedsYouByEpic,
  useNeedsYouItems,
} from "@/stores/notifications/needs-you-items";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { tabAppearance, type HeaderTab } from "@/stores/tabs/types";
import type {
  HeaderStripItem,
  HeaderStripMember,
} from "@/stores/tabs/use-header-tabs";
import type { HeaderTabDragData } from "../header-tab-dnd";
import { splitSlotLabel, useHeaderTabTitle } from "../header-tab-presentation";
import { TabLeadingIcon } from "../tab-leading-icon";
import type { SideTabLiveAgents } from "./agent-meter";
import { NO_LIVE_AGENTS, useSideTabLiveAgents } from "./side-tab-live-agents";
import { railBadgeOf } from "./rail-badge-kind";
import { sideTabTileOf, sideTabTitleIconOf } from "../tab-identity";
import { cn } from "@/lib/utils";
import { SideSplitIcon, SideSplitRow } from "./side-split-row";
import { SIDE_SPLIT_HALF_EMPTY_CLASS } from "./side-strip-tokens";
import {
  SideTabRow,
  type SideTabRowShape,
  type SideTabRowVariant,
} from "./side-tab-row";
import { useLiveAgentsInStrip } from "./strip-agents-mode";
import { sectionStyleOf, taskStatusOf } from "./strip-section-row";
import { stripTaskRowOf, type StripTaskRow } from "./strip-sections";

/**
 * The dragged object of a vertical strip drag: the row (or the split pair)
 * itself at the source's measured size, in the variant the strip is in, so
 * the thing under the pointer is the thing that was picked up. Appearance and
 * notification state come from the drag ghost captured at drag start; a
 * split's other half reads them live.
 */
export function SideTabDragOverlay(props: {
  readonly item: HeaderStripItem;
  readonly ghost: HeaderTabDragGhost | null;
  readonly size: { readonly width: number; readonly height: number } | null;
  readonly source: HeaderTabDragData;
  readonly isActive: boolean;
}): ReactNode {
  const { item, source } = props;
  const collapsed = useSideStripCollapsed();
  const tearOff = useEpicDndStore((state) => state.headerTearOffPreview);
  // Faded out while a split preview shows: it covers the preview, which says
  // where the row goes, and even ghosted its title drew over the target's.
  const mergeTargeted = useEpicDndStore(
    (state) => state.topLevelStripPairPreview !== null,
  );
  const fade = useHeaderTabOverlayFadeTransition();
  const variant: SideTabRowVariant = collapsed ? "collapsed" : "expanded";
  const draggedMember =
    item.kind === "split"
      ? [item.left, item.right].find(
          (member) =>
            member.kind === "tab" &&
            member.tab.kind === source.tabKind &&
            member.tab.id === source.tabId,
        )
      : undefined;
  const lone = item.kind === "tab" ? item.tab : null;
  const tornMember =
    tearOff && draggedMember?.kind === "tab" ? draggedMember.tab : null;
  const single = lone ?? tornMember;
  // A torn-off split member is one row at its own size, not the pair's.
  const size = tornMember === null ? props.size : null;
  return (
    <m.div
      data-testid="header-tab-drag-overlay"
      data-merge-targeted={mergeTargeted}
      initial={false}
      animate={{ opacity: mergeTargeted ? 0 : 1 }}
      transition={fade}
      className="pointer-events-none flex cursor-grabbing flex-col select-none"
      style={
        size === null ? undefined : { width: size.width, height: size.height }
      }
    >
      {single !== null ? (
        <OverlayTabRow
          tab={single}
          ghost={props.ghost}
          variant={variant}
          shape="row"
          active={props.isActive}
          // Faded out over a split preview, it does not join the sheet either.
          join={tornMember === null && !mergeTargeted}
        />
      ) : null}
      {single === null && item.kind === "split" ? (
        <OverlaySplitPair
          item={item}
          draggedMember={draggedMember}
          ghost={props.ghost}
          isActive={props.isActive}
          variant={variant}
        />
      ) : null}
    </m.div>
  );
}

function OverlaySplitPair(props: {
  readonly item: Extract<HeaderStripItem, { readonly kind: "split" }>;
  readonly draggedMember: HeaderStripMember | undefined;
  readonly ghost: HeaderTabDragGhost | null;
  readonly isActive: boolean;
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const { item, draggedMember } = props;
  const focusedSide = props.isActive ? item.focusedSide : null;
  const edge = use(ColumnEdgeContext);
  const edgeMember = edge === null ? null : item[edge];
  const joined = useSideTabJoin(
    props.isActive,
    null,
    edgeMember?.kind === "tab" ? edgeMember.tab : null,
  );
  const shapeOf = (side: "left" | "right"): SideTabRowShape =>
    props.isActive && focusedSide !== side ? "on-screen-half" : "half";
  return (
    <SideSplitRow
      frame={joinedAttribute(joined)}
      variant={props.variant}
      testId={`split-tab-group-overlay-${item.id}`}
      icon={
        <SideSplitIcon
          splitId={`${item.id}-overlay`}
          focusedSide={item.focusedSide}
          engaged={props.isActive}
        />
      }
      left={
        <OverlayMember
          member={item.left}
          ghost={item.left === draggedMember ? props.ghost : null}
          focused={focusedSide === "left"}
          shape={shapeOf("left")}
          variant={props.variant}
        />
      }
      right={
        <OverlayMember
          member={item.right}
          ghost={item.right === draggedMember ? props.ghost : null}
          focused={focusedSide === "right"}
          shape={shapeOf("right")}
          variant={props.variant}
        />
      }
      detail={null}
    />
  );
}

function OverlayMember(props: {
  readonly member: HeaderStripMember;
  readonly ghost: HeaderTabDragGhost | null;
  readonly focused: boolean;
  readonly shape: SideTabRowShape;
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const { member } = props;
  if (member.kind === "tab") {
    return (
      <OverlayTabRow
        tab={member.tab}
        ghost={props.ghost}
        variant={props.variant}
        shape={props.shape}
        active={props.focused}
        join={false}
      />
    );
  }
  const unavailable = member.slot.kind === "unavailable";
  const label = unavailable ? splitSlotLabel(member.slot) : "Choose a view";
  const icon = <Plus className="size-4" />;
  return (
    <SideTabRow
      frame={{
        className: unavailable
          ? "text-destructive"
          : cn(
              "italic",
              props.variant === "expanded" && SIDE_SPLIT_HALF_EMPTY_CLASS,
            ),
      }}
      variant={props.variant}
      shape={props.shape}
      active={props.focused}
      session={null}
      tint={null}
      inBlock={false}
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
      dropIndicator={null}
      pairPreview={null}
      dragSource={false}
    />
  );
}

/**
 * What the dragged row draws in the Activity view, from the drag's captured
 * indicator and the live prompts and agents, so the thing under the pointer is
 * the section row that was picked up; `null` in the Layered view and the rail. The time a
 * To review row shows is not carried, only the section's own data is.
 */
function useOverlayStripRow(
  epicId: string | null,
  indicator: NotificationIndicatorState,
  agents: SideTabLiveAgents,
  variant: SideTabRowVariant,
): StripTaskRow | null {
  const sectioned = useLiveAgentsInStrip() && variant === "expanded";
  const items = useNeedsYouItems();
  if (!sectioned) return null;
  return stripTaskRowOf({
    indicator,
    agents,
    needsYou:
      epicId === null ? [] : (groupNeedsYouByEpic(items).get(epicId) ?? []),
    reviewTimes: { done: null, failed: null },
  });
}

/** One tab as a row: the ghost's captured state when given, else the live reads. */
function OverlayTabRow(props: {
  readonly tab: HeaderTab;
  readonly ghost: HeaderTabDragGhost | null;
  readonly variant: SideTabRowVariant;
  readonly shape: SideTabRowShape;
  readonly active: boolean;
  readonly join: boolean;
}): ReactNode {
  const { tab, ghost } = props;
  const half = props.shape !== "row";
  const joined = useSideTabJoin(props.active && props.join, null, tab);
  const epicId = tab.kind === "epic" ? tab.epicId : null;
  const { resolvedTabName, displayName } = useHeaderTabTitle(tab);
  const liveIndicator = useSurfaceNotificationIndicatorState(
    { epicId: epicId ?? tab.id },
    null,
  );
  const activityStatus = useEpicActivityStatus(epicId);
  const agents = useSideTabLiveAgents(epicId);
  const titleGenerating = useRegisteredEpicTitleGenerating(epicId);
  const appearance = ghost === null ? tabAppearance(tab) : ghost.appearance;
  const indicatorState = ghost?.indicatorState ?? liveIndicator;
  const row = useOverlayStripRow(epicId, indicatorState, agents, props.variant);
  const leading = (
    <TabLeadingIcon
      icon={tab.icon}
      identity={null}
      titleGenerationPending={titleGenerating}
      activityStatus={activityStatus}
      indicatorState={indicatorState}
      tabId={tab.id}
    />
  );
  return (
    <SideTabRow
      frame={joinedAttribute(joined)}
      variant={props.variant}
      shape={props.shape}
      active={props.active}
      session={null}
      tint={appearance?.color ?? null}
      inBlock={false}
      titleIcon={sideTabTitleIconOf({ appearance, icon: tab.icon })}
      tile={sideTabTileOf({
        appearance,
        title: resolvedTabName,
        titleGenerating,
        fallback: leading,
      })}
      badge={railBadgeOf(indicatorState)}
      agents={agents}
      status={taskStatusOf({
        row,
        tabId: tab.id,
        indicator: indicatorState,
        agents,
        activityStatus,
        titleGenerating,
        group: null,
        half,
      })}
      // The dragged row travels without its agents, so it names their requests.
      section={row === null ? null : sectionStyleOf(row, half, null)}
      disclosure={null}
      title={displayName}
      hoverCardBody={displayName}
      hoverCardOnOverflow={false}
      leaderBadge={null}
      close={null}
      dropIndicator={null}
      pairPreview={null}
      dragSource={false}
    />
  );
}
