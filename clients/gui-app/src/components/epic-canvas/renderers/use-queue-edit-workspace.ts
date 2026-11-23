import { useEffect, useMemo } from "react";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  failedWorktreePathsForDisplay,
  mergeWorktreeIntentsForDisplay,
  type SeededWorktreeIntentDisplay,
} from "@/stores/chats/chat-session-store";
import { queueEditWorktreeIntent } from "@/stores/chats/queue-edit-custody";
import {
  queueEditStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import { effectiveMissingWorktreePaths } from "@/lib/composer/workspace-composer-availability";

/** What the folder picker shows and does while a queued message is edited. */
export interface QueueEditWorkspace {
  /** The picker's `queueEdit` surface field. */
  readonly surface: {
    readonly queueItemId: string;
    readonly readOnly: boolean;
  };
  /**
   * The row's own choice over the chat's owed request, per folder. The
   * binding sits beneath both, and the edit's picks above.
   */
  readonly inFlightWorktreeIntent: WorktreeIntent | null;
  /** Owed folders that failed and that the row's own choice does not name. */
  readonly failedWorktreePaths: ReadonlyArray<string>;
  readonly missingWorktreePaths: ReadonlyArray<string>;
  /** Whether saving the edit changes the queued message's folders. */
  readonly changesWorkspace: boolean;
}

const NO_PATHS: ReadonlySet<string> = new Set();

/**
 * The edit-mode view of a chat's folders, or `null` while no queued row is
 * edited. Also owns the edit's staging slot: it is cleared whenever the edit
 * ends - saved (the save already took it), cancelled, the row gone, or the tile
 * closed - so a pick made during an edit never outlives it.
 */
export function useQueueEditWorkspace(input: {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly editingQueueItemId: string | null;
  readonly rowWorktreeIntent: WorktreeIntent | null;
  readonly seeded: SeededWorktreeIntentDisplay | null;
  /** The chat's line can take the folders with the edit. */
  readonly carriesWorktreeIntent: boolean;
  readonly missingWorktreePaths: ReadonlyArray<string>;
}): QueueEditWorkspace | null {
  const {
    hostId,
    epicId,
    chatId,
    editingQueueItemId,
    rowWorktreeIntent,
    seeded,
    carriesWorktreeIntent,
    missingWorktreePaths,
  } = input;
  const stagingKeyId =
    editingQueueItemId === null
      ? null
      : worktreeStagingKeyString(
          queueEditStagingKey(hostId, epicId, chatId, editingQueueItemId),
        );
  const picked = useWorktreeIntentStagingStore((state) =>
    stagingKeyId === null ? undefined : state.intentByKey[stagingKeyId],
  );
  useEffect(() => {
    if (editingQueueItemId === null) return undefined;
    const key = queueEditStagingKey(hostId, epicId, chatId, editingQueueItemId);
    return () => {
      useWorktreeIntentStagingStore.getState().clear(key);
    };
  }, [chatId, editingQueueItemId, epicId, hostId]);
  return useMemo(() => {
    if (editingQueueItemId === null) return null;
    const pickedPaths =
      picked === undefined
        ? NO_PATHS
        : new Set(picked.entries.map((entry) => entry.workspacePath));
    return {
      surface: {
        queueItemId: editingQueueItemId,
        readOnly: !carriesWorktreeIntent,
      },
      inFlightWorktreeIntent: mergeWorktreeIntentsForDisplay(
        seeded?.intent ?? null,
        rowWorktreeIntent,
      ),
      failedWorktreePaths: failedWorktreePathsForDisplay(
        seeded,
        rowWorktreeIntent,
      ),
      missingWorktreePaths: effectiveMissingWorktreePaths(
        missingWorktreePaths,
        pickedPaths,
      ),
      changesWorkspace:
        carriesWorktreeIntent &&
        queueEditWorktreeIntent(picked ?? null, rowWorktreeIntent) !== null,
    };
  }, [
    carriesWorktreeIntent,
    editingQueueItemId,
    missingWorktreePaths,
    picked,
    rowWorktreeIntent,
    seeded,
  ]);
}
