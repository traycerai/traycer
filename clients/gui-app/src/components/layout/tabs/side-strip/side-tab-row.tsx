import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { useState } from "react";
import type {
  AnimationEvent,
  ComponentPropsWithRef,
  CSSProperties,
  ReactElement,
  ReactNode,
} from "react";
import { ChevronRight, X } from "lucide-react";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
import { DropLine } from "@/components/ui/drop-line";
import { HoverCard } from "@/components/ui/hover-card";
import { useIsTextTruncated } from "@/hooks/ui/use-is-text-truncated";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { cn } from "@/lib/utils";
import { SESSION_TAB_LABEL_CLASS } from "../header-tab-visual";
import { MonogramChip } from "../monogram-chip";
import type { SideTabTile } from "../tab-identity";
import { SideTabMeter, type SideTabLiveAgents } from "./agent-meter";
import { SideTabRailBadge } from "./side-tab-rail-badge";
import type { RailBadgeKind } from "./rail-badge-kind";
import {
  SIDE_TAB_ACCENT_BAR_CLASS,
  SIDE_SPLIT_HALF_CLASS,
  SIDE_SPLIT_HALF_FOCUSED_CLASS,
  SIDE_SPLIT_HALF_REST_CLASS,
  SIDE_SPLIT_PREVIEW_TILE_CLASS,
  SIDE_TAB_ACTIVE_CLASS,
  SIDE_TAB_DROP_LINE_SEAT_CLASS,
  SIDE_TAB_HOVER_CLASS,
  SIDE_TAB_RAIL_BADGE_POSITION_CLASS,
  SIDE_TAB_ROW_CLASS,
  SIDE_TAB_TWO_LINE_ROW_CLASS,
  SIDE_TAB_TWO_LINE_TRAILING_CLASS,
  SIDE_TAB_SESSION_ACTIVE_CLASS,
  SIDE_TAB_TILE_ACCENT_RING_CLASS,
  SIDE_TAB_TILE_ACTIVE_CLASS,
  SIDE_TAB_TILE_CLASS,
  SIDE_TAB_TILE_HOVER_CLASS,
  SIDE_TAB_TITLE_CLASS,
  SIDE_TAB_TRAILING_CLASS,
} from "./side-strip-tokens";
export type SideTabRowVariant = "expanded" | "collapsed";

/**
 * What an expanded tab draws as: a row of its own, or one half of a split
 * pair's row. A half of the current pair that is not the focused one is on
 * screen too, so it reads in bright text.
 */
export type SideTabRowShape = "row" | "half" | "on-screen-half";

/**
 * A task's disclosure: the chevron button that joins the trailing edge, before
 * the close, while the row is hovered or focused, and the state it toggles.
 */
export interface SideTabDisclosure {
  readonly expanded: boolean;
  /** Whether the chevron eases; a keyboard toggle does not. */
  readonly animate: boolean;
  /** The nested group's DOM id, for `aria-controls`. */
  readonly controlsId: string;
  /** "Hide agents in <title>" or "Show agents in <title>". */
  readonly label: string;
  /** Whether the toggle came from a pointer, so a keyboard one skips the motion. */
  readonly onToggle: (viaPointer: boolean) => void;
}

/**
 * What the Activity view's sections change about an expanded row: the title's
 * weight and tone, and, on a Needs you or To review row, the second line that
 * makes it a 52px two-line row. The Layered view passes `null`.
 */
