import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { useState } from "react";
import type {
  AnimationEvent,
  ComponentPropsWithRef,
  CSSProperties,
  ReactElement,
  ReactNode,
} from "react";
import { X } from "lucide-react";
import * as m from "motion/react-m";
import type { MergeSide } from "@/components/epic-canvas/dnd/strip-drag-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropLine } from "@/components/ui/drop-line";
import { HoverCard } from "@/components/ui/hover-card";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { cn } from "@/lib/utils";
import { SESSION_TAB_LABEL_CLASS } from "../header-tab-visual";
import { MonogramChip } from "../monogram-chip";
import {
  SIDE_TAB_COLORLESS_TILE_CLASS,
  SIDE_TAB_TINT_FILL_CLASS,
  type SideTabTile,
} from "../tab-identity";
import { SideTabMeter, type SideTabLiveAgents } from "./agent-meter";
import { sideTabAgentsAreFloor } from "./side-tab-live-agents";
import { SideTabRailBadge } from "./side-tab-rail-badge";
import type { RailBadgeKind } from "./rail-badge-kind";
import {
  SIDE_TAB_ACTIVE_CLASS,
  SIDE_TAB_GROUP_LINE_CLASS,
  SIDE_TAB_DROP_LINE_SEAT_CLASS,
  SIDE_TAB_GROUP_LINE_SEAT_CLASS,
  SIDE_TAB_HOVER_CLASS,
  SIDE_TAB_LEADING_BADGE_POSITION_CLASS,
  SIDE_TAB_LEADING_CLASS,
  SIDE_TAB_LEADING_TILE_CLASS,
  SIDE_TAB_LEADING_TILE_SLOT_CLASS,
  SIDE_TAB_RAIL_BADGE_POSITION_CLASS,
  SIDE_TAB_ROW_CLASS,
  SIDE_TAB_SESSION_ACTIVE_CLASS,
  SIDE_TAB_TILE_ACTIVE_CLASS,
  SIDE_TAB_TILE_CLASS,
  SIDE_TAB_TILE_HOVER_CLASS,
  SIDE_TAB_TITLE_CLASS,
  SIDE_TAB_TRAILING_CLASS,
} from "./side-strip-tokens";
export type SideTabRowVariant = "expanded" | "collapsed";

/** Where a row sits for its group-line segment: alone, or as a split pair's top or bottom member. */
export type SideGroupLineSeat = "row" | "pair-top" | "pair-bottom";

/** A group member's segment of the group colour line. */
export interface SideGroupLine {
  /** The group colour. */
  readonly color: string;
  readonly seat: SideGroupLineSeat;
}

export interface SideTabRowClose {
  /** "Close <title>". */
  readonly label: string;
  /** `tab-close-<kind>-<id>`. */
  readonly testId: string;
  readonly disabled: boolean;
  readonly onClose: () => void;
}

/**
 * A row's (or a split pair's) element props: the div's own props plus its
 * data attributes. No `style`: the row's inline style is its tint alone, and a
 * strip moves a row through the frame around it.
 */
export type SideRowFrame = Omit<ComponentPropsWithRef<"div">, "style"> & {
  readonly [key: `data-${string}`]: string | number | boolean;
};

