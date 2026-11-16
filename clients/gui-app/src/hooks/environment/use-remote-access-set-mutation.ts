import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRemoteAccessSetRequestV20,
  HostRemoteAccessSetResponseV20,
} from "@traycer/protocol/host/environment-schemas";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

/**
 * Turns remote access off on the host `client` reaches, through
 * `host.remoteAccess.set@2.0` (On is the app's call to authn,
 * `useRemoteAccessTurnOnMutation`). A successful change also answers the
 * one-time question for that host, so it is not asked again on this desktop,
 * and calls `onTurnedOff`.
 */
export function useRemoteAccessSetMutation(
  client: HostClient<HostRpcRegistry> | null,
  onTurnedOff: () => void,
): UseMutationResult<
  HostRemoteAccessSetResponseV20,
  HostRpcError,
  HostRemoteAccessSetRequestV20,
  { readonly hostId: string | null }
> {
  const answerRemoteAccess = useHostAccessPromptsStore(
    (state) => state.answerRemoteAccess,
  );
  return useHostScopedMutationForClient(client, {
    method: "host.remoteAccess.set",
    mutationKey: environmentMutationKeys.remoteAccessSet(),
    errorMessage: null,
    invalidateMethods: ["environment.status"],
    onSuccess: (_data, _variables, hostId) => {
      if (hostId !== null) answerRemoteAccess(hostId);
      onTurnedOff();
    },
  });
}
