import type { KeyboardEvent, ReactNode } from "react";
import { Bot } from "lucide-react";
import type { TracyStripEntry } from "../tab-strip-controller";
import { TracyEntryHoverBody } from "../tracy-strip-entry";
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
 * the same signals as the top strip's slot, the title bold while unread, the
 * rail tile's unread badge, and the working time as the row's trailing
 * status. Like Home, no drag, no close and no Alt-digit.
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
    "aria-label": tab.name,
    "data-testid": "tab-tracy",
    "data-tab-kind": "tracy",
    "data-unread": signals.unread,
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
      titleIcon={<Bot className="size-4 me-4" />}
      tile={{ kind: "icon", icon: <Bot className="size-4" /> }}
      badge={signals.unread ? "unread" : null}
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
      title={tab.name}
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
