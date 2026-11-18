import { describe, expect, it } from "vitest";
import type {
  SimulatorHostInstance,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import {
  fresherSimulatorRead,
  splitSimulatorDevices,
  type FresherSimulatorRead,
} from "@/lib/simulator-view/simulator-device-split";

/**
 * The four states a surface holding both reads meets, and what each shows:
 *
 * - owed, no instance answer at all: the device list's own flag decides both
 *   halves, as it did before there was an instance read;
 * - the instance answer is the OLDER one (a device list asked again after an
 *   open answered since): the flag decides, and a device it calls booted that
 *   the instance answer has not caught up with is a stand-in running row -
 *   never a Boot row, and never nothing at all;
 * - the instance answer is the later one and does not name the device: it
 *   powered off, so the device is a Boot row;
 * - the instance answer is the later one and names it: its instance row runs.
 *
 * Plus the join itself, which is where the two-platform id rule lives: an iOS
 * udid is the device's id and its instance's key at once, where an Android
 * device is listed under its AVD name while cold and under its emulator's
 * serial while it runs, and only the instance read names both together.
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

const IOS_OWN: SimulatorHostInstance = {
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
  ...IOS_OWN,
  instanceKey: "Pixel_8_API_35",
  simulatorId: "emulator-5554",
  platform: "android",
  name: "Pixel_8_API_35",
  version: "Android 15.0",
};
/** A copy of the iPad the device list still calls cold, for the other way round. */
const IOS_COLD_OWN: SimulatorHostInstance = {
  ...IOS_OWN,
  instanceKey: "udid-cold",
  simulatorId: "udid-cold",
  name: "iPad Air",
};
const ANDROID_CLONE: SimulatorHostInstance = {
  ...ANDROID_OWN,
  instanceKey: "Pixel_8_API_35_traycer_2",
  simulatorId: "emulator-5556",
  name: "Pixel_8_API_35 · 2",
  cloneOf: "Pixel_8_API_35",
  cloneOfName: "Pixel_8_API_35",
};

function split(
  instances: readonly SimulatorHostInstance[] | null,
  fresher: FresherSimulatorRead,
): { readonly running: readonly string[]; readonly cold: readonly string[] } {
  const result = splitSimulatorDevices({
    simulators: DEVICES,
    instances,
    fresher,
  });
  return {
    running: result.running.map((copy) =>
      copy.kind === "instance"
        ? `instance:${copy.instance.instanceKey}`
        : `device:${copy.device.simulatorId}`,
    ),
    cold: result.cold.map((device) => device.simulatorId),
  };
}

describe("splitSimulatorDevices", () => {
  it("leaves the device list's own flag deciding both halves while there is no instance answer to go on", () => {
    // A `@1.0` host, which has no instances, or a `@1.1` one that still owes
    // or failed its answer. Every running device stands in for its own copy,
    // and the physical phone is never a Boot row.
    expect(split(null, "instances")).toEqual({
      running: ["device:udid-1", "device:emulator-5554"],
      cold: ["udid-cold", "Pixel_9_API_36"],
    });
  });

  it("reaches a running device by its instance's key or by the serial that instance runs on, once the instance answer is the later one", () => {
    // The iOS device is reached by the udid both rows carry; the Android one
    // only by the instance's `simulatorId`, since its row is a serial no
    // instance key equals. The clone runs under no device row of its own.
    expect(split([IOS_OWN, ANDROID_OWN, ANDROID_CLONE], "instances")).toEqual({
      running: [
        "instance:udid-1",
        "instance:Pixel_8_API_35",
        "instance:Pixel_8_API_35_traycer_2",
      ],
      cold: ["udid-cold", "Pixel_9_API_36"],
    });
  });

  it("offers Boot on a device the later instance answer does not name, and a copy of it running is not it", () => {
    // The Android device powered off - its idle deadline, another window -
    // and the device list has not caught up. A copy of it is still running,
    // which says nothing about the device itself: a device can be cold and
    // bootable while a copy of it runs.
    expect(split([IOS_OWN, ANDROID_CLONE], "instances")).toEqual({
      running: ["instance:udid-1", "instance:Pixel_8_API_35_traycer_2"],
      cold: ["udid-cold", "emulator-5554", "Pixel_9_API_36"],
    });
  });

  it("stands a device in for its own copy when the device list is the later answer and the instance answer predates the boot", () => {
    // The venue: Boot sends an open, the open asks the device list again, and
    // that answer lands between two instance polls. Reading the older
    // instance answer here would offer Boot on a device that is already up -
    // and leaving the flag to the cold half alone would list it in neither.
    expect(split([ANDROID_OWN, ANDROID_CLONE], "devices")).toEqual({
      running: [
        "instance:Pixel_8_API_35",
        "instance:Pixel_8_API_35_traycer_2",
        "device:udid-1",
      ],
      cold: ["udid-cold", "Pixel_9_API_36"],
    });
  });

  it("drops a root copy the later device list says is down, so it is a Boot row and not both", () => {
    // The same freshness the other way: the iPad powered off since the
    // instance answer was taken. Its row cannot stay in the running section
    // while its device is offered Boot. A clone is never dropped this way -
    // no device row speaks for it.
    expect(split([IOS_COLD_OWN, ANDROID_CLONE], "devices")).toEqual({
      running: [
        "instance:Pixel_8_API_35_traycer_2",
        "device:udid-1",
        "device:emulator-5554",
      ],
      cold: ["udid-cold", "Pixel_9_API_36"],
    });
  });
});

describe("fresherSimulatorRead", () => {
  it("names the answer taken later, and the instance read when the two were taken together", () => {
    expect(
      fresherSimulatorRead({ devicesUpdatedAt: 20, instancesUpdatedAt: 10 }),
    ).toBe("devices");
    expect(
      fresherSimulatorRead({ devicesUpdatedAt: 10, instancesUpdatedAt: 20 }),
    ).toBe("instances");
    expect(
      fresherSimulatorRead({ devicesUpdatedAt: 10, instancesUpdatedAt: 10 }),
    ).toBe("instances");
  });
});
