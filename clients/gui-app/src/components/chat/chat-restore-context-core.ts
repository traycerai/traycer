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
  /** Chat-level cumulative changes (first snapshot → current). Drives the pinned accumulated-changes panel above the composer. */
  readonly accumulatedFileChanges: ReadonlyArray<AccumulatedChangeRow>;
  /** Non-zero means the list above is a PREFIX, which the panel has to say rather than imply otherwise - "Undo all" reverts the host's whole set. */
  readonly undeliveredChangeCount: number;
  /** Whether the delivered summary set AGREES with the host's authoritative count - `accumulatedSummarySetComplete`, carried rather than re-derived. */
  readonly accumulatedSetComplete: boolean;
  /** Revert files to their first-in-chat snapshot. `fromMessageId === null` scopes to the whole chat; `filePaths === null` reverts every file. */
  readonly revertFileChanges: (
    fromMessageId: string | null,
    filePaths: ReadonlyArray<string> | null,
    revertArtifacts: boolean,
  ) => string | null;
}

export const ChatRestoreContext = createContext<ChatRestoreContextValue | null>(
  null,
);
