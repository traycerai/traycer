import { settleDetachedEpicMutation } from "@/lib/artifacts/detached-epic-mutation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

/** Optimistic sidebar removal and its rollback, shared by single and subtree deletes. */
export function prepareAgentDelete(
  handle: OpenEpicStoreHandle,
  nodeId: string,
  kind: "chat" | "terminal-agent",
): () => void {
  settleDetachedEpicMutation(
    handle.store.getState().deleteArtifact(nodeId),
    "sidebar tree",
    "local delete projection",
  );
  if (kind === "chat") {
    useEpicCanvasStore.getState().markArtifactSelfDeleted(nodeId);
  }
  return () => {
    if (kind === "chat") {
      useEpicCanvasStore.getState().unmarkArtifactSelfDeleted(nodeId);
    }
  };
}
