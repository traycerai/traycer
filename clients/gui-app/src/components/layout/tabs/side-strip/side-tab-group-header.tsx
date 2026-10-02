import {
  useContext,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import { cn } from "@/lib/utils";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabGroup } from "@/stores/tabs/tab-groups";
import { GroupEditorAnchor } from "../group-editor-anchor";
import { railBadgeOf, worstRailBadge } from "./rail-badge-kind";
import type { SideTabRowVariant } from "./side-tab-row";
import { firstGraphemes } from "../tab-monogram";
import {
  SIDE_TAB_MONOGRAM_CHIP_CLASS,
  SIDE_TAB_MONOGRAM_CLASS,
  SIDE_TAB_TINT_FILL_CLASS,
} from "../tab-identity";
import { SideTabRailBadge } from "./side-tab-rail-badge";
import {
  SIDE_TAB_GROUP_COUNT_CLASS,
  SIDE_TAB_GROUP_HEADER_CLASS,
  SIDE_TAB_GROUP_NAME_CLASS,
  SIDE_TAB_HOVER_CLASS,
  SIDE_TAB_METER_CLASS,
  SIDE_TAB_RAIL_BADGE_POSITION_CLASS,
  SIDE_TAB_ROW_CLASS,
  SIDE_TAB_TILE_CLASS,
  SIDE_TAB_TILE_HOVER_CLASS,
} from "./side-strip-tokens";

export interface SideTabGroupHeaderProps {
  readonly groupId: string;
  readonly group: TabGroup;
  readonly variant: SideTabRowVariant;
  /** Tabs in this run of the group; a split counts each tab half. */
  readonly memberCount: number;
  /** Each member's notification entity, for a collapsed group's badge. */
  readonly memberEntities: ReadonlyArray<HostNotificationsEntityRef>;
  readonly onClose: (groupId: string) => void;
}

/**
 * A tab group's header in the vertical strip (S-19): expanded, the 28px top row
 * of the group's block (`SideTabGroupBlock`) with the name in the group's
 * colour, the member count only while the group is collapsed, and a chevron on
 * hover; in the rail the first tile
 * of the group's column (`SideTabGroupColumn`), 40x44, with the name's first
 * grapheme on a chip in the group colour. A click
 * collapses or expands the group; right-click, F2 and the context-menu keys
 * open the shared group editor. A collapsed group carries its members' worst
 * notification badge (S-30), at the trailing edge of its header.
 */
export function SideTabGroupHeader(props: SideTabGroupHeaderProps): ReactNode {
  const { groupId, group } = props;
  const label = `${group.name || "Unnamed group"}: ${group.collapsed ? "expand" : "collapse"} group`;
  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    useTabsStore
      .getState()
      .updateGroup(groupId, { collapsed: !group.collapsed });
  };
  return (
    <GroupEditorAnchor
      groupId={groupId}
      group={group}
      onClose={props.onClose}
      opensOnEnter={false}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={!group.collapsed}
        data-testid={`side-tab-group-header-${groupId}`}
        data-collapsed={group.collapsed}
        onClick={toggle}
        className={cn(
          "group/side-group relative flex shrink-0 items-center outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [-webkit-app-region:no-drag]",
          props.variant === "collapsed"
            ? cn(
                SIDE_TAB_TILE_CLASS,
                SIDE_TAB_TILE_HOVER_CLASS,
                "justify-center self-center text-muted-foreground hover:text-foreground",
              )
            : cn(
                SIDE_TAB_ROW_CLASS,
                SIDE_TAB_GROUP_HEADER_CLASS,
                SIDE_TAB_HOVER_CLASS,
                "text-muted-foreground hover:text-foreground",
              ),
        )}
        style={
          props.variant === "collapsed"
            ? ({ "--side-tab-tint": group.color } as CSSProperties)
            : undefined
        }
      >
        {props.variant === "collapsed" ? (
          <>
            <span
              aria-hidden
              className={cn(
                SIDE_TAB_MONOGRAM_CHIP_CLASS,
                SIDE_TAB_TINT_FILL_CLASS,
                SIDE_TAB_MONOGRAM_CLASS,
                "flex items-center justify-center",
              )}
            >
              {firstGrapheme(group.name)}
            </span>
            {/* The meter's footprint, so the chip lines up with the task tiles'. */}
            <span aria-hidden className={SIDE_TAB_METER_CLASS.tile} />
          </>
        ) : (
          <>
            {group.name ? (
              <span
                data-testid="side-tab-group-name"
                className={cn(
                  SIDE_TAB_GROUP_NAME_CLASS,
                  "min-w-0 truncate text-ui-xs",
                )}
              >
                {group.name}
              </span>
            ) : null}
            {group.collapsed ? (
              <span
                data-testid="side-tab-group-count"
                className={SIDE_TAB_GROUP_COUNT_CLASS}
              >
                {props.memberCount}
              </span>
            ) : null}
            <ChevronRight
              aria-hidden
              className={cn(
                "ml-auto size-3 opacity-0 transition-opacity group-hover/side-group:opacity-100 group-focus-visible/side-group:opacity-100",
                !group.collapsed && "rotate-90",
              )}
            />
          </>
        )}
        {group.collapsed ? (
          <CollapsedGroupBadge
            memberEntities={props.memberEntities}
            size={props.variant === "collapsed" ? "tile" : "leading"}
          />
        ) : null}
      </button>
    </GroupEditorAnchor>
  );
}

/**
 * A collapsed group's worst member notification, read from the strip's
 * indicator batch. Mounted only while the group is collapsed, so an expanded
 * header does not subscribe to the notifications store. Running is never a
 * badge: the meter carries it (D5).
 */
function CollapsedGroupBadge(props: {
  readonly memberEntities: ReadonlyArray<HostNotificationsEntityRef>;
  readonly size: "tile" | "leading";
}): ReactNode {
  const indicators = useContext(NotificationIndicatorsContext);
  const byId = useAppLocalNotificationsStore((state) => state.byId);
  const badge = worstRailBadge(
    props.memberEntities.map((entity) =>
      railBadgeOf(
        selectNotificationIndicatorState({ byId }, entity, null, indicators),
      ),
    ),
  );
  if (badge === null) return null;
  const mark = (
    <SideTabRailBadge
      kind={badge}
      size={props.size}
      testId="side-tab-group-badge"
    />
  );
  // A header's badge is its trailing status, in the row; a tile's is cut into
  // the tile's corner.
  if (props.size === "leading") return mark;
  return (
    <span
      className={cn(SIDE_TAB_RAIL_BADGE_POSITION_CLASS, "pointer-events-none")}
    >
      {mark}
    </span>
  );
}

function firstGrapheme(name: string): string {
  return firstGraphemes(name, 1).join("").toLocaleUpperCase();
}