export interface SideRowSection {
  /** `strong` is a loud row's bold title, `muted` an idle one's. */
  readonly title: "strong" | "normal" | "muted";
  /** The second line, or `null` on a one-line row. */
  readonly detail: ReactNode | null;
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
 * The one status a row's trailing edge shows. A glyph yields its place to the
 * close while the row is hovered or focused; a chip or the meter stays, and the
 * close joins after it.
 */
export interface SideTabRowStatus {
  readonly node: ReactNode;
  readonly yieldsToClose: boolean;
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
  /** Expanded: a row, or a half of a split pair's row; the rail draws a tile either way. */
  readonly shape: SideTabRowShape;
  readonly active: boolean;
  /** Set only on the sample-workspace tab: its session state (L-163). */
  readonly session: "active" | "rest" | null;
  /** The tab colour as it draws (`effectiveTabColor`), `#rrggbb`. */
  readonly tint: string | null;
  /**
   * The row sits inside its group's block or column, which carries the group's
   * colour, so it draws no colour bar or ring of its own.
   */
  readonly inBlock: boolean;
  /**
   * Expanded: what draws before the title, inline, with its own space after it
   * (a custom icon's characters, or a component icon); the title starts on the
   * row's padding otherwise.
   */
  readonly titleIcon: ReactNode | null;
  /** The tab's tile: the collapsed row's content. */
  readonly tile: SideTabTile;
  /**
   * The one state that needs the user (D5): the collapsed tile's badge, the
   * meter's attention pip, and what starts the entry pulse.
   */
  readonly badge: RailBadgeKind | null;
  /** The task's live agents, drawn by the collapsed tile's meter. */
  readonly agents: SideTabLiveAgents;
  /** Expanded: the one trailing status, or `null` for a row with none. */
  readonly status: SideTabRowStatus | null;
  /**
   * The Activity view's section treatment, or `null` in the Layered view:
   * expanded, the row's weight and second line; collapsed, an idle tile's dim.
   */
  readonly section: SideRowSection | null;
  /** The chevron of a task with nested agents; `null` on every other row. */
  readonly disclosure: SideTabDisclosure | null;
  /**
   * The title. A string is painted as one faded line, the hover card carrying
   * it in full; any other node (the rename input) is rendered as given.
   */
  readonly title: ReactNode;
  /** What the hover card shows: the title, the state, the counts and, warm, the agents. */
  readonly hoverCardBody: ReactNode;
  /** Open the card only while the painted title is cut short. */
  readonly hoverCardOnOverflow: boolean;
  readonly leaderBadge: ReactNode | null;
  readonly close: SideTabRowClose | null;
  readonly dropIndicator: "before" | "after" | null;
  /**
   * While a drop over this tab would split with it: what the row draws in place
   * of its own content, the pair it will become (`SplitPairPreview`). The rail's
   * tile is outlined instead.
   */
  readonly pairPreview: ReactNode | null;
  readonly dragSource: boolean;
}

/**
 * Shows a hidden trailing control while the row is hovered or holds keyboard
 * focus. The fade is 100ms, and instant on keyboard focus and with reduced
 * motion.
 */
const REVEAL_CLASS =
  "pointer-events-none opacity-0 transition-opacity duration-100 motion-reduce:transition-none group-hover/side-tab:pointer-events-auto group-hover/side-tab:opacity-100 group-focus-visible/side-tab:pointer-events-auto group-focus-visible/side-tab:opacity-100 group-focus-visible/side-tab:duration-0 group-has-[:focus-visible]/side-tab:pointer-events-auto group-has-[:focus-visible]/side-tab:opacity-100 group-has-[:focus-visible]/side-tab:duration-0";

/**
 * Hides what yields its place while the row is hovered or focused: the status
 * glyph, to the close. It crossfades with the close under the same timing as
 * `REVEAL_CLASS`.
 */
const YIELD_TO_CLOSE_CLASS =
  "transition-opacity duration-100 motion-reduce:transition-none group-hover/side-tab:opacity-0 group-focus-visible/side-tab:opacity-0 group-focus-visible/side-tab:duration-0 group-has-[:focus-visible]/side-tab:opacity-0 group-has-[:focus-visible]/side-tab:duration-0";

/**
 * The room of a trailing control that joins the row's content: none at rest,
 * 20px while the row is hovered or focused. It stays in the tab order at rest.
 */
const JOIN_ON_REVEAL_CLASS =
  "w-0 min-w-0 group-hover/side-tab:w-5 group-focus-visible/side-tab:w-5 group-has-[:focus-visible]/side-tab:w-5";

/**
 * The row's per-tab accent colour: the tab's own colour, ignored while the
 * title is still generating (the tile stays neutral then, S-17) and never a
 * stand-in for the auto-tint hash (D11) - that no longer reaches this row at
 * all. `null` means no colour: `SideTabAccent` renders it transparent.
 */
function tabAccentOf(tint: string | null, tile: SideTabTile): string | null {
  return tile.kind === "generating" ? null : tint;
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
 * `frame` and the state props. Expanded, the inline order is title, trailing
 * on either strip edge, with nothing before the title; collapsed, the row is
 * the 40x44 tile itself.
 */
export function SideTabRow(props: SideTabRowProps) {
  const { frame } = props;
  const collapsed = props.variant === "collapsed";
  const sessionActive = props.session === "active";
  const accent = tabAccentOf(props.tint, props.tile);
  const pulse = useWaitingPulse(props.badge);
  const { ref: titleRef, isTruncated } = useIsTextTruncated<HTMLSpanElement>(
    typeof props.title === "string" ? props.title : "",
  );
  // A half's card opens past its whole row, never over the other half.
  const [reach, setReach] = useState(NO_REACH);
  const measureReach = (node: HTMLElement): void => {
    if (props.shape !== "row") setReach(pairRowReach(node));
  };
  return (
    <SideTabRowHoverCard
      allowed={
        hoverCardAllowed(props) && (!props.hoverCardOnOverflow || isTruncated)
      }
      body={props.hoverCardBody}
      reach={reach}
    >
      <div
        {...frame}
        onPointerEnter={(event) => {
          frame.onPointerEnter?.(event);
          measureReach(event.currentTarget);
        }}
        onFocus={(event) => {
          frame.onFocus?.(event);
          measureReach(event.currentTarget);
        }}
        data-side-tab={props.variant}
        data-active={props.active}
        data-tile-kind={collapsed ? props.tile.kind : undefined}
        data-waiting-pulse={pulse.pulsing ? true : undefined}
        onAnimationEnd={(event) => {
          frame.onAnimationEnd?.(event);
          pulse.onAnimationEnd(event);
        }}
        className={cn(
          "group/side-tab relative flex items-center outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50",
          collapsed
            ? cn(SIDE_TAB_TILE_CLASS, "shrink-0 justify-center self-center")
            : expandedBox(props.shape, props.section),
          collapsed ? collapsedFill(props) : expandedFill(props, sessionActive),
          props.dragSource && "opacity-0",
          frame.className,
        )}
      >
        {props.session === null ? null : (
          <SideSessionMark session={props.session} tint={props.tint} />
        )}
        {props.session === null && !props.inBlock ? (
          <SideTabAccent variant={props.variant} color={accent} />
        ) : null}
        {collapsed ? (
          <>
            <MonogramChip tile={props.tile} tint={null} tinted={false} />
            <SideTabMeter
              agents={props.agents}
              attention={props.badge}
              size="tile"
            />
            <CornerBadge badge={props.badge} />
          </>
        ) : (
          (props.pairPreview ?? (
            <ExpandedContent {...props} titleRef={titleRef} />
          ))
        )}
        <SideTabDropIndicator
          side={props.dropIndicator}
          variant={props.variant}
        />
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

/** An expanded tab's box: a 32px row (52px with a second line), or a split half. */
function expandedBox(
  shape: SideTabRowShape,
  section: SideRowSection | null,
): string {
  if (shape !== "row") return SIDE_SPLIT_HALF_CLASS;
  return cn(
    SIDE_TAB_ROW_CLASS,
    section?.detail !== null &&
      section?.detail !== undefined &&
      SIDE_TAB_TWO_LINE_ROW_CLASS,
  );
}

/**
 * An expanded tab's fill and tone. A row: the active fill, else a hover fill.
 * A half: the focused half of the current pair is raised as a selected tab;
 * every other half keeps its faint fill, which is what parts the two titles,
 * and the current pair's other half reads bright since it is on screen. A loud
 * or working row reads at full strength; only idle, and every row of the
 * Layered view, is muted until it is hovered.
 */
function expandedFill(props: SideTabRowProps, sessionActive: boolean): string {
  if (sessionActive) {
    return cn(SIDE_TAB_SESSION_ACTIVE_CLASS, SESSION_TAB_LABEL_CLASS);
  }
  const half = props.shape !== "row";
  if (props.active) {
    return cn(
      half ? SIDE_SPLIT_HALF_FOCUSED_CLASS : SIDE_TAB_ACTIVE_CLASS,
      "text-foreground",
    );
  }
  const quiet =
    props.shape !== "on-screen-half" &&
    (props.section === null || props.section.title === "muted");
  return cn(
    half ? SIDE_SPLIT_HALF_REST_CLASS : SIDE_TAB_HOVER_CLASS,
    quiet ? "text-muted-foreground hover:text-foreground" : "text-foreground",
  );
}

/**
 * The collapsed tile fills like an expanded row: the active fill, else a hover
 * fill, and an idle task's tile in the Activity view dims to half until it is
 * hovered or focused, so its focus ring is never faint. The colour lives on the
 * monogram chip inside it. A tile a drop would split with is outlined in info
 * blue: the rail has no room to draw the pair it would become.
 */
function collapsedFill(props: SideTabRowProps): string {
  if (props.session === "active") {
    return cn(SIDE_TAB_SESSION_ACTIVE_CLASS, SESSION_TAB_LABEL_CLASS);
  }
  if (props.active) {
    return cn(
      SIDE_TAB_TILE_ACTIVE_CLASS,
      props.pairPreview !== null && SIDE_SPLIT_PREVIEW_TILE_CLASS,
    );
  }
  return cn(
    SIDE_TAB_TILE_HOVER_CLASS,
    props.pairPreview !== null && SIDE_SPLIT_PREVIEW_TILE_CLASS,
    "text-muted-foreground hover:text-foreground",
    props.section?.title === "muted" &&
      "opacity-50 hover:opacity-100 focus-visible:opacity-100",
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

/**
 * The per-tab colour accent (owner ruling, fix/layout-regression-and-improvements):
 * always mounted so toggling a tab's colour never shifts the row. `color` is
 * `null` for a colourless tab, rendered transparent rather than a
 * hash-derived stand-in (D11's `tabAutoTint` no longer feeds this mark).
 * Skipped on the session tab, which already carries its own edge mark
 * (`SideSessionMark`, L-163).
 */
function SideTabAccent(props: {
  readonly variant: SideTabRowVariant;
  readonly color: string | null;
}) {
  return (
    <span
      aria-hidden
      data-testid="side-tab-accent"
      data-accent={props.color !== null}
      className={
        props.variant === "collapsed"
          ? SIDE_TAB_TILE_ACCENT_RING_CLASS
          : SIDE_TAB_ACCENT_BAR_CLASS
      }
      style={
        { "--side-tab-accent": props.color ?? "transparent" } as CSSProperties
      }
    />
  );
}

function CornerBadge(props: { readonly badge: RailBadgeKind | null }) {
  if (props.badge === null) return null;
  return (
    <span
      className={cn(SIDE_TAB_RAIL_BADGE_POSITION_CLASS, "pointer-events-none")}
    >
      <SideTabRailBadge
        kind={props.badge}
        size="tile"
        testId="side-tab-rail-badge"
      />
    </span>
  );
}

/**
 * The chevron button at the trailing edge, before the close. It is a button
 * inside the row's tab, as the close button is: a click toggles the group and
 * never activates the row, and the row's key handler leaves Enter and Space on
 * it to the button. It takes no room until the row is hovered or focused.
 */
function DisclosureChevron(props: { readonly disclosure: SideTabDisclosure }) {
  const { disclosure } = props;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-end",
        JOIN_ON_REVEAL_CLASS,
        REVEAL_CLASS,
      )}
    >
      <button
        type="button"
        data-testid="side-tab-disclosure"
        aria-label={disclosure.label}
        aria-expanded={disclosure.expanded}
        aria-controls={disclosure.controlsId}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // A keyboard click has no pointer position or click count.
          disclosure.onToggle(event.detail > 0);
        }}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight
          aria-hidden
          data-expanded={disclosure.expanded}
          className={cn(
            "size-3.5 data-[expanded=true]:rotate-90",
            disclosure.animate &&
              "transition-transform duration-120 ease-out motion-reduce:transition-none",
          )}
        />
      </button>
    </span>
  );
}

function ExpandedContent(
  props: SideTabRowProps & {
    readonly titleRef: (node: HTMLSpanElement | null) => void;
  },
) {
  const { titleRef } = props;
  // A rename input takes the whole row: no icon, status, chevron or close.
  const renaming = typeof props.title !== "string";
  const detail = renaming ? null : (props.section?.detail ?? null);
  const title = (
    <span
      data-testid="side-tab-title"
      className={cn(
        SIDE_TAB_TITLE_CLASS,
        "flex min-w-0 items-center",
        detail === null && "flex-1",
        props.section?.title === "strong" && "font-semibold",
      )}
    >
      {typeof props.title === "string" ? (
        <>
          {props.titleIcon === null ? null : (
            <span className="flex shrink-0 items-center">
              {props.titleIcon}
            </span>
          )}
          <span className="block min-w-0 flex-1">
            <span
              ref={titleRef}
              className={cn(
                // A half is too short for the row's fade: it ends in an ellipsis.
                props.shape === "row"
                  ? "header-tab-title-text"
                  : "block truncate",
                props.tile.kind === "generating" && "text-muted-foreground",
              )}
            >
              {props.title}
            </span>
          </span>
        </>
      ) : (
        props.title
      )}
    </span>
  );
  return (
    <>
      {detail === null ? (
        title
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {title}
          {detail}
        </span>
      )}
      {renaming ? null : (
        <span
          data-testid="side-tab-trailing"
          // A two-line row's trailing content sits on its title line.
          className={cn(
            "flex shrink-0 items-center justify-end",
            detail !== null && SIDE_TAB_TWO_LINE_TRAILING_CLASS,
          )}
        >
          <TrailingContent
            active={props.active}
            onFill={props.session === "active"}
            leaderBadge={props.leaderBadge}
            close={props.close}
            status={props.status}
            disclosure={props.disclosure}
          />
        </span>
      )}
    </>
  );
}

/**
 * The trailing edge, in order: the status, the disclosure chevron, the close.
 * The leader badge replaces all of it. The close shows always on the active row
 * and on hover or keyboard focus elsewhere, and where the status is a glyph
 * the two share one cell and crossfade, so the title does not move. A chip or
 * the meter stays, and the close, and the chevron, join after it; so does the
 * status of the active row.
 */
function TrailingContent(props: {
  readonly active: boolean;
  /** The row is the solid session fill, so its close takes the label colour. */
  readonly onFill: boolean;
  readonly leaderBadge: ReactNode | null;
  readonly close: SideTabRowClose | null;
  readonly status: SideTabRowStatus | null;
  readonly disclosure: SideTabDisclosure | null;
}) {
  if (props.leaderBadge !== null) return props.leaderBadge;
  const { active, close, status } = props;
  const shared =
    status !== null && status.yieldsToClose && close !== null && !active;
  return (
    <>
      {status === null || shared ? null : (
        <span className="flex shrink-0 items-center">{status.node}</span>
      )}
      {props.disclosure === null ? null : (
        <DisclosureChevron disclosure={props.disclosure} />
      )}
      {close === null ? null : (
        <span
          className={cn(
            "grid shrink-0 items-center justify-items-end",
            // The close of a stayed status takes no room until revealed; every
            // other close has its own 20px cell, empty or holding the glyph.
            status !== null && !shared && !active
              ? JOIN_ON_REVEAL_CLASS
              : SIDE_TAB_TRAILING_CLASS,
          )}
        >
          {shared ? (
            // Centred in the cell, on the axis of the close's ×, so the swap
            // happens in place.
            <span
              className={cn(
                "col-start-1 row-start-1 flex justify-self-center",
                YIELD_TO_CLOSE_CLASS,
              )}
            >
              {status.node}
            </span>
          ) : null}
          <span
            data-revealed={active ? "always" : "on-hover-or-focus"}
            className={cn(
              "col-start-1 row-start-1 flex",
              !active && REVEAL_CLASS,
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
        </span>
      )}
    </>
  );
}

/** How far a split half sits inside its pair's row, from each side. */
interface RowReach {
  readonly left: number;
  readonly right: number;
}

const NO_REACH: RowReach = { left: 0, right: 0 };

/** The distance from a split half to its pair row's edges; none for a row of its own. */
function pairRowReach(half: HTMLElement): RowReach {
  const row = half.closest("[data-side-split-pair]");
  if (row === null) return NO_REACH;
  const halfBox = half.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  return {
    left: halfBox.left - rowBox.left,
    right: rowBox.right - halfBox.right,
  };
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
  readonly reach: RowReach;
  readonly children: ReactElement;
}) {
  const placement = useColumnOverlayPlacement("row");
  const side = placement?.side ?? "right";
  return (
    <HoverCard
      trigger={props.children}
      content={props.body}
      appearance="preview"
      semantics={{ role: "tooltip" }}
      side={side}
      align={placement?.align ?? "center"}
      sideOffset={4 + (side === "left" ? props.reach.left : props.reach.right)}
      enabled={props.allowed}
      open={null}
      onOpenChange={null}
      testId="side-tab-hover-card"
      className="w-[min(90vw,18rem)] p-3 text-ui-xs"
    />
  );
}
