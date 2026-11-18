/**
 * Schema + factory for `blank` tiles (the "New tab" opener placeholder). A
 * blank tile carries only the common ref fields; its body renders the inline
 * opener. `makeBlankTileRef` mints fresh ids; `parse` rehydrates a persisted
 * blank as a blank (fresh content id, preserved instanceId when present).
 */
import { v4 as uuidv4 } from "uuid";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { TILE_KIND_BLANK } from "../tile-kinds";
import type { BlankTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export const BLANK_TILE_NAME = "New tab";

/**
 * Build a fresh blank tile ref. `hostId` is a placeholder - the inline opener
 * binds the real default host when content is created; the blank body never
 * reads a per-tab host.
 */
export function makeBlankTileRef(): BlankTileRef {
  return {
    id: uuidv4(),
    instanceId: uuidv4(),
    type: TILE_KIND_BLANK,
    name: BLANK_TILE_NAME,
    hostId: UNKNOWN_HOST_PLACEHOLDER,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBlankTileRef(value: unknown): BlankTileRef | null {
  if (!isRecord(value)) return null;
  if (value.type !== TILE_KIND_BLANK) return null;
  return {
    id:
      typeof value.id === "string" && value.id.length > 0 ? value.id : uuidv4(),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_BLANK,
    name: BLANK_TILE_NAME,
    hostId:
      typeof value.hostId === "string" && value.hostId.length > 0
        ? value.hostId
        : UNKNOWN_HOST_PLACEHOLDER,
  };
}

function serializeBlankTileRef(ref: BlankTileRef): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
  };
}

export const blankTileSchema: TileSchema<BlankTileRef> = {
  parse: parseBlankTileRef,
  serialize: serializeBlankTileRef,
  isRecordBacked: false,
};
