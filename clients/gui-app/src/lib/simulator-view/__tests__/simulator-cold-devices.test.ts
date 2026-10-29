import { describe, expect, it } from "vitest";
import type {
  SimulatorHostInstance,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import { coldSimulatorDevices } from "@/lib/simulator-view/simulator-cold-devices";

/**
 * The join between a device row and the instance read, which is where the
 * two-platform id rule lives: an iOS udid is the device's id and its
 * instance's key at once, where an Android device is listed under its AVD
 * name while cold and under its emulator's serial while it runs, and only the
 * instance read names both of those together.
 */

const IOS_RUNNING: SimulatorSummary = {
  simulatorId: "udid-1",
  platform: "ios",
  name: "iPhone 17",
  version: "26.0",
  booted: true,
  physical: false,
};
const IOS_COLD: SimulatorSummary = {
  simulatorId: "udid-cold",
  platform: "ios",
  name: "iPad Air",
  version: "26.0",
  booted: false,
  physical: false,
};
/** Listed under the serial its emulator took, which is what booted means here. */
const ANDROID_RUNNING: SimulatorSummary = {
  simulatorId: "emulator-5554",
  platform: "android",
  name: "Pixel_8_API_35",
  version: "Android 15.0",
  booted: true,
  physical: false,
};
const ANDROID_COLD: SimulatorSummary = {
  simulatorId: "Pixel_9_API_36",
  platform: "android",
  name: "Pixel_9_API_36",
  version: "Android 16.0",
  booted: false,
  physical: false,
};
const PHONE: SimulatorSummary = {
  simulatorId: "serial-phone",
  platform: "android",
  name: "Pixel 9",
  version: "Android 16.0",
  booted: false,
  physical: true,
};

const DEVICES: readonly SimulatorSummary[] = [
  IOS_RUNNING,
  IOS_COLD,
  ANDROID_RUNNING,
  ANDROID_COLD,
  PHONE,
];

const INSTANCE: SimulatorHostInstance = {
  instanceKey: "udid-1",
  simulatorId: "udid-1",
  platform: "ios",
  name: "iPhone 17",
  version: "26.0",
  booted: true,
  cloneOf: null,
  cloneOfName: null,
  drivenByAgent: false,
  keepRunning: false,
  bootedByTraycer: true,
  idleUntil: null,
  tasks: [],
  otherTaskCount: 0,
};
/** Keyed by its AVD name, reached by its serial: the two are not one string. */
const ANDROID_OWN: SimulatorHostInstance = {
  ...INSTANCE,
  instanceKey: "Pixel_8_API_35",
  simulatorId: "emulator-5554",
  platform: "android",
  name: "Pixel_8_API_35",
  version: "Android 15.0",
};
const ANDROID_CLONE: SimulatorHostInstance = {
  ...ANDROID_OWN,
  instanceKey: "Pixel_8_API_35_traycer_2",
  simulatorId: "emulator-5556",
  name: "Pixel_8_API_35 · 2",
  cloneOf: "Pixel_8_API_35",
  cloneOfName: "Pixel_8_API_35",
};

function coldIds(
  instances: readonly SimulatorHostInstance[] | null,
): readonly string[] {
  return coldSimulatorDevices({ simulators: DEVICES, instances }).map(
    (simulator) => simulator.simulatorId,
  );
}

describe("coldSimulatorDevices", () => {
  it("leaves out every device the read reaches, by its instance's key or by the serial that instance runs on", () => {
    // The iOS device is reached by the udid both rows carry; the Android one
    // only by the instance's `simulatorId`, since its row is a serial no
    // instance key equals. The physical phone is never a Boot row, and the
    // clone's own serial belongs to no device row.
    expect(coldIds([INSTANCE, ANDROID_OWN, ANDROID_CLONE])).toEqual([
      "udid-cold",
      "Pixel_9_API_36",
    ]);
  });

  it("takes a device the read does not reach, however its row still calls it booted, and a copy of it running is not it", () => {
    // The Android device powered off - its idle deadline, another window -
    // and the device list has not caught up. A copy of it is still running,
    // which says nothing about the device itself: a device can be cold and
    // bootable while a copy of it runs.
    expect(coldIds([INSTANCE, ANDROID_CLONE])).toEqual([
      "udid-cold",
      "emulator-5554",
      "Pixel_9_API_36",
    ]);
  });

  it("leaves the device list's own flag deciding while there is no read to go on", () => {
    // A `@1.0` host, which has no instances, or a `@1.1` one that still owes
    // or failed its answer. Reading that as "nothing is running" would offer
    // Boot on both devices that are up.
    expect(coldIds(null)).toEqual(["udid-cold", "Pixel_9_API_36"]);
  });
});