export interface SideTabRowProps {
  /**
   * The row element's own props (role, aria, data-*, handlers, ref, drag
   * listeners), spread onto it.
   */
  readonly frame: SideRowFrame;
  readonly variant: SideTabRowVariant;
  readonly active: boolean;
  /** Set only on the sample-workspace tab: its session state (L-163). */
  readonly session: "active" | "rest" | null;
  /** The tab colour, `#rrggbb`. */
  readonly tint: string | null;
  /**
   * The rail tile's monogram tint when the tab has no colour (D11): a stable
   * hue from the epic id, or `null` for a tab that is not a task.
   */
  readonly autoTint: string | null;
  /** The group line's segment, on a group member. */
  readonly groupLine: SideGroupLine | null;
  /**
   * Expanded: the status glyph, shown alone in the leading slot when the tab
   * has neither a custom icon nor a colour.
   */
  readonly leading: ReactNode;
  /**
   * The tab's tile: the collapsed row's content, and in the expanded row's
   * leading slot a custom icon, or a monogram when the tab has a colour.
   */
  readonly tile: SideTabTile;
  /**
   * The one state that needs the user (D5): the badge on whichever tile is
   * shown, the meter's attention pip, and what starts the entry pulse.
   */
  readonly badge: RailBadgeKind | null;
  /** The task's live agents, drawn by the meter. */
  readonly agents: SideTabLiveAgents;
  /**
   * The title. A string is painted as one faded line, the hover card carrying
   * it in full; any other node (the rename input) is rendered as given.
   */
  readonly title: ReactNode;
  /** What the hover card shows: the title, the state, the counts and, warm, the agents. */
  readonly hoverCardBody: ReactNode;
  readonly leaderBadge: ReactNode | null;
  readonly close: SideTabRowClose | null;
  readonly waitingLabel: "Approve" | "Reply" | null;
  readonly dropIndicator: "before" | "after" | null;
  /** `"left"` highlights the top half, `"right"` the bottom half. */
  readonly pairPreview: MergeSide | null;
  readonly dragSource: boolean;
}

/** Shows a hidden trailing control while the row is hovered or holds keyboard focus. */
const REVEAL_CLASS =
  "pointer-events-none opacity-0 group-hover/side-tab:pointer-events-auto group-hover/side-tab:opacity-100 group-focus-visible/side-tab:pointer-events-auto group-focus-visible/side-tab:opacity-100 group-has-[:focus-visible]/side-tab:pointer-events-auto group-has-[:focus-visible]/side-tab:opacity-100";

/** Hides the waiting chip while the close button takes its place. */
const YIELD_TO_CLOSE_CLASS =
  "group-hover/side-tab:opacity-0 group-focus-visible/side-tab:opacity-0 group-has-[:focus-visible]/side-tab:opacity-0";

/** Whether a tile paints the tab colour: a coloured tab whose title is not still generating. */
function tileTinted(tint: string | null, tile: SideTabTile): tint is string {
  return tint !== null && tile.kind !== "generating";
}

/** Where a rail tile's monogram tint comes from, if it has one. */
type TileTint = "tab" | "auto" | "none";

function tileTintOf(props: SideTabRowProps): TileTint {
  if (props.tile.kind === "generating") return "none";
  if (props.tint !== null) return "tab";
  return props.autoTint === null ? "none" : "auto";
}

/**
 * Pulses a row or tile twice when its task goes INTO waiting (approval or
 * reply): only on the transition, never on mount or a re-render, never in a
 * loop, and not at all while motion is off. The pulse ends with its animation.
 */
function useWaitingPulse(badge: RailBadgeKind | null): {
  readonly pulsing: boolean;
  readonly onAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => void;
} {
  const motionEnabled = useMotionEnabled();
  const waiting = badge === "approval" || badge === "reply";
  const [wasWaiting, setWasWaiting] = useState(waiting);
  const [pulsing, setPulsing] = useState(false);
  if (waiting !== wasWaiting) {
    setWasWaiting(waiting);
    setPulsing(waiting && motionEnabled);
  }
  const onAnimationEnd = (event: AnimationEvent<HTMLDivElement>): void => {
    if (event.animationName === "side-strip-waiting-pulse") setPulsing(false);
  };
  return { pulsing, onAnimationEnd };
}

/**
 * One tab in the vertical strip, as paint only: behaviour arrives through
 * `frame` and the state props. Expanded, the inline order is leading, title,
 * trailing on either strip edge; collapsed, the row is the 40x44 tile itself.
 */
