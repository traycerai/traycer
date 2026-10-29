import { describe, expect, it } from "vitest";
import {
  simulatorIdleCountdownLabel,
  simulatorVersionLabel,
} from "@/lib/simulator-view/simulator-labels";

describe("simulatorVersionLabel", () => {
  it("prefixes the platform only when the host's version does not already name it", () => {
    // A booted device's version carries the OS name; a cold iOS simulator's
    // is the number alone; a cold Android AVD's is the bare "Android".
    expect(
      simulatorVersionLabel({ platform: "ios", version: "iOS 26.5" }),
    ).toBe("iOS 26.5");
    expect(simulatorVersionLabel({ platform: "ios", version: "18.0" })).toBe(
      "iOS 18.0",
    );
    expect(
      simulatorVersionLabel({ platform: "android", version: "Android" }),
    ).toBe("Android");
    expect(simulatorVersionLabel({ platform: "android", version: "" })).toBe(
      "Android",
    );
  });
});

describe("simulatorIdleCountdownLabel", () => {
  const NOW = 1_000_000;

  it("counts whole minutes down, and stops counting once the deadline has passed", () => {
    expect(simulatorIdleCountdownLabel(NOW + 6 * 60_000 + 30_000, NOW)).toBe(
      "Idle · powers off in 7 min",
    );
    expect(simulatorIdleCountdownLabel(NOW + 1_000, NOW)).toBe(
      "Idle · powers off in 1 min",
    );
    // The host's tick runs about once a minute, so a deadline in the past is
    // ordinary - it must not keep reading as a minute still to go.
    expect(simulatorIdleCountdownLabel(NOW, NOW)).toBe("Idle · powering off");
    expect(simulatorIdleCountdownLabel(NOW - 5 * 60_000, NOW)).toBe(
      "Idle · powering off",
    );
    expect(simulatorIdleCountdownLabel(null, NOW)).toBeNull();
  });
});
