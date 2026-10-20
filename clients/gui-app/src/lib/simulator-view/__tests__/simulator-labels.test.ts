import { describe, expect, it } from "vitest";
import { simulatorVersionLabel } from "@/lib/simulator-view/simulator-labels";

describe("simulatorVersionLabel", () => {
  it("prefixes the platform only when the host's version does not already name it", () => {
    // A booted device's version carries the OS name; a cold iOS simulator's
    // is the number alone; a cold Android AVD's is the bare "Android".
    expect(
      simulatorVersionLabel({ platform: "android", version: "Android 15.0" }),
    ).toBe("Android 15.0");
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
