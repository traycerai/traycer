import { beforeEach, describe, expect, it, vi } from "vitest";

const commandLine = vi.hoisted(() => ({
  appendSwitch: vi.fn<(name: string, value: string) => void>(),
}));

vi.mock("electron", () => ({
  app: { commandLine },
  powerMonitor: {},
  session: {},
}));

vi.mock("../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  BACKGROUND_TIMER_THROTTLES,
  trimUnusedChromiumFeatures,
} from "../lifecycle";

describe("trimUnusedChromiumFeatures", () => {
  beforeEach(() => {
    commandLine.appendSwitch.mockClear();
  });

  it("disables the background timer throttles together with the unused features in ONE disable-features switch", () => {
    trimUnusedChromiumFeatures();

    // A second `disable-features` would replace the first, so there must be
    // exactly one and it must carry both groups.
    const disableFeatures = commandLine.appendSwitch.mock.calls.filter(
      ([name]) => name === "disable-features",
    );
    expect(disableFeatures).toHaveLength(1);
    const features = (disableFeatures[0]?.[1] ?? "").split(",");

    expect(features).toEqual(
      expect.arrayContaining([
        ...BACKGROUND_TIMER_THROTTLES,
        "Translate",
        "MediaRouter",
      ]),
    );
    expect(features).toContain("IntensiveWakeUpThrottling");
    expect(features).toContain("AllowAggressiveThrottlingWithWebSocket");
  });
});
