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
  /**
   * Whether the delivered summary set AGREES with the host's authoritative
   * count - `accumulatedSummarySetComplete`, carried rather than re-derived.
   *
   * Distinct from `undeliveredChangeCount === 0`, and that distinction is the
   * whole reason it is here: the count clamps at zero, so an OVERSHOOT (a
   * revert lowered the host's count while the client still holds the previous
   * summary array, because the replacement index-0 chunk was dropped) reports
   * `0` and reads as complete. Any gate that decides whether the set can be
   * ACTED on - reviewed, bundled, counted as definitive - must read this.
   */
  readonly accumulatedSetComplete: boolean;
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
