import { use, type ReactNode } from "react";
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
import { tabAppearance, type HeaderTab } from "@/stores/tabs/types";
import type {
  HeaderStripItem,
  HeaderStripMember,
} from "@/stores/tabs/use-header-tabs";
import type { HeaderTabDragData } from "../header-tab-dnd";
import { splitSlotLabel, useHeaderTabTitle } from "../header-tab-presentation";
import { TabLeadingIcon } from "../tab-leading-icon";
import { NO_LIVE_AGENTS, useSideTabLiveAgents } from "./side-tab-live-agents";
import { railBadgeOf } from "./rail-badge-kind";
import { sideTabTileOf, sideTabTitleIconOf } from "../tab-identity";
import { SideSplitRowPair } from "./side-split-row-pair";
import { SideTabRow, type SideTabRowVariant } from "./side-tab-row";
import { sideTabStatusOf } from "./side-tab-status";
import { SideTabStatusGlyph } from "./side-tab-status-glyph";

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
  // Ghosted while a merge target is highlighted, which this overlay covers.
  const mergeTargeted = useEpicDndStore(
    (state) => state.topLevelStripPairPreview !== null,
  );
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
    <div
      data-testid="header-tab-drag-overlay"
      data-merge-targeted={mergeTargeted}
      className="pointer-events-none flex cursor-grabbing flex-col select-none data-[merge-targeted=true]:opacity-45"
      style={
        size === null ? undefined : { width: size.width, height: size.height }
      }
    >
      {single !== null ? (
        <OverlayTabRow
          tab={single}
          ghost={props.ghost}
          variant={variant}
          active={props.isActive}
          join={tornMember === null}
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
    </div>
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
  return (
    <SideSplitRowPair
      frame={joinedAttribute(joined)}
      variant={props.variant}
      testId={`split-tab-group-overlay-${item.id}`}
      first={
        <OverlayMember
          member={item.left}
          ghost={item.left === draggedMember ? props.ghost : null}
          focused={focusedSide === "left"}
          variant={props.variant}
        />
      }
      second={
        <OverlayMember
          member={item.right}
          ghost={item.right === draggedMember ? props.ghost : null}
          focused={focusedSide === "right"}
          variant={props.variant}
        />
      }
    />
  );
}

function OverlayMember(props: {
  readonly member: HeaderStripMember;
  readonly ghost: HeaderTabDragGhost | null;
  readonly focused: boolean;
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const { member } = props;
  if (member.kind === "tab") {
    return (
      <OverlayTabRow
        tab={member.tab}
        ghost={props.ghost}
        variant={props.variant}
        active={props.focused}
        join={false}
      />
    );
  }
  const label = splitSlotLabel(member.slot);
  const icon = <Plus className="size-4" />;
  return (
    <SideTabRow
      frame={{ className: "italic" }}
      variant={props.variant}
      active={props.focused}
      session={null}
      tint={null}
      groupLine={null}
      titleIcon={<Plus className="size-3.5 me-1.5" />}
      tile={{ kind: "icon", icon }}
      badge={null}
      agents={NO_LIVE_AGENTS}
      status={null}
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

/** One tab as a row: the ghost's captured state when given, else the live reads. */
function OverlayTabRow(props: {
  readonly tab: HeaderTab;
  readonly ghost: HeaderTabDragGhost | null;
  readonly variant: SideTabRowVariant;
  readonly active: boolean;
  readonly join: boolean;
}): ReactNode {
  const { tab, ghost } = props;
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
      active={props.active}
      session={null}
      tint={appearance?.color ?? null}
      groupLine={null}
      titleIcon={sideTabTitleIconOf({ appearance, icon: tab.icon })}
      tile={sideTabTileOf({
        appearance,
        title: resolvedTabName,
        titleGenerating,
        fallback: leading,
      })}
      badge={railBadgeOf(indicatorState)}
      agents={agents}
      status={sideTabStatusOf({
        indicator: indicatorState,
        agents,
        meterHidden: false,
        glyph: (
          <SideTabStatusGlyph
            tabId={tab.id}
            indicatorState={indicatorState}
            activityStatus={activityStatus}
            titleGenerating={titleGenerating}
          />
        ),
      })}
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
