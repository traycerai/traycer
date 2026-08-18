import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

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
  // The Epic session's client, not the app-wide one: every caller is a
  // surface inside the Epic canvas (the sidebar tree, the sidebar's batch
  // action, the canvas rename), acting on a row the SESSION projected.
  const client = useEpicSessionHostClient();
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
  // Session client, as above.
  const client = useEpicSessionHostClient();
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
