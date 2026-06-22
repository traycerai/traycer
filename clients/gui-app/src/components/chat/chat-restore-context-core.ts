import { createContext } from "react";
import type {
  ChatAccess,
  ChatActiveTurn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { AccumulatedFileChange } from "@/lib/chat/accumulated-file-changes-from-messages";
import type { ChatRestoreSlot } from "@/stores/chats/chat-session-store";

export interface ChatRestoreContextValue {
  readonly accessRole: ChatAccess["role"] | null;
  readonly currentUserId: string | null;
  readonly activeHostId: string | null;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly localSnapshotsClearedAt: number | null;
  readonly restore: ChatRestoreSlot | null;
  readonly restoreActionPending: boolean;
  readonly restoreCheckpoint: (
    checkpointId: string,
    revertArtifacts: boolean,
  ) => string | null;
  /** Chat-level cumulative changes (first snapshot → current). Drives the
   * pinned accumulated-changes panel above the composer. Active-turn rows carry
   * `streamingCounts` so the panel's `+/-` updates live mid-stream. */
  readonly accumulatedFileChanges: ReadonlyArray<AccumulatedFileChange>;
  /** Revert files to their first-in-chat snapshot. `fromMessageId === null`
   * scopes to the whole chat; `filePaths === null` reverts every file.
   * `revertArtifacts === false` excludes artifact changes from the revert. */
  readonly revertFileChanges: (
    fromMessageId: string | null,
    filePaths: ReadonlyArray<string> | null,
    revertArtifacts: boolean,
  ) => string | null;
}

export const ChatRestoreContext = createContext<ChatRestoreContextValue | null>(
  null,
);
