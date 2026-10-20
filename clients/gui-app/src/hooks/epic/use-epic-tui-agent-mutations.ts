import type {
  DeleteTuiAgentRequest,
  RenameTuiAgentRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  enactedOwnerHostId,
  useEpicRecordLifecycleMutationClient,
  useEpicRecordMutationClient,
  type EpicRecordLifecycleMutationContext,
  type EpicRecordMutationContext,
  type EpicRecordMutationTarget,
} from "@/hooks/epic/use-epic-record-mutation-client";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import {
  recordOwnerHostLabel,
  toastRequestedRecordWrite,
} from "@/lib/epics/record-write-outcome-toast";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { toastFromOwnerHostWriteError } from "@/lib/owner-host-write-error-toast";
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

/**
 * Delete on the owning host, which also tears down its runtime and worktree
 * binding. When the owner is down the call goes to a live host, which deletes
 * the cloud row (`outcome: "requested"`); the owner tears down when it is back.
 */
export function useEpicDeleteTuiAgent() {
  return useEpicDeleteTuiAgentMutation("individual");
}

/**
 * `useEpicDeleteTuiAgent` for one delete among several in a batch: the caller
 * reports the batch's failures once (`toastFromOwnerHostBatchWriteFailures`),
 * so a failure here raises no notice of its own.
 */
export function useEpicDeleteTuiAgentInBatch() {
  return useEpicDeleteTuiAgentMutation("aggregate");
}

function useEpicDeleteTuiAgentMutation(
  failurePresentation: "individual" | "aggregate",
) {
  const route = useEpicRecordLifecycleMutationClient("epic.deleteTuiAgent");
  const sessionClient = useEpicSessionHostClient();
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.deleteTuiAgent",
    EpicRecordLifecycleMutationContext,
    DeleteTuiAgentMutationInput
  >({
    client: route.client,
    method: "epic.deleteTuiAgent",
    mapVariables: ({ epicId, tuiAgentId }) => ({ epicId, tuiAgentId }),
    requiredHostMethodVersion: route.requiredHostMethodVersion,
    options: {
      onMutate: (variables) => ({
        hostId: variables.hostId,
        viewerHostId: sessionClient?.getActiveHostId() ?? null,
        servingHostId: route.servingHostId(variables),
      }),
      onSuccess: (data, variables, ctx) => {
        // Every follow-up below is keyed to the host whose record changed: a
        // stand-in's `applied` means authority had moved to it, and a
        // `requested` answer names the owner it filed for (`enactedOwnerHostId`).
        const ownerHostId = enactedOwnerHostId(data, ctx);
        // Hook callbacks survive the row unmounting before the response arrives.
        if (ownerHostId !== null) {
          useEpicCanvasStore
            .getState()
            .closeConfirmedDeletedAgentTiles(
              variables.epicId,
              variables.tuiAgentId,
              ownerHostId,
              "terminal-agent",
            );
        }
        // The deletion is a registry fact on a migrated host; without this the
        // row would linger in the tree until the next poll tick. The visible
        // session may have been replaced while the write travelled, and its
        // list fetched before the delete committed.
        for (const hostId of new Set([
          ctx.hostId,
          ownerHostId,
          ctx.viewerHostId,
          ctx.servingHostId,
          getOpenEpicRegistry().peek(variables.epicId)?.hostId ?? null,
        ])) {
          invalidateEpicTuiAgentRecords(queryClient, hostId);
        }
        // Only an applied delete stopped the agent: a requested one deleted
        // the cloud row, and the agent runs until its owner is back.
        if (data.outcome === "applied") {
          Analytics.getInstance().track(AnalyticsEvent.TerminalAgentStopped, {
            source: "direct_ui",
          });
        }
        if (data.outcome === "requested" && ownerHostId !== null) {
          toastRequestedRecordWrite({
            write: "remove-terminal-agent",
            ownerHostId,
            hostLabel: recordOwnerHostLabel(binding, ownerHostId),
          });
        }
      },
      onError: (error, variables, ctx) => {
        // The host may have committed the delete before its answer was lost,
        // so refresh every list it could have changed - the routed owner's,
        // the viewer's, the host the call went to and the visible session's -
        // whichever way the failure is presented.
        if (ctx !== undefined) {
          for (const hostId of new Set([
            ctx.hostId,
            ctx.viewerHostId,
            ctx.servingHostId,
            getOpenEpicRegistry().peek(variables.epicId)?.hostId ?? null,
          ])) {
            invalidateEpicTuiAgentRecords(queryClient, hostId);
          }
        }
        if (failurePresentation === "individual") {
          toastFromOwnerHostWriteError(
            error,
            "Couldn't delete terminal agent.",
          );
        }
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
      onSuccess: (_data, variables, ctx) => {
        // Same refresh as the chat rename: on a migrated host the new title
        // lives in the registry, so without this the row keeps its old title
        // until the poll fires - a rename that reads as a no-op. The visible
        // session too: it may have been replaced while the rename travelled.
        for (const hostId of new Set([
          ctx.hostId,
          ctx.viewerHostId,
          getOpenEpicRegistry().peek(variables.epicId)?.hostId ?? null,
        ])) {
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
