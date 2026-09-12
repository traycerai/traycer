import { describe, expect, it } from "vitest";
import {
  BROWSER_DEVICE_PRESET_IDS,
  presetDeviceProfile,
} from "../browser-device-profiles";

/**
 * The module's whole job is turning a device-class id into the three things
 * emulation sends. So the suite checks exactly that, plus the two properties the
 * design depends on: that no profile carries geometry, and that an id this build
 * does not know still answers.
 */
describe("presetDeviceProfile", () => {
  it("answers for every declared class", () => {
    for (const id of BROWSER_DEVICE_PRESET_IDS) {
      const profile = presetDeviceProfile(id);
      expect(Number.isFinite(profile.devicePixelRatio)).toBe(true);
      expect(profile.devicePixelRatio).toBeGreaterThanOrEqual(1);
    }
  });

  it("reports touch and a mobile flag for phones and tablets", () => {
    for (const id of [
      "handset-compact",
      "handset-regular",
      "handset-large",
      "tablet-portrait",
      "tablet-landscape",
    ]) {
      const profile = presetDeviceProfile(id);
      expect(profile.touch).toBe(true);
      expect(profile.mobile).toBe(true);
      // The point of the class: a page that reads the ratio must not get this
      // machine's.
      expect(profile.devicePixelRatio).toBeGreaterThan(1);
    }
  });

  it("reports a fine pointer for laptops and desktops", () => {
    for (const id of ["laptop", "desktop", "desktop-wide"]) {
      const profile = presetDeviceProfile(id);
      expect(profile.touch).toBe(false);
      expect(profile.mobile).toBe(false);
    }
  });

  it("carries no geometry, so the element stays the only authority on size", () => {
    const profile: Record<string, unknown> = {
      ...presetDeviceProfile("handset-regular"),
    };
    // Two authorities on one number is how a page ends up laid out at an
    // override's height inside a shorter box.
    expect(Object.keys(profile).sort()).toEqual([
      "devicePixelRatio",
      "mobile",
      "touch",
    ]);
  });

  it("falls back to a plain desktop for a class this build does not have", () => {
    // A retired class is a real runtime value: the id is persisted, and another
    // build wrote it. Desktop because it emulates least - guessing a ratio and a
    // pointer for an unknown device is worse than leaving the page alone.
    const retired = presetDeviceProfile("handset-from-the-future");
    expect(retired).toEqual(presetDeviceProfile("desktop"));
  });

  it("does not treat a prototype key as a device class", () => {
    // The id crosses IPC as a string, so the lookup must not answer for
    // inherited properties.
    expect(presetDeviceProfile("constructor")).toEqual(
      presetDeviceProfile("desktop"),
    );
    expect(presetDeviceProfile("toString")).toEqual(
      presetDeviceProfile("desktop"),
    );
  });

  it("gives every phone class the same profile while their ids stay distinct", () => {
    // They are allowed to diverge later; today they agree, and the guard that
    // compares profiles rather than ids relies on knowing which it is.
    expect(presetDeviceProfile("handset-compact")).toEqual(
      presetDeviceProfile("handset-large"),
    );
  });
});
