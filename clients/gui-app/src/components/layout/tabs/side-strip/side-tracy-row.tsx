import type { KeyboardEvent, ReactNode } from "react";
import { labelWithUnreadCount } from "@/lib/notifications/unread-count";
import type { TracyStripEntry } from "../tab-strip-controller";
import {
  TRACY_ENTRY_LABEL,
  TracyEntryHoverBody,
  TracyEntryIcon,
} from "../tracy-strip-entry";
import { useTracyEntrySignals } from "../use-tracy-entry-signals";
import {
  SideTabRow,
  type SideRowFrame,
  type SideTabRowVariant,
} from "./side-tab-row";
import { NO_LIVE_AGENTS } from "./side-tab-live-agents";
import { StripElapsedTime } from "./strip-elapsed-time";

/**
 * The fixed Tracy entry in the vertical strip, after Home in the nav block:
 * the same glyph, label and signals as the top strip's slot, the glyph
 * wearing the bot's unread count and the label bold while unread (the rail
 * tile's unread badge where the host does not count), and the working time
 * as the row's trailing status. Like Home, no drag, no close and no
 * Alt-digit.
 */
export function SideTracyRow(props: {
  readonly variant: SideTabRowVariant;
  readonly entry: TracyStripEntry;
}): ReactNode {
  const { variant } = props;
  const { tab, isActive, onActivate } = props.entry;
  const signals = useTracyEntrySignals(tab.id);
  const frame: SideRowFrame = {
    role: "tab",
    tabIndex: 0,
    "aria-selected": isActive,
    "aria-label": labelWithUnreadCount(TRACY_ENTRY_LABEL, signals.unreadCount),
    "data-testid": "tab-tracy",
    "data-tab-kind": "tracy",
    // Present only while unread, as the header strip's entry marks it.
    ...(signals.unread ? { "data-unread": "" } : {}),
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onActivate();
    },
    className: "cursor-pointer [-webkit-app-region:no-drag]",
  };
  return (
    <SideTabRow
      frame={frame}
      variant={variant}
      shape="row"
      active={isActive}
      session={null}
      tint={null}
      inBlock={false}
      // Its label stands where Home's does, after a 16px icon and space.
      titleIcon={
        <TracyEntryIcon className="me-4" unreadCount={signals.unreadCount} />
      }
      tile={{
        kind: "icon",
        icon: (
          <TracyEntryIcon
            className={undefined}
            unreadCount={signals.unreadCount}
          />
        ),
      }}
      // The count stands for the badge wherever the host counts.
      badge={signals.unread && signals.unreadCount === null ? "unread" : null}
      agents={NO_LIVE_AGENTS}
      status={
        signals.workingSince === null
          ? null
          : {
              node: (
                <StripElapsedTime
                  since={signals.workingSince}
                  testId="tab-tracy-working"
                  className="text-ui-xs text-muted-foreground tabular-nums"
                />
              ),
              yieldsToClose: false,
            }
      }
      section={{ title: signals.unread ? "strong" : "normal", detail: null }}
      disclosure={null}
      title={TRACY_ENTRY_LABEL}
      hoverCardBody={<TracyEntryHoverBody title={tab.name} signals={signals} />}
      hoverCardOnOverflow={false}
      leaderBadge={null}
      close={null}
      dropIndicator={null}
      pairPreview={null}
      dragSource={false}
    />
  );
}
