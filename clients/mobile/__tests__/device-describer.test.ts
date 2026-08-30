/**
 * What this device calls itself on the approve prompt. iOS is family-only by
 * design — these cases exist to keep an identifier-to-marketing-name table
 * from creeping back in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@capacitor/device";
import { MobileDeviceDescriber } from "../src/device-describer";

const nativeMocks = vi.hoisted(() => ({
  getInfo: vi.fn(),
}));

vi.mock("@capacitor/device", () => ({
  Device: {
    getInfo: nativeMocks.getInfo,
  },
}));

/** A `getInfo()` payload carrying the two fields the describer reads. */
function deviceInfo(
  model: string,
  platform: DeviceInfo["platform"],
): DeviceInfo {
  return {
    model,
    platform,
    operatingSystem: platform === "ios" ? "ios" : "android",
    osVersion: "18.0",
    manufacturer: platform === "ios" ? "Apple" : "Google",
    isVirtual: false,
    webViewVersion: "18.0",
  };
}

function describeWith(model: string, platform: DeviceInfo["platform"]) {
  nativeMocks.getInfo.mockResolvedValue(deviceInfo(model, platform));
  return new MobileDeviceDescriber().describe();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MobileDeviceDescriber", () => {
  it("reports the family for an iOS hardware identifier, not a model name", async () => {
    // Whatever generation these identifiers belong to, the answer is the
    // family - nothing here decodes the digits.
    await expect(describeWith("iPhone17,3", "ios")).resolves.toBe("iPhone");
    await expect(describeWith("iPhone18,1", "ios")).resolves.toBe("iPhone");
    await expect(describeWith("iPad14,1", "ios")).resolves.toBe("iPad");
  });

  it("still says iPhone when iOS reports something that is not a hardware id", async () => {
    // A simulator can answer with its host architecture; the platform is the
    // fallback so the prompt never shows "arm64".
    await expect(describeWith("arm64", "ios")).resolves.toBe("iPhone");
  });

  it("passes an Android model through, since Build.MODEL is already a name", async () => {
    await expect(describeWith("Pixel 8", "android")).resolves.toBe("Pixel 8");
  });

  it("says nothing rather than guessing when the model is empty", async () => {
    await expect(describeWith("", "android")).resolves.toBeNull();
  });

  it("leaves the caller on its fallback when the native call fails", async () => {
    nativeMocks.getInfo.mockRejectedValue(new Error("no such plugin"));
    await expect(new MobileDeviceDescriber().describe()).resolves.toBeNull();
  });
});
