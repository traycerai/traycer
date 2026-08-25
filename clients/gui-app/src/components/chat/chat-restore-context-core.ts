import { createContext } from "react";
import type {
  ChatAccess,
  ChatActiveTurn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
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
   * pinned accumulated-changes panel above the composer. Content-free: a row
   * carries its own `+/-` (host-computed on the windowed line, summed per-edit
   * while the active turn writes), and the file bodies are fetched only by the
   * diff surface a row click opens. */
  readonly accumulatedFileChanges: ReadonlyArray<AccumulatedChangeRow>;
  /**
   * Host rows the snapshot has counted but whose summaries have not arrived
   * yet. `0` once the set is complete, and always `0` on the pre-windowed line.
   * Non-zero means the list above is a PREFIX, which the panel has to say
   * rather than imply otherwise - "Undo all" reverts the host's whole set.
   */
  readonly undeliveredChangeCount: number;
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
