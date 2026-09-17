import { v4 as uuidv4 } from "uuid";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { TILE_KIND_DELETED_ARTIFACTS } from "../tile-kinds";
import type { DeletedArtifactsTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export const DELETED_ARTIFACTS_TILE_NAME = "Deleted artifacts";

export function deletedArtifactsTileId(epicId: string, hostId: string): string {
  return `deleted-artifacts:${encodeURIComponent(hostId)}:${encodeURIComponent(epicId)}`;
}

export function makeDeletedArtifactsTileRef(
  epicId: string,
  hostId: string,
): DeletedArtifactsTileRef {
  return {
    id: deletedArtifactsTileId(epicId, hostId),
    instanceId: uuidv4(),
    type: TILE_KIND_DELETED_ARTIFACTS,
    name: DELETED_ARTIFACTS_TILE_NAME,
    hostId,
    epicId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDeletedArtifactsTileRef(
  value: unknown,
): DeletedArtifactsTileRef | null {
  if (!isRecord(value)) return null;
  if (value.type !== TILE_KIND_DELETED_ARTIFACTS) return null;
  if (typeof value.epicId !== "string" || value.epicId.length === 0) {
    return null;
  }
  if (typeof value.hostId !== "string" || value.hostId.length === 0) {
    return null;
  }
  return {
    id: deletedArtifactsTileId(value.epicId, value.hostId),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_DELETED_ARTIFACTS,
    name:
      typeof value.name === "string" ? value.name : DELETED_ARTIFACTS_TILE_NAME,
    hostId: value.hostId,
    epicId: value.epicId,
  };
}

function serializeDeletedArtifactsTileRef(
  ref: DeletedArtifactsTileRef,
): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    epicId: ref.epicId,
  };
}

export const deletedArtifactsTileSchema: TileSchema<DeletedArtifactsTileRef> = {
  parse: parseDeletedArtifactsTileRef,
  serialize: serializeDeletedArtifactsTileRef,
  isRecordBacked: false,
};
