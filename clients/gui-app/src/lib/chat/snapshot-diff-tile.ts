import { v4 as uuidv4 } from "uuid";
import { getBasename } from "@/lib/path/cross-platform-path";
import { createDiffTileViewState } from "@/lib/diff/diff-tile-view-state";
import type { SnapshotSourceBlockIds } from "@/lib/chat/snapshot-source-block-ids";
import { TILE_KIND_SNAPSHOT_DIFF } from "@/stores/epics/canvas/tile-kinds";
import type {
  SnapshotDiffTilePayload,
  SnapshotDiffTileRef,
} from "@/stores/epics/canvas/types";

export function snapshotDiffTileId(
  hostId: string,
  payload: SnapshotDiffTilePayload,
): string {
  const target = snapshotDiffTileIdTarget(payload);
  return `${TILE_KIND_SNAPSHOT_DIFF}:${encodeURIComponent(hostId)}:${target}`;
}

function snapshotDiffTileIdTarget(payload: SnapshotDiffTilePayload): string {
  switch (payload.kind) {
    case "snapshot-segment":
      return `segment:${encodeURIComponent(payload.chatId)}:${payload.sourceBlockIds.map(encodeURIComponent).join(":")}`;
    case "snapshot-cumulative":
      return `cumulative:${encodeURIComponent(payload.chatId)}:${encodeURIComponent(payload.filePath)}`;
    case "snapshot-cumulative-bundle": {
      const filePaths = normalizeSnapshotBundleFilePaths(payload.filePaths);
      return `bundle:${encodeURIComponent(payload.chatId)}:${filePaths.map(encodeURIComponent).join(":")}`;
    }
    case "snapshot-hash": {
      // Identity is the before/after hash pair within the chat - NOT the
      // filePath. The card passes "index.md" and the change row passes the
      // absolute path for the same edit; keying on the hashes makes both open
      // (and dedupe to) one tile. If BOTH hashes are absent (a degenerate,
      // UI-unreachable case - the open affordance is gated on a renderable
      // diff), fall back to the filePath so distinct artifacts don't collide
      // into a single `hash:<chat>::` tile.
      const before = payload.beforeHash ?? "";
      const after = payload.afterHash ?? "";
      const key =
        before === "" && after === ""
          ? `path:${encodeURIComponent(payload.filePath)}`
          : `${encodeURIComponent(before)}:${encodeURIComponent(after)}`;
      return `hash:${encodeURIComponent(payload.chatId)}:${key}`;
    }
  }
}

/**
 * Tile for a single chat tool-call edit. `sourceBlockIds` names the host
 * file_change blocks that contributed to the row; the renderer re-reads
 * before->after from the chat session. `hostId` binds the tile to the chat's
 * host for life.
 */
export function makeSnapshotSegmentDiffTile(args: {
  readonly hostId: string;
  readonly chatId: string;
  readonly sourceBlockIds: SnapshotSourceBlockIds;
  readonly filePath: string;
}): SnapshotDiffTileRef {
  const diff: SnapshotDiffTilePayload = {
    kind: "snapshot-segment",
    chatId: args.chatId,
    sourceBlockIds: args.sourceBlockIds,
    filePath: args.filePath,
  };
  return {
    id: snapshotDiffTileId(args.hostId, diff),
    instanceId: uuidv4(),
    type: TILE_KIND_SNAPSHOT_DIFF,
    name: `${getBasename(args.filePath)} · edit`,
    hostId: args.hostId,
    diff,
    view: createDiffTileViewState(),
  };
}

/** Tile for a chat-level cumulative file change (first snapshot -> current). */
export function makeSnapshotCumulativeDiffTile(args: {
  readonly hostId: string;
  readonly chatId: string;
  readonly filePath: string;
}): SnapshotDiffTileRef {
  const diff: SnapshotDiffTilePayload = {
    kind: "snapshot-cumulative",
    chatId: args.chatId,
    filePath: args.filePath,
  };
  return {
    id: snapshotDiffTileId(args.hostId, diff),
    instanceId: uuidv4(),
    type: TILE_KIND_SNAPSHOT_DIFF,
    name: `${getBasename(args.filePath)} · changes`,
    hostId: args.hostId,
    diff,
    view: createDiffTileViewState(),
  };
}

/** Tile for the accumulated-changes panel as one multi-file snapshot diff. */
export function makeSnapshotCumulativeBundleDiffTile(args: {
  readonly hostId: string;
  readonly chatId: string;
  readonly filePaths: ReadonlyArray<string>;
}): SnapshotDiffTileRef {
  const filePaths = normalizeSnapshotBundleFilePaths(args.filePaths);
  const diff: SnapshotDiffTilePayload = {
    kind: "snapshot-cumulative-bundle",
    chatId: args.chatId,
    filePaths,
  };
  return {
    id: snapshotDiffTileId(args.hostId, diff),
    instanceId: uuidv4(),
    type: TILE_KIND_SNAPSHOT_DIFF,
    name: `${filePaths.length} ${filePaths.length === 1 ? "file" : "files"} changed`,
    hostId: args.hostId,
    diff,
    view: createDiffTileViewState(),
  };
}

/**
 * Tile for an artifact `index.md` edit, addressed by its before/after content
 * hashes. Unlike the segment tile, this carries the hashes inline (artifacts
 * have no `file_change` block to resolve them from), so the renderer fetches the
 * content by hash directly. `title` becomes the tab name (the artifact's title
 * reads far better than the `index.md` basename).
 */
export function makeSnapshotHashDiffTile(args: {
  readonly hostId: string;
  readonly chatId: string;
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly title: string | null;
}): SnapshotDiffTileRef {
  const diff: SnapshotDiffTilePayload = {
    kind: "snapshot-hash",
    chatId: args.chatId,
    filePath: args.filePath,
    beforeHash: args.beforeHash,
    afterHash: args.afterHash,
    title: args.title,
  };
  const name =
    args.title !== null && args.title.length > 0
      ? args.title
      : getBasename(args.filePath);
  return {
    id: snapshotDiffTileId(args.hostId, diff),
    instanceId: uuidv4(),
    type: TILE_KIND_SNAPSHOT_DIFF,
    name: `${name} · diff`,
    hostId: args.hostId,
    diff,
    view: createDiffTileViewState(),
  };
}

export function normalizeSnapshotBundleFilePaths(
  filePaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return Array.from(new Set(filePaths)).toSorted((a, b) => a.localeCompare(b));
}
