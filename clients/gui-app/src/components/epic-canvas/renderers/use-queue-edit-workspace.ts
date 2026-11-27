import { useLayoutEffect, useMemo } from "react";
import type {
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  failedWorktreePathsForDisplay,
  mergeWorktreeIntentsForDisplay,
  type SeededWorktreeIntentDisplay,
} from "@/stores/chats/chat-session-store";
import { queueEditWorktreeIntent } from "@/stores/chats/queue-edit-custody";
import {
  closeQueueEditStaging,
  openQueueEditStaging,
  queueEditStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import { effectiveMissingWorktreePaths } from "@/lib/composer/workspace-composer-availability";

/** One queued message being edited, and the editing session it is edited in. */
export interface QueueEditSession {
  readonly queueItemId: string;
  readonly sessionId: string;
}

/** What the folder picker shows and does while a queued message is edited. */
export interface QueueEditWorkspace {
  /** The picker's `queueEdit` surface field. */
  readonly surface: {
    readonly queueItemId: string;
    readonly editSessionId: string;
    readonly readOnly: boolean;
  };
  /**
   * The row's own choice over the chat's owed request, per folder. The
   * binding sits beneath both, and the edit's picks above.
   */
  readonly inFlightWorktreeIntent: WorktreeIntent | null;
  /**
   * The edited message's own folders as saving would leave them, one entry
   * per folder: the edit's picks over the row's choice. It stands where the
   * chat's staged pick stands for the chat's next send, the binding beneath.
   */
  readonly worktreeIntent: WorktreeIntent | null;
  /** Owed folders that failed and that the row's own choice does not name. */
  readonly failedWorktreePaths: ReadonlyArray<string>;
  /**
   * The chat's missing folders the edited message would still run in: neither
   * the row's own choice nor a pick of this edit names them.
   */
  readonly missingWorktreePaths: ReadonlyArray<string>;
  /** Whether saving the edit changes the queued message's folders. */
  readonly changesWorkspace: boolean;
  /**
   * The edit changes the folders, and the chat's line can no longer take them
   * (the host was downgraded mid-edit). Saving is refused until the edit is
   * cancelled, which is the person's way to discard the picks.
   */
  readonly foldersBlocked: boolean;
}

/**
 * The edit-mode view of a chat's folders, or `null` while no queued row is
 * edited. Also owns the edit session's staging slot: it ends whenever the edit
 * does - saved (the save already took it), cancelled, the row gone, or the tile
 * closed - so a pick made during an edit never outlives it.
 */
export function useQueueEditWorkspace(input: {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly edit: QueueEditSession | null;
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
    rowWorktreeIntent,
    seeded,
    carriesWorktreeIntent,
    missingWorktreePaths,
  } = input;
  const queueItemId = input.edit?.queueItemId ?? null;
  const sessionId = input.edit?.sessionId ?? null;
  const stagingKeyId =
    queueItemId === null || sessionId === null
      ? null
      : worktreeStagingKeyString(
          queueEditStagingKey(hostId, epicId, chatId, {
            queueItemId,
            sessionId,
          }),
        );
  const picked = useWorktreeIntentStagingStore((state) =>
    stagingKeyId === null ? undefined : state.intentByKey[stagingKeyId],
  );
  // A layout effect: whether an edit is open is read by every pane's handoff
  // driver from its own passive effect, including one that runs in this same
  // commit, so the edit must be open (or closed) before any of them.
  useLayoutEffect(() => {
    if (queueItemId === null || sessionId === null) return undefined;
    const key = queueEditStagingKey(hostId, epicId, chatId, {
      queueItemId,
      sessionId,
    });
    openQueueEditStaging(key);
    return () => {
      closeQueueEditStaging(key);
    };
  }, [chatId, epicId, hostId, queueItemId, sessionId]);
  return useMemo(() => {
    if (queueItemId === null || sessionId === null) return null;
    const changesFolders =
      queueEditWorktreeIntent(picked ?? null, rowWorktreeIntent) !== null;
    return {
      surface: {
        queueItemId,
        editSessionId: sessionId,
        readOnly: !carriesWorktreeIntent,
      },
      inFlightWorktreeIntent: mergeWorktreeIntentsForDisplay(
        seeded?.intent ?? null,
        rowWorktreeIntent,
      ),
      worktreeIntent: overlayPerFolder(rowWorktreeIntent, picked ?? null),
      failedWorktreePaths: failedWorktreePathsForDisplay(
        seeded,
        rowWorktreeIntent,
      ),
      missingWorktreePaths: effectiveMissingWorktreePaths(
        missingWorktreePaths,
        new Set(
          [
            ...(rowWorktreeIntent?.entries ?? []),
            ...(picked?.entries ?? []),
          ].map((entry) => entry.workspacePath),
        ),
      ),
      changesWorkspace: carriesWorktreeIntent && changesFolders,
      foldersBlocked: !carriesWorktreeIntent && changesFolders,
    };
  }, [
    carriesWorktreeIntent,
    missingWorktreePaths,
    picked,
    queueItemId,
    rowWorktreeIntent,
    seeded,
    sessionId,
  ]);
}

/**
 * One entry per folder, `above` replacing `below` for a folder both name. A
 * concatenation would keep both, and a reader that takes a folder's first
 * entry would see the replaced one.
 */
function overlayPerFolder(
  below: WorktreeIntent | null,
  above: WorktreeIntent | null,
): WorktreeIntent | null {
  const byPath = new Map<string, WorktreeFolderIntent>();
  for (const entry of [...(below?.entries ?? []), ...(above?.entries ?? [])]) {
    byPath.set(entry.workspacePath, entry);
  }
  return byPath.size === 0 ? null : { entries: [...byPath.values()] };
}
