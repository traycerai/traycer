import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { invalidateEpicTuiAgentRecords } from "@/hooks/chats/use-epic-tui-agent-records";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/** What a TUI mutation has to remember to refresh the record list afterwards: the host it was actually sent to, captured at mutate time so a host swap in flight cannot redirect the invalidation at another machine's cache. */
interface TuiAgentRecordMutationContext {
  readonly hostId: string | null;
}

/** Send on the caller-resolved placement client. No app-wide wrapper. */
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
        // On a migrated host the created record lands in the registry and in nothing this renderer listens to per-epic (the doc write is what the TUI eviction removed), so this - with the push delta - is what keeps `waitForTuiAgentProjected` from riding out the 20s poll interval.
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

/** PTY teardown is the renderer's tab-close responsibility, not the host's. */
export function useEpicDeleteTuiAgent() {
  // The Epic session's client, not the app-wide one: every caller is a
  // surface inside the Epic canvas (the sidebar tree, the sidebar's batch
  // action, the canvas rename), acting on a row the SESSION projected.
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.deleteTuiAgent",
    TuiAgentRecordMutationContext
  >({
    client,
    method: "epic.deleteTuiAgent",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, ctx) => {
        // The deletion is a registry fact on a migrated host; without this the
        // row would linger in the tree until the next poll tick.
        invalidateEpicTuiAgentRecords(queryClient, ctx.hostId);
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

export function useEpicRenameTuiAgent() {
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.renameTuiAgent",
    TuiAgentRecordMutationContext
  >({
    client,
    method: "epic.renameTuiAgent",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, ctx) => {
        // Same refresh as the chat rename: on a migrated host the new title
        // lives in the registry, so without this the row keeps its old title
        // until the poll fires - a rename that reads as a no-op.
        invalidateEpicTuiAgentRecords(queryClient, ctx.hostId);
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
