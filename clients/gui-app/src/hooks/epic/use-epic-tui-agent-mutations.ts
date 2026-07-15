import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host/runtime";
import { toastFromHostError } from "@/lib/host-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * Mutation hook for `epic.createTerminalAgent`.
 *
 * The caller is responsible for first minting an SDK session via
 * `agent.startTerminalSession` and then handing the resulting
 * `harnessId` + `sessionId` + `hostId` + `workspaceFolders` to this
 * mutation so the host can persist a terminal-agent record into the
 * epic's `tuiAgents` Y.Map.
 */
export function useEpicCreateTuiAgent() {
  const client = useHostClient();
  return useEpicCreateTuiAgentForClient(client);
}

/**
 * Host-parametric variant of {@link useEpicCreateTuiAgent}: persists the
 * terminal-agent record through an explicit `HostClient` (e.g. a sidebar
 * row's OWN host resolved via `useHostClientFor`) instead of the app-wide
 * active host. `null` client rejects through the shared
 * `useHostMutation` preflight.
 */
export function useEpicCreateTuiAgentForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  return useHostMutation({
    client,
    method: "epic.createTuiAgent",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: (_data, variables) => {
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

/**
 * Mutation hook for `epic.deleteTerminalAgent`.
 *
 * Removes the terminal-agent record from the epic's `tuiAgents` Y.Map.
 * Caller opens a confirm dialog first; success is silent (the Y.Doc stream
 * removes the row); failure shows a toast. PTY teardown is the renderer's
 * tab-close responsibility, not the host's.
 */
export function useEpicDeleteTuiAgent() {
  const client = useHostClient();
  return useHostMutation({
    client,
    method: "epic.deleteTuiAgent",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: () => {
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
  const client = useHostClient();
  return useHostMutation({
    client,
    method: "epic.renameTuiAgent",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: () => {
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
