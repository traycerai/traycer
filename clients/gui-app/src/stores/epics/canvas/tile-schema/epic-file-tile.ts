/**
 * Schema + factory for epic-file tiles. The persisted tile is a pointer (path,
 * sha, the row it came from, the host that serves it) plus the title it was
 * opened under; the bytes are read fresh by sha every time it mounts.
 */
import { v4 as uuidv4 } from "uuid";
import type { EpicFileVia } from "@traycer/protocol/host/epic/files";
import {
  EPIC_FILE_SHA256_PATTERN,
  isEpicFilePath,
} from "@traycer/protocol/persistence/epic/files";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { TILE_KIND_EPIC_FILE } from "../tile-kinds";
import type { EpicFileTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export function makeEpicFileTileRef(args: {
  readonly path: string;
  readonly sha256: string;
  readonly name: string;
  readonly hostId: string;
  readonly via: EpicFileVia | null;
}): EpicFileTileRef {
  return {
    id: args.path,
    instanceId: uuidv4(),
    type: TILE_KIND_EPIC_FILE,
    name: args.name,
    hostId: args.hostId,
    path: args.path,
    sha256: args.sha256,
    via: args.via,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * `null` is a real answer (a file opened from no row); anything else that is
 * not a whole via is a damaged tile, never quietly a via-less one - the host
 * would then decide the page's network policy without the row it came from.
 */
function parseVia(
  value: unknown,
): { readonly via: EpicFileVia | null } | "malformed" {
  if (value === null) return { via: null };
  if (!isRecord(value)) return "malformed";
  if (!isNonEmptyString(value.chatId) || !isNonEmptyString(value.blockId)) {
    return "malformed";
  }
  return { via: { chatId: value.chatId, blockId: value.blockId } };
}

function parseEpicFileTileRef(value: unknown): EpicFileTileRef | null {
  if (!isRecord(value)) return null;
  if (value.type !== TILE_KIND_EPIC_FILE) return null;
  // A tile with no host cannot read its bytes, and tabs are bound for life,
  // so there is no host to fall back to.
  if (!isNonEmptyString(value.hostId)) return null;
  if (
    typeof value.path !== "string" ||
    !isEpicFilePath(value.path) ||
    typeof value.sha256 !== "string" ||
    !EPIC_FILE_SHA256_PATTERN.test(value.sha256)
  ) {
    return null;
  }
  const via = parseVia(value.via);
  if (via === "malformed") return null;
  return {
    id: value.path,
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_EPIC_FILE,
    name: isNonEmptyString(value.name) ? value.name : value.path,
    hostId: value.hostId,
    path: value.path,
    sha256: value.sha256,
    via: via.via,
  };
}

function serializeEpicFileTileRef(ref: EpicFileTileRef): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    path: ref.path,
    sha256: ref.sha256,
    via: ref.via === null ? null : { ...ref.via },
  };
}

export const epicFileTileSchema: TileSchema<EpicFileTileRef> = {
  parse: parseEpicFileTileRef,
  serialize: serializeEpicFileTileRef,
  isRecordBacked: false,
};
