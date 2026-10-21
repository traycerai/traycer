import { describe, expect, it } from "vitest";
import type { SimulatorSummary } from "@traycer/protocol/host/simulator/schemas";
import { findSimulatorForTile } from "@/lib/simulator-view/simulator-tile-target";

const COLD_AVD: SimulatorSummary = {
  simulatorId: "Pixel_8_API_35",
  platform: "android",
  name: "Pixel_8_API_35",
  version: "Android",
  booted: false,
  physical: false,
};
const BOOTED_EMULATOR: SimulatorSummary = {
  simulatorId: "emulator-5554",
  platform: "android",
  name: "Pixel_8_API_35",
  version: "Android 15.0",
  booted: true,
  physical: false,
};
const IPHONE: SimulatorSummary = {
  simulatorId: "udid-1",
  platform: "ios",
  name: "iPhone 16",
  version: "18.0",
  booted: false,
  physical: false,
};

describe("findSimulatorForTile", () => {
  it("matches by id first, and an Android serial's tile by AVD name once the serial is gone", () => {
    const serialTile = {
      simulatorId: "emulator-5554",
      platform: "android",
      name: "Pixel_8_API_35",
    } as const;
    expect(findSimulatorForTile([COLD_AVD, BOOTED_EMULATOR], serialTile)).toBe(
      BOOTED_EMULATOR,
    );
    // Powered off: the host lists the AVD cold under its name.
    expect(findSimulatorForTile([IPHONE, COLD_AVD], serialTile)).toBe(COLD_AVD);
    // Booted again elsewhere under a new serial: that row, to connect to.
    const rebooted = { ...BOOTED_EMULATOR, simulatorId: "emulator-5556" };
    expect(findSimulatorForTile([rebooted], serialTile)).toBe(rebooted);
    expect(findSimulatorForTile([IPHONE], serialTile)).toBeNull();
  });

  it("never matches an iOS tile by name: a udid is for life", () => {
    const tile = {
      simulatorId: "udid-gone",
      platform: "ios",
      name: "iPhone 16",
    } as const;
    expect(findSimulatorForTile([IPHONE], tile)).toBeNull();
  });
});
