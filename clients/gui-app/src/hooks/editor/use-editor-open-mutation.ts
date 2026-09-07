import type { UseMutationResult } from "@tanstack/react-query";
import { isEditorId } from "@traycer/protocol/host/editor/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
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

export type EditorOpenMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "editor.openPaths">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "editor.openPaths">
>;

/** Every Epic-scoped caller (a diff tile, a workspace-file tile) must use {@link useEditorOpenForClient} with its own tab client instead: `editor.openPaths` resolves the path on the host it is sent to, so an app-wide read opens the wrong machine's file during an A→B re-point (D15). */
export function useEditorOpen(
  intent: "file" | "workspace",
): EditorOpenMutation {
  return useEditorOpenForClient(useHostClient(), intent);
}

/** a changed file from a diff tile) would overstate editor workspace adoption and deliberately emit nothing here. */
export function useEditorOpenForClient(
  client: HostClient<HostRpcRegistry> | null,
  intent: "file" | "workspace",
): EditorOpenMutation {
  return useHostMutation<HostRpcRegistry, "editor.openPaths">({
    client,
    method: "editor.openPaths",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: editorMutationKeys.openPaths(),
      onSuccess: (_response, variables) => {
        if (intent !== "workspace") return;
        // Neither is an editor and the analytics `editor` field is the editor enum, so the guard asks "is this an editor" rather than listing the literals that exist today: a later target is excluded by construction.
        if (!isEditorId(variables.editorId)) return;
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
