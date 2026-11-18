/**
 * Schema + factory for the `simulator` tile: one iOS Simulator or Android
 * Emulator on one host, viewed live.
 *
 * Follows the `browser-session` precedent: non-record-backed and bound to the
 * host that supervises the simulator. `parse` RECOMPUTES the tile `id` from
 * the persisted host and simulator rather than trusting the stored value, so
 * dedup is self-healing with no migration step.
 */
import { v4 as uuidv4 } from "uuid";
import {
  SIMULATOR_PLATFORMS,
  type SimulatorPlatform,
} from "@traycer/protocol/host/simulator/schemas";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { TILE_KIND_SIMULATOR } from "../tile-kinds";
import type { SimulatorTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

/** The label a tile falls back to when the host has not named the simulator. */
export const SIMULATOR_TILE_FALLBACK_NAME = "Simulator";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSimulatorPlatform(value: unknown): value is SimulatorPlatform {
  return (
    typeof value === "string" &&
    SIMULATOR_PLATFORMS.some((platform) => platform === value)
  );
}

/**
 * The tile's canvas node id, derived from the host and the simulator it
 * shows. Shared so a lookup by id (the sidebar's reveal, dedup on open)
 * cannot drift from what open does.
 */
export function simulatorTileId(args: {
  readonly hostId: string;
  readonly simulatorId: string;
}): string {
  return `${TILE_KIND_SIMULATOR}:${args.hostId}:${args.simulatorId}`;
}

export function makeSimulatorTileRef(args: {
  readonly hostId: string;
  readonly simulatorId: string;
  readonly platform: SimulatorPlatform;
  readonly name: string;
  /**
   * The instance `simulatorId` is the id of, from the same answer or session
   * that named it. Null when the caller has only a device row to go on.
   */
  readonly instanceKey: string | null;
}): SimulatorTileRef {
  return {
    id: simulatorTileId(args),
    instanceId: uuidv4(),
    type: TILE_KIND_SIMULATOR,
    name: args.name.length > 0 ? args.name : SIMULATOR_TILE_FALLBACK_NAME,
    hostId: args.hostId,
    simulatorId: args.simulatorId,
    platform: args.platform,
    instanceKey: args.instanceKey,
  };
}

function parseSimulatorTileRef(value: unknown): SimulatorTileRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== TILE_KIND_SIMULATOR ||
    typeof value.hostId !== "string" ||
    value.hostId.length === 0 ||
    typeof value.simulatorId !== "string" ||
    value.simulatorId.length === 0 ||
    !isSimulatorPlatform(value.platform)
  ) {
    return null;
  }
  return {
    id: simulatorTileId({
      hostId: value.hostId,
      simulatorId: value.simulatorId,
    }),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_SIMULATOR,
    name:
      typeof value.name === "string" && value.name.length > 0
        ? value.name
        : SIMULATOR_TILE_FALLBACK_NAME,
    hostId: value.hostId,
    simulatorId: value.simulatorId,
    platform: value.platform,
    // Absent from every tile stored before the field, which then resolves
    // exactly as it did: by its id, and for an Android serial by AVD name.
    instanceKey:
      typeof value.instanceKey === "string" && value.instanceKey.length > 0
        ? value.instanceKey
        : null,
  };
}

function serializeSimulatorTileRef(ref: SimulatorTileRef): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    simulatorId: ref.simulatorId,
    platform: ref.platform,
    instanceKey: ref.instanceKey,
  };
}

export const simulatorTileSchema: TileSchema<SimulatorTileRef> = {
  parse: parseSimulatorTileRef,
  serialize: serializeSimulatorTileRef,
  isRecordBacked: false,
};
