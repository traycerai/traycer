import { describe, expect, it } from "vitest";
import {
  readResolutionTestDisplay,
  readResolutionTestWindowConfig,
} from "../resolution-test-env";

describe("resolution test env", () => {
  it("parses deterministic window and display overrides", () => {
    const env = {
      TRAYCER_RESOLUTION_TEST_WINDOW_BOUNDS: "3840x2160",
      TRAYCER_RESOLUTION_TEST_DISABLE_MAXIMIZE: "1",
      TRAYCER_RESOLUTION_TEST_DISPLAY_BOUNDS: "3840x2160",
      TRAYCER_RESOLUTION_TEST_DISPLAY_SCALE_FACTOR: "1",
    };

    expect(readResolutionTestWindowConfig(env)).toEqual({
      bounds: { width: 3840, height: 2160 },
      disableMaximize: true,
    });
    expect(readResolutionTestDisplay(env)).toEqual({
      bounds: { width: 3840 },
      scaleFactor: 1,
    });
  });

  it("ignores malformed deterministic display overrides", () => {
    expect(
      readResolutionTestDisplay({
        TRAYCER_RESOLUTION_TEST_DISPLAY_BOUNDS: "3840",
        TRAYCER_RESOLUTION_TEST_DISPLAY_SCALE_FACTOR: "1",
      }),
    ).toBeNull();
    expect(
      readResolutionTestDisplay({
        TRAYCER_RESOLUTION_TEST_DISPLAY_BOUNDS: "3840x2160",
        TRAYCER_RESOLUTION_TEST_DISPLAY_SCALE_FACTOR: "nope",
      }),
    ).toBeNull();
  });
});
