/**
 * Schema + factory for the `epic-file` tile (one file on the epic's file
 * plane).
 *
 * Follows the `comm-graph` / `git-diff` precedent in two ways. `parse`
 * RECOMPUTES the tile `id` from the persisted payload rather than trusting the
 * stored one, so dedupe is self-healing with no migration step; and it
 * recomputes `name` from the path, so a persisted label can never disagree
 * with the file it labels.
 *
 * The persisted payload carries `(epicId, path)` and nothing else about the
 * file. Sha, media type, size, status and tombstone are read live from the
 * `files` manifest at render time (D02), which is what makes a re-capture at
 * the same path - or an upload finishing, or a restore - move an already-open
 * tile instead of leaving it pointed at bytes that have moved on.
 *
 * `path` is validated with `isEpicFilePath`, the same predicate the manifest
 * writer and the RPC wire use: a stored value that could never have keyed the
 * manifest (a traversal, an absolute path, the `.file-staging/` sibling) drops
 * the tile rather than rehydrating a tile that can only ever render an error.
 */
import { v4 as uuidv4 } from "uuid";
import { isEpicFilePath } from "@traycer/protocol/persistence/epic/files";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { TILE_KIND_EPIC_FILE } from "../tile-kinds";
import type { EpicFileTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

/**
 * The tab label: the path's last segment. Manifest paths are POSIX and always
 * carry the `files/` prefix, so there is always a segment to take.
 */
export function epicFileTileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The tile's canvas node id. Shared so a lookup by id cannot drift from open. */
export function epicFileTileId(args: {
  readonly epicId: string;
  readonly path: string;
}): string {
  return `${TILE_KIND_EPIC_FILE}:${args.epicId}:${args.path}`;
}

export function makeEpicFileTileRef(args: {
  readonly hostId: string;
  readonly epicId: string;
  readonly path: string;
}): EpicFileTileRef {
  return {
    id: epicFileTileId(args),
    instanceId: uuidv4(),
    type: TILE_KIND_EPIC_FILE,
    name: epicFileTileName(args.path),
    hostId: args.hostId,
    epicId: args.epicId,
    path: args.path,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEpicFileTileRef(value: unknown): EpicFileTileRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== TILE_KIND_EPIC_FILE ||
    typeof value.hostId !== "string" ||
    typeof value.epicId !== "string" ||
    value.epicId.length === 0 ||
    typeof value.path !== "string" ||
    !isEpicFilePath(value.path)
  ) {
    return null;
  }
  return {
    id: epicFileTileId({ epicId: value.epicId, path: value.path }),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_EPIC_FILE,
    name: epicFileTileName(value.path),
    hostId: value.hostId,
    epicId: value.epicId,
    path: value.path,
  };
}

function serializeEpicFileTileRef(ref: EpicFileTileRef): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    epicId: ref.epicId,
    path: ref.path,
  };
}

export const epicFileTileSchema: TileSchema<EpicFileTileRef> = {
  parse: parseEpicFileTileRef,
  serialize: serializeEpicFileTileRef,
  isRecordBacked: false,
};
