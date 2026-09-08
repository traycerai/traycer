import { useMemo, type ReactNode } from "react";
import {
  WorktreeScriptsDialog,
  type WorktreeScriptsContext,
} from "@/components/home/worktree/worktree-scripts-dialog";
import { useEpicAppearanceSource } from "@/hooks/appearance/use-workspace-appearance";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useWorktreeListByWorkspacePathsForClient } from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";

/**
 * The SAME dialog the workspace picker's ⚙ opens, pointed at the repo this
 * epic's primary folder resolves to. A tab knows a repository root and nothing
 * about worktree staging, so the context is pre-create shaped (no owner, no
 * binding) - the edit lands on the repo's own committed
 * `.traycer/environment.json`, which is where identity belongs anyway.
 */
export function TabRepositorySettingsDialog(props: {
  readonly epicId: string;
  readonly hostId: string | null;
  /** The strip already resolved this for a repo that has an identity. */
  readonly identityPath: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const source = useEpicAppearanceSource({
    hostId: props.identityPath === null ? props.hostId : null,
    epicId: props.epicId,
  });
  const workspacePath = props.identityPath ?? source.workspacePath;
  const hostId = source.hostId ?? props.hostId;
  const hostClient = useHostClientForHostId(hostId);
  const summaries = useWorktreeListByWorkspacePathsForClient(hostClient, {
    workspacePaths: workspacePath === null ? [] : [workspacePath],
    enabled: workspacePath !== null,
  });
  const summary =
    summaries.data?.workspaces.find(
      (entry) => entry.workspacePath === workspacePath,
    ) ?? null;
  const context = useMemo<WorktreeScriptsContext>(
    () => ({
      epicId: props.epicId,
      hostId,
      ownerId: null,
      ownerKind: null,
      binding: null,
      // A slot nothing stages into: this surface never proposes a worktree, so
      // the scripts edit resolves to the repo's own file.
      stagingKey: { surface: "landing", hostId, draftId: null },
      hostClient,
      regenerateBranchNameForWorkspace: () => null,
    }),
    [props.epicId, hostId, hostClient],
  );
  if (workspacePath === null || summary === null) return null;
  return (
    <WorktreeScriptsDialog
      open
      target={{ workspacePath, summary }}
      context={context}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    />
  );
}
