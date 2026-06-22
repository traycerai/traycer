/**
 * Schema for chat snapshot diff tiles. Snapshot payloads are chat-owned:
 * they reference file_change blocks or accumulated file paths by chat id,
 * then re-read before/after content from the chat session at render time.
 */
import type { DesktopJsonValue } from "@/lib/windows/types";
import {
  normalizeSnapshotBundleFilePaths,
  snapshotDiffTileId,
} from "@/lib/chat/snapshot-diff-tile";
import { readSnapshotSourceBlockIds } from "@/lib/chat/snapshot-source-block-ids";
import { TILE_KIND_SNAPSHOT_DIFF } from "../tile-kinds";
import type { SnapshotDiffTilePayload, SnapshotDiffTileRef } from "../types";
import type { TileSchema } from "./index";
import {
  parseDiffTileViewState,
  readStringArray,
  serializeDiffTileViewState,
} from "./diff-tile-view";
import { readTileInstanceId } from "./instance-id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSnapshotDiffPayload(
  value: unknown,
): SnapshotDiffTilePayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.chatId !== "string") return null;
  if (value.kind === "snapshot-cumulative-bundle") {
    const filePaths = normalizeSnapshotBundleFilePaths(
      readStringArray(value.filePaths),
    );
    if (filePaths.length === 0) return null;
    return {
      kind: "snapshot-cumulative-bundle",
      chatId: value.chatId,
      filePaths,
    };
  }
  if (typeof value.filePath !== "string") return null;
  if (value.kind === "snapshot-cumulative") {
    return {
      kind: "snapshot-cumulative",
      chatId: value.chatId,
      filePath: value.filePath,
    };
  }
  if (value.kind === "snapshot-hash") {
    return {
      kind: "snapshot-hash",
      chatId: value.chatId,
      filePath: value.filePath,
      beforeHash:
        typeof value.beforeHash === "string" ? value.beforeHash : null,
      afterHash: typeof value.afterHash === "string" ? value.afterHash : null,
      title: typeof value.title === "string" ? value.title : null,
    };
  }
  if (value.kind !== "snapshot-segment") return null;
  const sourceBlockIds = readSnapshotSourceBlockIds(value.sourceBlockIds);
  if (sourceBlockIds === null) return null;
  return {
    kind: "snapshot-segment",
    chatId: value.chatId,
    sourceBlockIds,
    filePath: value.filePath,
  };
}

function parseSnapshotDiffTileRef(value: unknown): SnapshotDiffTileRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== TILE_KIND_SNAPSHOT_DIFF ||
    typeof value.name !== "string" ||
    typeof value.hostId !== "string"
  ) {
    return null;
  }
  const diff = parseSnapshotDiffPayload(value.diff);
  const view = parseDiffTileViewState(value.view);
  if (diff === null || view === null) return null;
  return {
    id: snapshotDiffTileId(value.hostId, diff),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_SNAPSHOT_DIFF,
    name: value.name,
    hostId: value.hostId,
    diff,
    view,
  };
}

function serializeSnapshotDiffPayload(
  diff: SnapshotDiffTileRef["diff"],
): DesktopJsonValue {
  switch (diff.kind) {
    case "snapshot-segment":
      return {
        kind: diff.kind,
        chatId: diff.chatId,
        sourceBlockIds: [...diff.sourceBlockIds],
        filePath: diff.filePath,
      };
    case "snapshot-cumulative":
      return {
        kind: diff.kind,
        chatId: diff.chatId,
        filePath: diff.filePath,
      };
    case "snapshot-cumulative-bundle":
      return {
        kind: diff.kind,
        chatId: diff.chatId,
        filePaths: [...diff.filePaths],
      };
    case "snapshot-hash":
      return {
        kind: diff.kind,
        chatId: diff.chatId,
        filePath: diff.filePath,
        beforeHash: diff.beforeHash,
        afterHash: diff.afterHash,
        title: diff.title,
      };
  }
}

function serializeSnapshotDiffTileRef(
  ref: SnapshotDiffTileRef,
): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    diff: serializeSnapshotDiffPayload(ref.diff),
    view: serializeDiffTileViewState(ref.view),
  };
}

export const snapshotDiffTileSchema: TileSchema<SnapshotDiffTileRef> = {
  parse: parseSnapshotDiffTileRef,
  serialize: serializeSnapshotDiffTileRef,
  isRecordBacked: false,
};
