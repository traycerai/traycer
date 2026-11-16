import { describe, expect, it } from "vitest";
import type {
  SimulatorPackState,
  SimulatorPlatformAvailability,
  SimulatorStatusResponse,
} from "@traycer/protocol/host/simulator/schemas";
import {
  simulatorSetupPlatforms,
  simulatorSetupPromptContent,
} from "@/lib/simulator-view/simulator-setup-agent";

const UNSUPPORTED: SimulatorPackState = {
  kind: "unsupported",
  reason: "No platform can run here.",
  progress: null,
};
const OFF: SimulatorPackState = { kind: "off", reason: null, progress: null };

function statusOf(
  packState: SimulatorPackState,
  platforms: readonly SimulatorPlatformAvailability[],
): SimulatorStatusResponse {
  return {
    platforms: [...platforms],
    packState,
    packVersion: null,
    installed: null,
  };
}

const IOS_MISSING: SimulatorPlatformAvailability = {
  platform: "ios",
  available: false,
  reason: "Xcode was not found.",
  setupSupported: true,
};
const ANDROID_MISSING: SimulatorPlatformAvailability = {
  platform: "android",
  available: false,
  reason: "No Android SDK.",
  setupSupported: true,
};

/** Every text node of a tiptap document, in order. */
function textOf(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const record = node as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") return record.text;
  return Array.isArray(record.content)
    ? record.content.map(textOf).join("\n")
    : "";
}

describe("simulatorSetupPlatforms", () => {
  it("lists the missing platforms the host says can be set up, and only those", () => {
    expect(
      simulatorSetupPlatforms(
        statusOf(UNSUPPORTED, [
          IOS_MISSING,
          { ...ANDROID_MISSING, setupSupported: false },
        ]),
      ),
    ).toEqual(["ios"]);
  });

  it("offers nothing to an older host that does not say, nor for a platform that is already available", () => {
    const { setupSupported: _omitted, ...older } = ANDROID_MISSING;
    expect(
      simulatorSetupPlatforms(
        statusOf(OFF, [
          older,
          {
            platform: "ios",
            available: true,
            reason: null,
            setupSupported: true,
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("offers nothing when the pack is unsupported while a platform is available: setup on this machine cannot fix it", () => {
    expect(
      simulatorSetupPlatforms(
        statusOf(UNSUPPORTED, [
          {
            platform: "ios",
            available: true,
            reason: null,
            setupSupported: true,
          },
          ANDROID_MISSING,
        ]),
      ),
    ).toEqual([]);
  });
});

describe("simulatorSetupPromptContent", () => {
  it("names the host and its id, reports every platform, and covers the steps only for the platforms to set up", () => {
    const text = textOf(
      simulatorSetupPromptContent({
        hostId: "host-1",
        hostName: "Studio Mac",
        status: statusOf(UNSUPPORTED, [
          IOS_MISSING,
          { ...ANDROID_MISSING, setupSupported: false },
        ]),
      }),
    );
    expect(text).toContain("Studio Mac");
    expect(text).toContain("host-1");
    expect(text).toContain("Xcode was not found.");
    expect(text).toContain("No Android SDK.");
    // Setup steps only for iOS: no Android install step.
    expect(text).toContain("Xcode from Apple");
    expect(text).not.toContain("Java 17 or later for the SDK tools");
    expect(text).toContain("simulator_request_enable");
  });
});
