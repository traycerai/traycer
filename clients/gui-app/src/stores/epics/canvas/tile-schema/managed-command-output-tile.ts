/**
 * Schema + factory for managed-command output windows.
 *
 * The persisted tile is a pointer: the command id (as the tile's content id,
 * which is what makes "open again focuses the existing window" fall out of the
 * canvas's own dedup) plus the host that owns it. Nothing about the command
 * itself is written down - kind, description and status are live state served
 * by `managedCommand.subscribeList`, and a window rehydrated days later has to
 * read them fresh rather than replay a snapshot from disk.
 */
import { v4 as uuidv4 } from "uuid";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { TILE_KIND_MANAGED_COMMAND_OUTPUT } from "../tile-kinds";
import type { ManagedCommandOutputTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

/**
 * Tab label before the list stream answers. Kind-free on purpose: the kind is
 * not knowable from the tile, and guessing one would be the state creep this
 * shape exists to prevent. `useEpicTabDisplayTitle` replaces it with the
 * kind-explicit live title as soon as the command's record lands.
 */
export const MANAGED_COMMAND_OUTPUT_TILE_NAME = "Output";

export function makeManagedCommandOutputTileRef(args: {
  readonly commandId: string;
  readonly hostId: string;
}): ManagedCommandOutputTileRef {
  return {
    id: args.commandId,
    instanceId: uuidv4(),
    type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
    name: MANAGED_COMMAND_OUTPUT_TILE_NAME,
    hostId: args.hostId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseManagedCommandOutputTileRef(
  value: unknown,
): ManagedCommandOutputTileRef | null {
  if (!isRecord(value)) return null;
  if (value.type !== TILE_KIND_MANAGED_COMMAND_OUTPUT) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  // A window with no host cannot resolve a stream; there is no sensible
  // default host to fall back to (tabs are bound for life).
  if (typeof value.hostId !== "string" || value.hostId.length === 0) {
    return null;
  }
  return {
    id: value.id,
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
    name: MANAGED_COMMAND_OUTPUT_TILE_NAME,
    hostId: value.hostId,
  };
}

function serializeManagedCommandOutputTileRef(
  ref: ManagedCommandOutputTileRef,
): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    hostId: ref.hostId,
  };
}

export const managedCommandOutputTileSchema: TileSchema<ManagedCommandOutputTileRef> =
  {
    parse: parseManagedCommandOutputTileRef,
    serialize: serializeManagedCommandOutputTileRef,
    isRecordBacked: false,
  };
