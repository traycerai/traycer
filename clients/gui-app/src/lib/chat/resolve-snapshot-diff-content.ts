import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  SnapshotCumulativeBundleDiffTilePayload,
  SnapshotCumulativeDiffTilePayload,
  SnapshotDiffTilePayload,
  SnapshotSegmentDiffTilePayload,
} from "@/stores/epics/canvas/types";
import {
  firstSnapshotSourceBlockId,
  lastSnapshotSourceBlockId,
} from "@/lib/chat/snapshot-source-block-ids";

type FileChangeBlock = Extract<ContentBlock, { type: "file_change" }>;

export interface ResolvedSnapshotDiff {
  readonly filePath: string;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
}

/**
 * Content-addressed endpoints of a single-edit (`snapshot-segment`) diff. The
 * before/after content is no longer inlined on the block, so the tile lazy-
 * fetches it from these hashes via `snapshots.readSnapshotDiff` (see
 * `useSnapshotDiffQuery`). A `null` hash means that side doesn't exist.
 */
export interface ResolvedSnapshotSegmentHashes {
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

/**
 * Live slice the snapshot-diff tile re-reads from a chat session by `chatId`.
 * `blocks` from `liveAssistantMessage` are appended so an in-flight edit
 * resolves while it streams.
 */
export interface SnapshotDiffSource {
  readonly messages: ReadonlyArray<Message>;
  readonly liveAssistantBlocks: ReadonlyArray<ContentBlock> | null;
  readonly accumulatedFileChanges: ReadonlyArray<ChatAccumulatedFileChange>;
}

export type SnapshotDiffPayload =
  | SnapshotSegmentDiffTilePayload
  | SnapshotCumulativeDiffTilePayload
  | SnapshotCumulativeBundleDiffTilePayload;

/**
 * Resolve a CUMULATIVE snapshot tile's payload to before/after content. The
 * cumulative panel's content is computed host-side (first-snapshot → current
 * on-disk) and delivered on the chat stream, so it is still available inline
 * here. Returns `null` when the file is no longer in the cumulative set
 * (reverted / unchanged) - the renderer then shows a source-unavailable banner.
 */
export function resolveSnapshotDiffContent(
  payload: SnapshotCumulativeDiffTilePayload,
  source: SnapshotDiffSource,
): ResolvedSnapshotDiff | null {
  const change = source.accumulatedFileChanges.find(
    (entry) => entry.filePath === payload.filePath,
  );
  if (change === undefined) return null;
  return {
    filePath: change.filePath,
    beforeContent: change.beforeContent,
    afterContent: change.afterContent,
  };
}

/**
 * Resolve a single-edit (`snapshot-segment`) tile to its content-addressed
 * endpoints. The first source block's `beforeHash` paired with the last
 * source block's `afterHash` reconstructs the exact merged diff (and
 * degenerates to a single block when there's one id). The tile then fetches the
 * contents by hash.
 *
 * The BLOCKS win wherever they resolve, and the tile's captured endpoints are
 * the fallback - not the other way round. The order is what keeps a streaming
 * edit live: `source` includes `liveAssistantBlocks`, so an edit still being
 * written has a moving `afterHash`, and a capture taken at click time would
 * pin the tile to the first frame of it. The capture is for the opposite case,
 * a row too old to be hydrated, where there is nothing moving to miss.
 *
 * `null` only when neither answers: a tile persisted before the capture
 * existed, whose blocks have also left the window.
 */
export function resolveSnapshotSegmentHashes(
  payload: SnapshotSegmentDiffTilePayload,
  source: SnapshotDiffSource,
): ResolvedSnapshotSegmentHashes | null {
  const blocks = fileChangeBlocksById(source);
  const first = blocks.get(firstSnapshotSourceBlockId(payload.sourceBlockIds));
  const last = blocks.get(lastSnapshotSourceBlockId(payload.sourceBlockIds));
  if (first !== undefined && last !== undefined) {
    return {
      filePath: last.filePath,
      beforeHash: first.beforeHash,
      afterHash: last.afterHash,
    };
  }
  // A capture is "both sides recorded", including the legitimate nulls of a
  // creation or a deletion. Two nulls is the shape of an ABSENT capture (the
  // pre-existing tile above), not of an edit, and handing it on would put the
  // tile into a loading state for a fetch that can never return anything.
  if (payload.beforeHash === null && payload.afterHash === null) return null;
  return {
    filePath: payload.filePath,
    beforeHash: payload.beforeHash,
    afterHash: payload.afterHash,
  };
}

/**
 * The endpoints a segment tile's CAPTURE should be rewritten to, or `null`.
 *
 * ## The bug this closes
 *
 * The capture on the payload is taken once, when the tile is opened, and is
 * never rewritten. That is invisible while the source blocks are still in the
 * window, because they win over it - but it is exactly wrong for the case the
 * capture exists to serve. Open a tile on an edit that is still STREAMING and
 * the capture records a half-written `afterHash`; when the row later goes cold
 * and the blocks stop resolving, the tile falls back to that click-time hash
 * and shows a frozen prefix of the edit, permanently, with nothing on screen
 * saying so. The tile's identity excludes the hashes, so reopening the same
 * edit dedupes onto the same node and does not refresh it either.
 *
 * So the capture is refreshed from the blocks while they are still there.
 *
 * ## Settled, and settled means the block says so
 *
 * A half-written edit must not become durable - that would replace a
 * recoverable staleness with a permanent one. The signal is the block's own
 * completion state, never elapsed time: a timer would make durability a race
 * against the harness's write rate, and a slow edit that paused mid-write is
 * indistinguishable from a finished one by clock alone.
 *
 * BOTH endpoints must be settled, not just the moving one. `beforeHash` comes
 * from the first source block and `afterHash` from the last, and those are the
 * two blocks whose hashes are read - so those are the two whose status has to
 * be terminal. `errored`, `interrupted` and `superseded` count as settled
 * alongside `completed`: each is a terminal outcome whose hashes are the final
 * word on that edit, and refusing them would leave precisely the interrupted
 * turns - the ones most likely to be scrolled back to - pinned to their
 * click-time capture forever.
 *
 * `null` means "nothing to write": no live blocks to read, an edit still in
 * flight, or a capture that already says this.
 */
export function settledSnapshotSegmentCapture(
  payload: SnapshotSegmentDiffTilePayload,
  source: SnapshotDiffSource,
): ResolvedSnapshotSegmentHashes | null {
  const blocks = fileChangeBlocksById(source);
  const first = blocks.get(firstSnapshotSourceBlockId(payload.sourceBlockIds));
  const last = blocks.get(lastSnapshotSourceBlockId(payload.sourceBlockIds));
  if (first === undefined || last === undefined) return null;
  if (first.status === "streaming" || last.status === "streaming") return null;
  const settled: ResolvedSnapshotSegmentHashes = {
    filePath: last.filePath,
    beforeHash: first.beforeHash,
    afterHash: last.afterHash,
  };
  const unchanged =
    settled.filePath === payload.filePath &&
    settled.beforeHash === payload.beforeHash &&
    settled.afterHash === payload.afterHash;
  return unchanged ? null : settled;
}

/**
 * Resolve the content-addressed endpoints of whichever diff kind addresses its
 * content by hash: `snapshot-segment` reads first/last `file_change` blocks;
 * `snapshot-hash` carries the hashes inline (artifact edits). The other kinds
 * (cumulative / bundle) resolve content inline and return `null` here.
 */
export function resolveHashBackedEndpoints(
  payload: SnapshotDiffTilePayload,
  source: SnapshotDiffSource,
): ResolvedSnapshotSegmentHashes | null {
  if (payload.kind === "snapshot-hash") {
    return {
      filePath: payload.filePath,
      beforeHash: payload.beforeHash,
      afterHash: payload.afterHash,
    };
  }
  if (payload.kind === "snapshot-segment") {
    return resolveSnapshotSegmentHashes(payload, source);
  }
  return null;
}

export function resolveSnapshotDiffContents(
  payload:
    | SnapshotCumulativeDiffTilePayload
    | SnapshotCumulativeBundleDiffTilePayload,
  source: SnapshotDiffSource,
): ReadonlyArray<ResolvedSnapshotDiff> {
  if (payload.kind === "snapshot-cumulative-bundle") {
    const changesByPath = new Map(
      source.accumulatedFileChanges.map((change) => [change.filePath, change]),
    );
    return payload.filePaths.flatMap((filePath) => {
      const change = changesByPath.get(filePath);
      if (change === undefined) return [];
      return [
        {
          filePath: change.filePath,
          beforeContent: change.beforeContent,
          afterContent: change.afterContent,
        },
      ];
    });
  }

  const resolved = resolveSnapshotDiffContent(payload, source);
  return resolved === null ? [] : [resolved];
}

function fileChangeBlocksById(
  source: SnapshotDiffSource,
): ReadonlyMap<string, FileChangeBlock> {
  const byId = new Map<string, FileChangeBlock>();
  const record = (block: ContentBlock): void => {
    if (block.type === "file_change") byId.set(block.blockId, block);
  };
  for (const message of source.messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) record(block);
  }
  if (source.liveAssistantBlocks !== null) {
    for (const block of source.liveAssistantBlocks) record(block);
  }
  return byId;
}
