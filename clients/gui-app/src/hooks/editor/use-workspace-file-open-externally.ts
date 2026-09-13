import { useCallback } from "react";
import type { OpenPathsTarget } from "@traycer/protocol/host/editor/unary-schemas";
import { useEditorOpenFeedback } from "@/hooks/editor/use-editor-open-feedback";
import { useEditorOpenForClient } from "@/hooks/editor/use-editor-open-mutation";
import { useHostPathOpenAvailability } from "@/hooks/editor/use-host-path-open-availability";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { resolveAbsolutePath } from "@/lib/path/cross-platform-path";

/**
 * The one Open Externally wiring for a workspace file tile: the tab host's
 * `editor.openPaths` mutation plus the shared pressed-feedback window, keyed
 * to the caller's target (an editor id, or `"system"` for the OS default
 * app). The file lives on the TAB's host - opening it app-wide would ask
 * whichever machine the app is pointed at for a path it may not have. Remote
 * tabs expose no action: this RPC opens on the host, not on the client.
 */
export function useWorkspaceFileOpenExternally(args: {
  readonly workspacePath: string;
  readonly filePath: string;
  readonly target: OpenPathsTarget;
}): {
  readonly opening: boolean;
  readonly onOpenExternally: (() => void) | null;
} {
  const canOpenHostPaths = useHostPathOpenAvailability(useTabHostId());
  const editorOpen = useEditorOpenForClient(useTabHostClient(), "file");
  const { active: feedbackActive, trigger: triggerFeedback } =
    useEditorOpenFeedback();
  const opening = editorOpen.isPending || feedbackActive;
  const { workspacePath, filePath, target } = args;
  const onOpenExternally = useCallback(() => {
    if (!canOpenHostPaths || opening) return;
    triggerFeedback();
    editorOpen.mutate({
      editorId: target,
      paths: [resolveAbsolutePath(workspacePath, filePath)],
    });
  }, [
    canOpenHostPaths,
    editorOpen,
    filePath,
    opening,
    target,
    triggerFeedback,
    workspacePath,
  ]);
  return {
    opening,
    onOpenExternally: canOpenHostPaths ? onOpenExternally : null,
  };
}
