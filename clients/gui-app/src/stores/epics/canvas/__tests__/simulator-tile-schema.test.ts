import { describe, expect, it } from "vitest";
import {
  isTileRefRecordBacked,
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  makeSimulatorTileRef,
  SIMULATOR_TILE_FALLBACK_NAME,
  simulatorTileId,
} from "@/stores/epics/canvas/tile-schema/simulator-tile";
import { TILE_KIND_SIMULATOR } from "@/stores/epics/canvas/tile-kinds";
import { isSimulatorTileRef } from "@/stores/epics/canvas/types";
import { tileCategoryOf } from "@/lib/canvas/tile-open/intent";

const HOST = "host-1";
const UDID = "7B1A2C3D-0000-4000-8000-000000000001";

describe("simulator tile schema", () => {
  it("derives the tile id from the host and the simulator, so reopening dedups", () => {
    const first = makeSimulatorTileRef({
      hostId: HOST,
      simulatorId: UDID,
      platform: "ios",
      name: "iPhone 16",
      instanceKey: null,
    });
    const second = makeSimulatorTileRef({
      hostId: HOST,
      simulatorId: UDID,
      platform: "ios",
      name: "iPhone 16",
      instanceKey: null,
    });
    expect(first.type).toBe(TILE_KIND_SIMULATOR);
    expect(first.id).toBe(simulatorTileId({ hostId: HOST, simulatorId: UDID }));
    expect(first.id).toBe(second.id);
    expect(first.instanceId).not.toBe(second.instanceId);
    expect(
      makeSimulatorTileRef({
        hostId: "host-2",
        simulatorId: UDID,
        platform: "ios",
        name: "iPhone 16",
        instanceKey: null,
      }).id,
    ).not.toBe(first.id);
    expect(isSimulatorTileRef(first)).toBe(true);
    expect(isTileRefRecordBacked(first)).toBe(false);
    expect(tileCategoryOf(first)).toBe("browser");
  });

  it("round-trips through serialize / parse and recomputes a drifted id", () => {
    const ref = makeSimulatorTileRef({
      hostId: HOST,
      simulatorId: "emulator-5554",
      platform: "android",
      name: "Pixel 8",
      instanceKey: "Pixel_8_API_35_traycer_2",
    });
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
    expect(
      parseTileRef({
        id: "simulator:stale",
        instanceId: ref.instanceId,
        type: TILE_KIND_SIMULATOR,
        name: ref.name,
        hostId: HOST,
        simulatorId: "emulator-5554",
        platform: "android",
        instanceKey: ref.instanceKey,
      }),
    ).toEqual(ref);
    // A tile stored before the field names no instance, and resolves by its
    // id alone the way every tile did.
    expect(
      parseTileRef({
        id: ref.id,
        instanceId: ref.instanceId,
        type: TILE_KIND_SIMULATOR,
        name: ref.name,
        hostId: HOST,
        simulatorId: "emulator-5554",
        platform: "android",
      }),
    ).toEqual({ ...ref, instanceKey: null });
  });

  it("refuses a persisted ref whose platform this build does not know, and names an unnamed one", () => {
    expect(
      parseTileRef({
        id: "x",
        instanceId: "inst",
        type: TILE_KIND_SIMULATOR,
        name: "Visor",
        hostId: HOST,
        simulatorId: UDID,
        platform: "visionos",
      }),
    ).toBeNull();
    const parsed = parseTileRef({
      type: TILE_KIND_SIMULATOR,
      hostId: HOST,
      simulatorId: UDID,
      platform: "ios",
    });
    expect(parsed?.name).toBe(SIMULATOR_TILE_FALLBACK_NAME);
    expect(parsed?.instanceId).toEqual(expect.any(String));
  });
});
