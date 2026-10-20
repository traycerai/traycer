import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRemoteAccessSetRequest,
  HostRemoteAccessSetResponse,
  RemoteAccessState,
} from "@traycer/protocol/host/environment-schemas";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

/**
 * Turns remote access on or off on the host `client` reaches. Any choice the
 * person makes also answers the one-time question for that host, so it is not
 * asked again on this desktop. `onAnswer` receives the host's answer: Off
 * answers `turning_off` until its sessions are closed.
 */
export function useRemoteAccessSetMutation(
  client: HostClient<HostRpcRegistry> | null,
  onAnswer: (state: RemoteAccessState) => void,
): UseMutationResult<
  HostRemoteAccessSetResponse,
  HostRpcError,
  HostRemoteAccessSetRequest,
  { readonly hostId: string | null }
> {
  const answerRemoteAccess = useHostAccessPromptsStore(
    (state) => state.answerRemoteAccess,
  );
  return useHostScopedMutationForClient(client, {
    method: "host.remoteAccess.set",
    mutationKey: environmentMutationKeys.remoteAccessSet(),
    errorMessage: "Couldn't change remote access.",
    invalidateMethods: ["environment.status"],
    onSuccess: (data, _variables, hostId) => {
      if (hostId !== null) answerRemoteAccess(hostId);
      onAnswer(data.state);
    },
  });
}