export function SideTabRow(props: SideTabRowProps) {
  const { frame } = props;
  const collapsed = props.variant === "collapsed";
  const sessionActive = props.session === "active";
  const tileTint = collapsed ? tileTintOf(props) : "none";
  const pulse = useWaitingPulse(props.badge);
  return (
    <SideTabRowHoverCard
      allowed={hoverCardAllowed(props)}
      body={props.hoverCardBody}
    >
      <div
        {...frame}
        data-side-tab={props.variant}
        data-active={props.active}
        data-tile-kind={collapsed ? props.tile.kind : undefined}
        data-tinted={collapsed ? tileTint !== "none" : undefined}
        data-tint={collapsed ? tileTint : undefined}
        data-waiting-pulse={pulse.pulsing ? true : undefined}
        onAnimationEnd={(event) => {
          frame.onAnimationEnd?.(event);
          pulse.onAnimationEnd(event);
        }}
        className={cn(
          "group/side-tab relative flex items-center outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50",
          collapsed
            ? cn(SIDE_TAB_TILE_CLASS, "shrink-0 justify-center self-center")
            : SIDE_TAB_ROW_CLASS,
          collapsed
            ? collapsedFill(props)
            : expandedFill(props.active, sessionActive),
          props.dragSource && "opacity-0",
          frame.className,
        )}
      >
        {props.groupLine === null ? null : (
          <span
            aria-hidden
            data-testid="side-tab-group-line"
            data-seat={props.groupLine.seat}
            className={cn(
              SIDE_TAB_GROUP_LINE_CLASS,
              SIDE_TAB_GROUP_LINE_SEAT_CLASS[props.variant][
                props.groupLine.seat
              ],
              "pointer-events-none absolute bg-(--side-tab-group-line)",
            )}
            style={
              {
                "--side-tab-group-line": props.groupLine.color,
              } as CSSProperties
            }
          />
        )}
        {props.session === null ? null : (
          <SideSessionMark session={props.session} tint={props.tint} />
        )}
        {collapsed ? (
          <>
            <MonogramChip
              tile={props.tile}
              tint={tileTint === "tab" ? props.tint : props.autoTint}
              tinted={tileTint !== "none"}
            />
            <SideTabMeter
              agents={props.agents}
              attention={props.badge}
              size="tile"
            />
            <CornerBadge badge={props.badge} size="tile" />
          </>
        ) : (
          <ExpandedContent {...props} />
        )}
        <SideTabDropIndicator
          side={props.dropIndicator}
          variant={props.variant}
        />
        <SideTabPairPreview side={props.pairPreview} />
      </div>
    </SideTabRowHoverCard>
  );
}

/**
 * Tiles and rows have a hover card; it stays shut while a row is being
 * renamed, and on a row a drag is from or over.
 */
function hoverCardAllowed(props: SideTabRowProps): boolean {
  return (
    typeof props.title === "string" &&
    !props.dragSource &&
    props.dropIndicator === null &&
    props.pairPreview === null
  );
}

