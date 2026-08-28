import {
  forkChatStagingKeysForEpic,
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import {
  seededWorkspaceSnapshotKeyIds,
  useSeededWorkspaceSnapshotStore,
} from "@/stores/worktree/seeded-workspace-snapshot-store";

/**
 * Tear down one fork-chat scratch slot: the staged intent AND the live
 * seeded-workspace snapshot beside it. The two stores share a key and are
 * always written together, so clearing one alone leaves the dialog's next open
 * reading half of the last one's state.
 */
export function clearChatForkWorkspace(stagingKey: WorktreeStagingKey): void {
  useWorktreeIntentStagingStore.getState().clear(stagingKey);
  useSeededWorkspaceSnapshotStore.getState().clear(stagingKey);
}

/**
 * Tear down every fork-chat slot in an epic, across every host one was staged
 * against.
 *
 * The dialog's slots are per (epic, target host) now, so "clear the fork
 * scratch state" is no longer a single key a caller can name — the opener does
 * not know which hosts the previous fork dialog visited before it closed, and a
 * leftover slot for one of them would seed the next fork with another machine's
 * folders.
 */
export function clearChatForkWorkspacesForEpic(epicId: string): void {
  for (const key of forkChatStagingKeysForEpic(
    epicId,
    seededWorkspaceSnapshotKeyIds(),
  )) {
    clearChatForkWorkspace(key);
  }
}
