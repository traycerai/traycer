/**
 * A bot's chat on the windowed line, played from the host's side (see
 * `windowed-session-frames.ts`): the pieces only a bot's chat needs, built on
 * the shared frame builders. The chat session store is the real one, so what
 * a transcript draws comes from the real window, the real renderer and the
 * real list merge.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import {
  buildTranscriptRecordLookup,
  sliceTranscriptRange,
} from "@traycer/protocol/persistence/chat-transcript/read-range";
import {
  projectTranscriptRows,
  type TranscriptRowProjectionInput,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { OpenChatEvent } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import {
  skeletonChunkFrame,
  wholeTail,
  windowedSnapshotFrame,
  type WindowedChatIds,
  type WindowedSession,
} from "@/stores/chats/__tests__/windowed-session-frames";

export {
  createWindowedSession,
  type WindowedChatIds,
  type WindowedSession,
} from "@/stores/chats/__tests__/windowed-session-frames";

/** The transcript the chat holds when it opens: its rows, as the host numbers them. */
export type WindowedTranscript = TranscriptRowProjectionInput<
  OpenMessage,
  OpenChatEvent
>;

/**
 * Opens the chat on `input`: the bounded snapshot with the whole transcript in
 * its tail, then the row skeleton in one final chunk. The window then holds
 * `input`'s rows, hydrated, under index revision 1.
 */
export function openWindowedChat(
  session: WindowedSession,
  ids: WindowedChatIds,
  input: WindowedTranscript,
): void {
  session.callbacks().onWindowedSnapshot(
    windowedSnapshotFrame(ids, {
      rowCount: projectTranscriptRows(input).length,
      tail: wholeTail(input),
      indexRevision: 1,
    }),
  );
  session.callbacks().onSkeletonChunk(skeletonChunkFrame(ids, input));
  // The stream is open: the chat takes the member's sends.
  session.handle.store.setState({ connectionStatus: "open" });
}

/**
 * The host replaces a void window: a fresh snapshot of `input` and its
 * skeleton, in `epoch` under `indexRevision`.
 */
export function recoverWindowedChat(
  session: WindowedSession,
  ids: WindowedChatIds,
  input: WindowedTranscript,
  next: { readonly epoch: number; readonly indexRevision: number },
): void {
  const snapshot = windowedSnapshotFrame(ids, {
    rowCount: projectTranscriptRows(input).length,
    tail: wholeTail(input),
    indexRevision: next.indexRevision,
  });
  session.callbacks().onWindowedSnapshot({
    ...snapshot,
    snapshot: { ...snapshot.snapshot, transcriptEpoch: next.epoch },
  });
  const chunk = skeletonChunkFrame(ids, input);
  session.callbacks().onSkeletonChunk({
    ...chunk,
    chunk: { ...chunk.chunk, epoch: next.epoch },
  });
}

/**
 * The host's index names a member's own send, appended at the next ordinal,
 * before any frame has carried its body: the delta alone.
 */
export function indexNamesAppendedRow(
  session: WindowedSession,
  ids: WindowedChatIds,
  input: {
    readonly rowCount: number;
    readonly indexRevision: number;
    readonly entry: RowSkeletonEntry;
  },
): void {
  session.callbacks().onIndexChanged({
    kind: "indexChanged",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    epoch: 1,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    changes: [{ type: "appended", entries: [input.entry] }],
  });
}

/**
 * The host moved rows it had indexed: a `reindexed` delta into the next epoch.
 * The client's window goes void until a snapshot or an index replaces it.
 */
export function indexReindexed(
  session: WindowedSession,
  ids: WindowedChatIds,
  input: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly indexRevision: number;
  },
): void {
  session.callbacks().onIndexChanged({
    kind: "indexChanged",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    epoch: input.epoch,
    rowCount: input.rowCount,
    indexRevision: input.indexRevision,
    changes: [{ type: "reindexed" }],
  });
}

/** The host's shared `messageAccepted` frame: the member's own post, whole. */
export function messageAccepted(
  session: WindowedSession,
  ids: WindowedChatIds,
  message: Extract<OpenMessage, { role: "user" }>,
): void {
  session.callbacks().onMessageAccepted({
    kind: "messageAccepted",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    message,
  });
}

/**
 * The host answers the list's latest `loadRange` from `input`, which holds
 * the member's own post: the body arriving by a range response alone.
 */
export function answerRangeWith(
  session: WindowedSession,
  ids: WindowedChatIds,
  input: WindowedTranscript,
): void {
  const request = session.rangeRequests.at(-1);
  if (request === undefined) throw new Error("expected a loadRange");
  const slice = sliceTranscriptRange(
    projectTranscriptRows(input),
    buildTranscriptRecordLookup(input.messages, input.events),
    {
      fromOrdinal: request.fromOrdinal,
      toOrdinal: request.toOrdinal,
      maxBytes: request.maxBytes,
    },
    null,
  );
  session.callbacks().onRange({
    kind: "range",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    range: {
      requestId: request.requestId,
      epoch: request.epoch,
      fromOrdinal: slice.fromOrdinal,
      rowIds: [...slice.rowIds],
      incompleteRowIds: [...slice.incompleteRowIds],
      messages: [...slice.messages],
      events: [...slice.events],
      rowContext: { ...slice.rowContext },
      reachedStart: slice.reachedStart,
      reachedEnd: slice.reachedEnd,
    },
  });
}

/** A user row's skeleton entry, as the host builds one for a member's post. */
export function userSkeletonEntry(
  rowId: string,
  createdAt: number,
): RowSkeletonEntry {
  return {
    rowId,
    createdAt,
    role: "user",
    byteLength: 64,
    bodyDigest: `digest-${rowId}`,
  };
}

/** A paragraph of `text`. */
export function paragraph(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
