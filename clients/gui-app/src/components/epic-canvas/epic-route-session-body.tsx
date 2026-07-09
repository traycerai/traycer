import { EpicMigrationModal } from "@/components/epic-canvas/dialogs/epic-migration-modal";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { useInitialChatHandoff } from "@/components/epic-canvas/hooks/use-initial-chat-handoff";
import { useEpicRouteSynchronization } from "@/components/epic-canvas/hooks/use-epic-route-synchronization";
import { NewConversationModalHost } from "@/components/epic-canvas/sidebar/new-conversation-modal";
import { EpicSessionGate } from "@/providers/epic-session-gate";

export interface EpicRouteSessionBodyProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly active: boolean;
  readonly focusedAt: number | undefined;
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly focusPaneId: string | undefined;
  readonly focusTileInstanceId: string | undefined;
}

export function EpicRouteSessionBody(props: EpicRouteSessionBodyProps) {
  // Closing an unavailable/revoked/deleted epic tab (and redirecting an active
  // tab to landing) is owned by the app-level `EpicAccessCoordinator`, which
  // observes every live session - not just the active route.
  return (
    <>
      <EpicShell
        epicId={props.epicId}
        tabId={props.tabId}
        active={props.active}
      />
      <EpicSessionGate fallback={null}>
        <EpicRouteSessionEffects {...props} />
      </EpicSessionGate>
    </>
  );
}

function EpicRouteSessionEffects(props: EpicRouteSessionBodyProps) {
  useInitialChatHandoff(props.epicId, props.tabId);
  return props.active ? <EpicRouteActiveEffects {...props} /> : null;
}

function EpicRouteActiveEffects(props: EpicRouteSessionBodyProps) {
  useEpicRouteSynchronization({
    epicId: props.epicId,
    tabId: props.tabId,
    focusedAt: props.focusedAt,
    focusArtifactId: props.focusArtifactId,
    focusThreadId: props.focusThreadId,
    focusPaneId: props.focusPaneId,
    focusTileInstanceId: props.focusTileInstanceId,
  });
  return (
    <>
      <EpicMigrationModal tabId={props.tabId} />
      <NewConversationModalHost epicId={props.epicId} tabId={props.tabId} />
    </>
  );
}
