import { EpicMigrationModal } from "@/components/epic-canvas/dialogs/epic-migration-modal";
import { EpicPlainTerminalCreateOwner } from "@/components/epic-canvas/epic-plain-terminal-create-owner";
import { EpicPlainTerminalTombstoneReconciler } from "@/components/epic-canvas/epic-plain-terminal-tombstone-reconciler";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { useInitialChatHandoff } from "@/components/epic-canvas/hooks/use-initial-chat-handoff";
import { useEpicSyncChatRecords } from "@/hooks/chats/use-epic-chat-records";
import { useEpicSyncTuiAgentRecords } from "@/hooks/chats/use-epic-tui-agent-records";
import { useEpicRouteSynchronization } from "@/components/epic-canvas/hooks/use-epic-route-synchronization";
import { NewConversationModalHost } from "@/components/epic-canvas/sidebar/new-conversation-modal";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { useEpicParked } from "@/lib/epics/epic-parking";

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
      <EpicPlainTerminalTombstoneReconciler epicId={props.epicId} />
      <EpicPlainTerminalCreateOwner epicId={props.epicId} />
      <EpicSessionGate fallback={null}>
        <EpicRouteSessionEffects {...props} />
      </EpicSessionGate>
    </>
  );
}

function EpicRouteSessionEffects(props: EpicRouteSessionBodyProps) {
  useInitialChatHandoff(props.epicId, props.tabId);
  // The PARKED gate, beside the deliberate placement outside `props.active`
  // below (plan C, decision C1). The two are different questions and both
  // answers are load-bearing:
  //
  //  - hidden-but-not-parked still polls, for the reason stated on
  //    `EpicRecordSyncEffects`;
  //  - parked must NOT. Each of these reads opens the epic on the host with a
  //    request-scoped VISIBLE lease, so a parked epic that kept polling would
  //    rebuild the slot the park just released - cloud connect, artifact rooms
  //    and all - every 20 seconds, and the park would free nothing.
  //
  // A gate rather than a `poll: false`, because the queries must also stop
  // being observers: an enabled query refetches on window focus, and the fence
  // it would capture belongs to a store generation that no longer exists.
  // Unmounting takes the fence question with it - on show these remount and
  // read a fresh one, which is what `use-epic-chat-records.ts` documents as
  // the only safe answer after an eviction.
  const parked = useEpicParked(props.epicId);
  return (
    <>
      {parked ? null : <EpicRecordSyncEffects epicId={props.epicId} />}
      {props.active ? <EpicRouteActiveEffects {...props} /> : null}
    </>
  );
}

function EpicRecordSyncEffects(props: { readonly epicId: string }) {
  // Deliberately OUTSIDE the `props.active` gate: the record table backs the
  // sidebar tree and every open tile of this session, which keep rendering
  // while another tab is in front. A background epic that stopped hearing about
  // its own chats would lose the rows again the moment it was swept.
  useEpicSyncChatRecords(props.epicId);
  // Same placement, same reason, for the terminal-agent record table.
  useEpicSyncTuiAgentRecords(props.epicId);
  return null;
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