function SideTabDropIndicator(props: {
  readonly side: SideTabRowProps["dropIndicator"];
  readonly variant: SideTabRowVariant;
}) {
  if (props.side === null) return null;
  return (
    <m.span
      aria-hidden
      data-testid="tab-drop-indicator"
      data-side={props.side}
      initial={{ opacity: 0, scaleX: 0.45 }}
      animate={{ opacity: 1, scaleX: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      className={cn(
        "pointer-events-none absolute inset-x-2 z-20 origin-center",
        SIDE_TAB_DROP_LINE_SEAT_CLASS[props.variant][props.side],
      )}
    >
      <DropLine
        orientation="horizontal"
        glow={false}
        className="w-full"
        testId={undefined}
      />
    </m.span>
  );
}

function SideTabPairPreview(props: {
  readonly side: SideTabRowProps["pairPreview"];
}) {
  if (props.side === null) return null;
  return (
    <span
      aria-hidden
      data-testid="side-tab-pair-preview"
      data-side={props.side}
      className={cn(
        "pointer-events-none absolute inset-x-1 z-30 rounded-sm bg-primary/20 ring-2 ring-primary",
        props.side === "left" ? "top-1 bottom-1/2" : "top-1/2 bottom-1",
      )}
    />
  );
}

function expandedFill(active: boolean, sessionActive: boolean): string {
  if (sessionActive) {
    return cn(SIDE_TAB_SESSION_ACTIVE_CLASS, SESSION_TAB_LABEL_CLASS);
  }
  if (active) return cn(SIDE_TAB_ACTIVE_CLASS, "text-foreground");
  return cn(
    SIDE_TAB_HOVER_CLASS,
    "text-muted-foreground hover:text-foreground",
  );
}

/**
 * The collapsed tile fills like an expanded row: the active fill, else a hover
 * fill. The colour lives on the monogram chip inside it.
 */
function collapsedFill(props: SideTabRowProps): string {
  if (props.session === "active") {
    return cn(SIDE_TAB_SESSION_ACTIVE_CLASS, SESSION_TAB_LABEL_CLASS);
  }
  if (props.active) return SIDE_TAB_TILE_ACTIVE_CLASS;
  return cn(
    SIDE_TAB_TILE_HOVER_CLASS,
    "text-muted-foreground hover:text-foreground",
  );
}

/**
 * The layout session marker (L-163). At rest it paints the cap down the
 * inline-start edge; filled, it paints nothing and stays in the tree so the
 * dim exemption's `:has([data-layout-session-tab])` keeps the row lit.
 */
function SideSessionMark(props: {
  readonly session: "active" | "rest";
  readonly tint: string | null;
}) {
  return (
    <span
      aria-hidden
      data-layout-session-tab={props.session === "active" ? "filled" : "rest"}
      data-orientation="vertical"
      className="pointer-events-none absolute inset-y-1 start-0 rounded-full"
      style={
        props.tint === null
          ? undefined
          : ({ "--layout-session-tab-color": props.tint } as CSSProperties)
      }
    />
  );
}

function CornerBadge(props: {
  readonly badge: RailBadgeKind | null;
  readonly size: "tile" | "leading";
}) {
  if (props.badge === null) return null;
  return (
    <span
      className={cn(
        props.size === "tile"
          ? SIDE_TAB_RAIL_BADGE_POSITION_CLASS
          : SIDE_TAB_LEADING_BADGE_POSITION_CLASS,
        "pointer-events-none",
      )}
    >
      <SideTabRailBadge
        kind={props.badge}
        size={props.size}
        testId="side-tab-rail-badge"
      />
    </span>
  );
}

/**
 * The fixed 16px leading slot: a custom icon, or a coloured tab's monogram, on
 * a 16px tile with the status as a badge in the space reserved beside it;
 * otherwise the status glyph alone.
 */
function LeadingSlot(props: SideTabRowProps) {
  const tile = props.tile;
  const showTile =
    tile.kind === "icon" || (tile.kind === "monogram" && props.tint !== null);
  if (!showTile) {
    return (
      <span
        data-testid="side-tab-leading"
        data-leading="glyph"
        className={cn(
          SIDE_TAB_LEADING_CLASS,
          "flex shrink-0 items-center justify-center",
        )}
      >
        {props.leading}
      </span>
    );
  }
  const tinted = tileTinted(props.tint, tile);
  return (
    <span
      data-testid="side-tab-leading"
      data-leading="tile"
      className={cn(
        SIDE_TAB_LEADING_TILE_SLOT_CLASS[
          tile.kind === "icon" ? "icon" : "monogram"
        ],
        "relative flex shrink-0",
      )}
    >
      <span
        data-testid="side-tab-leading-tile"
        data-tinted={tinted}
        className={cn(
          SIDE_TAB_LEADING_TILE_CLASS,
          "flex items-center justify-center overflow-hidden",
          tinted ? SIDE_TAB_TINT_FILL_CLASS : SIDE_TAB_COLORLESS_TILE_CLASS,
        )}
        style={
          tinted
            ? ({ "--side-tab-tint": props.tint } as CSSProperties)
            : undefined
        }
      >
        {tile.kind === "icon" ? (
          tile.icon
        ) : (
          <span aria-hidden>{tile.text}</span>
        )}
      </span>
      <CornerBadge badge={props.badge} size="leading" />
    </span>
  );
}

function ExpandedContent(props: SideTabRowProps) {
  return (
    <>
      <LeadingSlot {...props} />
      <span
        data-testid="side-tab-title"
        className={cn(SIDE_TAB_TITLE_CLASS, "flex min-w-0 flex-1 items-center")}
      >
        {typeof props.title === "string" ? (
          <span className="block min-w-0 flex-1">
            <span className="header-tab-title-text">{props.title}</span>
          </span>
        ) : (
          props.title
        )}
      </span>
      <span
        data-testid="side-tab-trailing"
        className={cn(
          SIDE_TAB_TRAILING_CLASS,
          "grid shrink-0 items-center justify-items-end",
        )}
      >
        <TrailingContent
          active={props.active}
          onFill={props.session === "active"}
          leaderBadge={props.leaderBadge}
          close={props.close}
          waitingLabel={props.waitingLabel}
          badge={props.badge}
          agents={props.agents}
        />
      </span>
    </>
  );
}

/**
 * First match wins: the leader badge; the close button, always on the active
 * row and on hover or keyboard focus elsewhere; then the status, as the first
 * of the waiting chip, the failed chip and the meter (more than one live
 * agent). The status and a hidden close share one grid cell so revealing the
 * close swaps them in place.
 */
function TrailingContent(props: {
  readonly active: boolean;
  /** The row is the solid session fill, so its close takes the label colour. */
  readonly onFill: boolean;
  readonly leaderBadge: ReactNode | null;
  readonly close: SideTabRowClose | null;
  readonly waitingLabel: "Approve" | "Reply" | null;
  readonly badge: RailBadgeKind | null;
  readonly agents: SideTabLiveAgents;
}) {
  if (props.leaderBadge !== null) return props.leaderBadge;
  const close = props.close;
  const status = close !== null && props.active ? null : trailingStatus(props);
  return (
    <>
      {status === null ? null : (
        <span
          className={cn(
            "col-start-1 row-start-1 flex",
            close !== null && YIELD_TO_CLOSE_CLASS,
          )}
        >
          {status}
        </span>
      )}
      {close === null ? null : (
        <span
          data-revealed={props.active ? "always" : "on-hover-or-focus"}
          className={cn(
            "col-start-1 row-start-1 flex",
            !props.active && REVEAL_CLASS,
          )}
        >
          <Button
            type="button"
            size="icon-sm"
            variant={props.onFill ? "on-fill" : "muted"}
            aria-label={close.label}
            data-testid={close.testId}
            disabled={close.disabled}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              close.onClose();
            }}
            className="size-5"
          >
            <X className="size-3" />
          </Button>
        </span>
      )}
    </>
  );
}

