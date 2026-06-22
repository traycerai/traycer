import type { UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { editorMutationKeys } from "@/lib/query-keys";

export function useEditorOpen(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "editor.openPaths">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "editor.openPaths">
> {
  const client = useHostClient();
  return useHostMutation<HostRpcRegistry, "editor.openPaths">({
    client,
    method: "editor.openPaths",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: editorMutationKeys.openPaths(),
      onError: (error) => {
        toastFromHostError(error, error.message);
      },
    },
  });
}
