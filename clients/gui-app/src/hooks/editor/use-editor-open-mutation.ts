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
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * `intent` is the caller's declared gesture: only opening a workspace ROOT
 * counts toward `workspace_opened_in_editor` - single-file opens (e.g. a
 * changed file from a diff tile) would overstate editor workspace adoption
 * and deliberately emit nothing here.
 */
export function useEditorOpen(
  intent: "file" | "workspace",
): UseMutationResult<
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
      onSuccess: (_response, variables) => {
        if (intent !== "workspace") return;
        Analytics.getInstance().track(AnalyticsEvent.WorkspaceOpenedInEditor, {
          source: "direct_ui",
          editor: variables.editorId,
        });
      },
      onError: (error) => {
        toastFromHostError(error, error.message);
      },
    },
  });
}
