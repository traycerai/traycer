import type {
  DeleteTuiAgentRequest,
  RenameTuiAgentRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  useEpicRecordMutationClient,
  type EpicRecordMutationContext,
  type EpicRecordMutationTarget,
} from "@/hooks/epic/use-epic-record-mutation-client";
import { pruneRecoveryTiles } from "@/lib/tab-recovery/history";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { invalidateEpicTuiAgentRecords } from "@/hooks/chats/use-epic-tui-agent-records";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * What a TUI mutation has to remember to refresh the record list afterwards:
 * the host it was actually sent to, captured at mutate time so a host swap in
 * flight cannot redirect the invalidation at another machine's cache. The
 * terminal twin of the chat mutations' `ChatRecordMutationContext`.
 */
interface TuiAgentRecordMutationContext {
  readonly hostId: string | null;
}

/**
 * Mutation hook for `epic.createTerminalAgent`, host-parametric: persists the
 * terminal-agent record through an explicit `HostClient` - the composer
 * placement's frozen submit client, or a sidebar row's OWN host resolved via
 * `useHostClientFor`. `null` client rejects through the shared
 * `useHostMutation` preflight.
 *
 * The caller is responsible for first minting an SDK session via
 * `agent.startTerminalSession` and then handing the resulting
 * `harnessId` + `sessionId` + `hostId` + `workspaceFolders` to this
 * mutation so the host can persist a terminal-agent record into the
 * epic's `tuiAgents` Y.Map.
 *
 * There is deliberately no client-less `useEpicCreateTuiAgent()` wrapper any
 * more: the one that existed resolved the app-wide host and had zero callers,
 * and a create is PLACEMENT - it must be sent on the client the placement
 * resolved, never on a host read separately from the chip.
 */
export function useEpicCreateTuiAgentForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.createTuiAgent",
    TuiAgentRecordMutationContext
  >({
    client,
    method: "epic.createTuiAgent",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, variables, ctx) => {
        // On a migrated host the created record lands in the registry and in
        // nothing this renderer listens to per-epic (the doc write is what the
        // TUI eviction removed), so this - with the push delta - is what keeps
        // `waitForTuiAgentProjected` from riding out the 20s poll interval.
        invalidateEpicTuiAgentRecords(queryClient, ctx.hostId);
        Analytics.getInstance().track(AnalyticsEvent.TerminalAgentLaunched, {
          source: "direct_ui",
          harness: variables.harnessId,
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't create terminal agent.");
      },
    },
  });
}

export type DeleteTuiAgentMutationInput = DeleteTuiAgentRequest &
  EpicRecordMutationTarget;
export type RenameTuiAgentMutationInput = RenameTuiAgentRequest &
  EpicRecordMutationTarget;

/** Delete on the owning host, which also tears down its runtime and worktree binding. */
export function useEpicDeleteTuiAgent() {
  const client = useEpicRecordMutationClient();
  const sessionClient = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.deleteTuiAgent",
    EpicRecordMutationContext,
    DeleteTuiAgentMutationInput
  >({
    client,
    method: "epic.deleteTuiAgent",
    mapVariables: ({ epicId, tuiAgentId }) => ({ epicId, tuiAgentId }),
    options: {
      onMutate: ({ hostId }) => ({
        hostId,
        viewerHostId: sessionClient?.getActiveHostId() ?? null,
      }),
      onSuccess: (_data, variables, ctx) => {
        // Hook callbacks survive the row unmounting before the response arrives.
        discardDeletedTuiAgentPayloads(variables);
        pruneRecoveryTiles(
          (tile, epicId) =>
            epicId === variables.epicId &&
            tile.type === "terminal-agent" &&
            tile.id === variables.tuiAgentId &&
            tile.hostId === ctx.hostId,
        );
        // The deletion is a registry fact on a migrated host; without this the
        // row would linger in the tree until the next poll tick.
        for (const hostId of new Set([ctx.hostId, ctx.viewerHostId])) {
          invalidateEpicTuiAgentRecords(queryClient, hostId);
        }
        Analytics.getInstance().track(AnalyticsEvent.TerminalAgentStopped, {
          source: "direct_ui",
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't delete terminal agent.");
      },
    },
  });
}

/**
 * Mutation hook for `epic.renameTerminalAgent`.
 * Input enters pending (read-only) state; success is silent.
 */
export function useEpicRenameTuiAgent() {
  const client = useEpicRecordMutationClient();
  const sessionClient = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.renameTuiAgent",
    EpicRecordMutationContext,
    RenameTuiAgentMutationInput
  >({
    client,
    method: "epic.renameTuiAgent",
    mapVariables: ({ epicId, tuiAgentId, title }) => ({
      epicId,
      tuiAgentId,
      title,
    }),
    options: {
      onMutate: ({ hostId }) => ({
        hostId,
        viewerHostId: sessionClient?.getActiveHostId() ?? null,
      }),
      onSuccess: (_data, _variables, ctx) => {
        // Same refresh as the chat rename: on a migrated host the new title
        // lives in the registry, so without this the row keeps its old title
        // until the poll fires - a rename that reads as a no-op.
        for (const hostId of new Set([ctx.hostId, ctx.viewerHostId])) {
          invalidateEpicTuiAgentRecords(queryClient, hostId);
        }
        Analytics.getInstance().track(AnalyticsEvent.TerminalRenamed, {
          kind: "agent",
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't rename terminal agent.");
      },
    },
  });
}

/** Run after closing deleted tiles: closing also captures Back/Forward payloads. */
export function discardDeletedTuiAgentPayloads({
  epicId,
  tuiAgentId,
  hostId,
}: DeleteTuiAgentMutationInput): void {
  const state = useEpicCanvasStore.getState();
  for (const [tabId, tab] of Object.entries(state.tabsById)) {
    if (tab?.epicId !== epicId) continue;
    for (const [instanceId, payload] of Object.entries(
      state.closedTilePayloadsByTabId[tabId] ?? {},
    )) {
      if (
        payload?.node.type === "terminal-agent" &&
        payload.node.id === tuiAgentId &&
        payload.node.hostId === hostId
      ) {
        state.discardClosedTilePayload(tabId, instanceId);
      }
    }
  }
}
