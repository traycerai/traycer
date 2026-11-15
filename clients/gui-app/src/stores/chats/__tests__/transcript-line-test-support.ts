import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { makeMessageAt } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  transcriptListRows,
  type TranscriptListRow,
} from "@/stores/chats/transcript-list-rows";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/** The channel's rows as the real list builder makes them on the legacy line. */
export function channelRows(
  ...createdAts: ReadonlyArray<number>
): readonly TranscriptListRow[] {
  return transcriptListRows({
    window: null,
    rendered: createdAts.map((createdAt, index) =>
      makeMessageAt(index, "user", createdAt),
    ),
    splitLongTurns: false,
  });
}

/** Each row as `message-<n>` or the line's key, in list order. */
export function layout(
  rows: readonly TranscriptListRow[],
): ReadonlyArray<string> {
  return rows.map((row) => row.key);
}

function skeletonEntry(rowId: string): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000,
    role: "user",
    byteLength: 32,
    bodyDigest: `d-${rowId}`,
  };
}

/** A window of `ids.length` rows of which only those at `hydrated` are served. */
function windowOver(
  ids: ReadonlyArray<string>,
  hydrated: ReadonlyArray<number>,
): TranscriptWindow {
  return {
    ...emptyTranscriptWindow(),
    rowCount: ids.length,
    skeleton: ids.map(skeletonEntry),
    skeletonComplete: true,
    skeletonStreamCoveredThrough: ids.length,
    indexRevisionRebuilding: false,
    spans: hydrated.map((ordinal) => ({
      fromOrdinal: ordinal,
      rowIds: [ids[ordinal]],
      messageIds: [],
      eventIds: [],
      rowContext: {},
      contextBytes: 0,
    })),
  };
}

export function windowedRows(
  hydrated: ReadonlyArray<number>,
): readonly TranscriptListRow[] {
  const ids = ["message-0", "message-1", "message-2"];
  return transcriptListRows({
    window: windowOver(ids, hydrated),
    rendered: hydrated.map((ordinal) =>
      makeMessageAt(ordinal, "user", 100 + ordinal * 200),
    ),
    splitLongTurns: false,
  });
}
