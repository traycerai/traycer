import type { CSSProperties, ReactNode } from "react";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import {
  useEpicActiveAgentIds,
  useEpicAgentActivityTiers,
} from "@/lib/epic-selectors";

/** The awareness TIER splits that running arm in two, exactly as the chat icon and the sidebar's descendant rollup do: an agent kept non-idle by a scheduled wakeup wears the calm background glyph rather than the busy spinner. Reading the working ID SET alone cannot make that distinction and forces the turn spinner on both. */
export function TerminalAgentProgressIcon(props: {
  readonly epicId: string;
  readonly nodeId: string;
  /** The host whose notification rows may decorate this node, or `null` for the surface's aggregate. `chatId` is host-minted, so naming an origin is what stops a same-id agent on another machine from lighting this glyph. */
  readonly originHostId: string | null;
  readonly className: string | undefined;
  readonly style: CSSProperties | undefined;
  readonly testIdPrefix: string;
  /** Identity glyph for the idle slot (harness brand, static bot, …). */
  readonly idleIcon: ReactNode;
}) {
  const isActive = useEpicActiveAgentIds().has(props.nodeId);
  const tier = useEpicAgentActivityTiers().get(props.nodeId);
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId: props.epicId, chatId: props.nodeId },
    props.originHostId,
  );
  return (
    <NotificationIndicatorIcon
      state={indicatorState}
      running={isActive ? (tier ?? "turn") : false}
      subjectId={props.nodeId}
      testIdPrefix={props.testIdPrefix}
      className={props.className}
      style={props.style}
      runningTitle="Agent in progress"
      defaultIcon={props.idleIcon}
      statusPresentation="message"
      agentSurface="tui"
    />
  );
}
