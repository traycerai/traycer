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
 * contents by hash. Returns `null` when the source blocks are gone.
 */
export function resolveSnapshotSegmentHashes(
  payload: SnapshotSegmentDiffTilePayload,
  source: SnapshotDiffSource,
): ResolvedSnapshotSegmentHashes | null {
  const blocks = fileChangeBlocksById(source);
  const first = blocks.get(firstSnapshotSourceBlockId(payload.sourceBlockIds));
  const last = blocks.get(lastSnapshotSourceBlockId(payload.sourceBlockIds));
  if (first === undefined || last === undefined) return null;
  return {
    filePath: last.filePath,
    beforeHash: first.beforeHash,
    afterHash: last.afterHash,
  };
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
    SnapshotCumulativeDiffTilePayload | SnapshotCumulativeBundleDiffTilePayload,
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