/** The trailing status of an expanded row, or `null` when it has none to show. */
function trailingStatus(props: {
  readonly waitingLabel: "Approve" | "Reply" | null;
  readonly badge: RailBadgeKind | null;
  readonly agents: SideTabLiveAgents;
}): ReactNode {
  if (props.waitingLabel !== null) {
    return (
      <Badge variant="warning" data-testid="side-tab-waiting-chip">
        {props.waitingLabel}
      </Badge>
    );
  }
  if (props.badge === "failed") {
    return (
      <Badge variant="destructive" data-testid="side-tab-failed-chip">
        Failed
      </Badge>
    );
  }
  // One agent is the leading glyph's to show, unless it is a floor: then the
  // meter carries the "+" that says more may be running out of view.
  if (
    props.agents.turn + props.agents.background > 1 ||
    sideTabAgentsAreFloor(props.agents)
  ) {
    return (
      <SideTabMeter agents={props.agents} attention={props.badge} size="row" />
    );
  }
  return null;
}

/**
 * The row's or tile's hover card, on the side facing the content: left of a
 * right-edge strip, right of a left-edge strip. Always mounted, so switching
 * variants keeps the row element; shut whenever it is not allowed (a rename,
 * or the row is part of a drag). Its body mounts only while it is open. The
 * row list is its `HoverCardGroup`.
 */
function SideTabRowHoverCard(props: {
  readonly allowed: boolean;
  readonly body: ReactNode;
  readonly children: ReactElement;
}) {
  const placement = useColumnOverlayPlacement("row");
  return (
    <HoverCard
      trigger={props.children}
      content={props.body}
      appearance="preview"
      semantics={{ role: "tooltip" }}
      side={placement?.side ?? "right"}
      align={placement?.align ?? "center"}
      sideOffset={4}
      enabled={props.allowed}
      open={null}
      onOpenChange={null}
      testId="side-tab-hover-card"
      className="w-[min(90vw,18rem)] p-3 text-ui-xs"
    />
  );
}
