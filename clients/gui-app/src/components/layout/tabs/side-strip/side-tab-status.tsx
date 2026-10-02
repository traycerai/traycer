import type { ReactNode } from "react";
import { hasUnreadNonTerminalFailure } from "@/components/notifications/notification-indicator-tones";
import { Badge } from "@/components/ui/badge";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { sideTabWaitingLabel, tabWaitingReason } from "../tab-waiting";
import { SideTabMeter, type SideTabLiveAgents } from "./agent-meter";
import { railBadgeOf } from "./rail-badge-kind";
import type { SideTabRowStatus } from "./side-tab-row";
import { sideTabAgentsAreFloor } from "./side-tab-live-agents";

/**
 * The one status a task row's trailing edge shows, the first of these that
 * holds: waiting for a reply or an approval (chip), an unread failure (chip),
 * a pending fork (its glyph), several live agents or a floor (the meter), and
 * then the shared glyph for everything below (running, background, done,
 * terminal failure, generating), which draws nothing for an idle task. The
 * glyph is the one that yields its place to the close; a chip and the meter
 * stay, except on the Activity view's one-line rows (`meterYields`), where the
 * meter yields too.
 */
export function sideTabStatusOf(input: {
  readonly indicator: NotificationIndicatorState;
  readonly agents: SideTabLiveAgents;
  /** The meter gives its place to the close, as a glyph does. */
  readonly meterYields: boolean;
  readonly glyph: ReactNode;
}): SideTabRowStatus {
  const { indicator, agents } = input;
  const waiting = sideTabWaitingLabel(tabWaitingReason(indicator, null));
  if (waiting !== null) {
    return {
      yieldsToClose: false,
      node: (
        <Badge variant="warning" data-testid="side-tab-waiting-chip">
          {waiting}
        </Badge>
      ),
    };
  }
  if (hasUnreadNonTerminalFailure(indicator)) {
    return {
      yieldsToClose: false,
      node: (
        <Badge variant="destructive" data-testid="side-tab-failed-chip">
          Failed
        </Badge>
      ),
    };
  }
  const several =
    agents.turn + agents.background > 1 || sideTabAgentsAreFloor(agents);
  if (several && !indicator.pendingFork) {
    return {
      yieldsToClose: input.meterYields,
      node: (
        <SideTabMeter
          agents={agents}
          attention={railBadgeOf(indicator)}
          size="row"
        />
      ),
    };
  }
  return { yieldsToClose: true, node: input.glyph };
}
