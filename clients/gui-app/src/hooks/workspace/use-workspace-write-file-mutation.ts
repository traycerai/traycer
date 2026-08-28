import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { workspaceMutationKeys } from "@/lib/query-keys";

export function useWorkspaceWriteFile(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "workspace.writeFile">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "workspace.writeFile">
> {
  return useHostMutation<HostRpcRegistry, "workspace.writeFile">({
    client,
    method: "workspace.writeFile",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: workspaceMutationKeys.writeFile(),
    },
  });
}
