import { describe, expect, it } from "vitest";
import {
  appColumnChrome,
  sideStripOwnsTitleBar,
} from "@/components/layout/header/app-title-band-kind";

const PLATFORMS = ["darwin", "win32", "linux", null] as const;

describe("appColumnChrome", () => {
  it.each(PLATFORMS)("keeps the header for top on %s", (platform) => {
    for (const frameless of [true, false]) {
      expect(
        appColumnChrome({ placement: "top", platform, frameless }),
      ).toEqual({ placement: "top", titleBand: "header" });
    }
  });

  it.each(PLATFORMS)(
    "draws nothing for a side strip in a browser shell (%s)",
    (platform) => {
      for (const placement of ["left", "right"] as const) {
        expect(
          appColumnChrome({ placement, platform, frameless: false }),
        ).toEqual({ placement, titleBand: "none" });
      }
    },
  );

  it("draws nothing on macOS with the strip at the left", () => {
    expect(
      appColumnChrome({
        placement: "left",
        platform: "darwin",
        frameless: true,
      }),
    ).toEqual({ placement: "left", titleBand: "none" });
  });

  it("draws the band on macOS with the strip at the right", () => {
    expect(
      appColumnChrome({
        placement: "right",
        platform: "darwin",
        frameless: true,
      }),
    ).toEqual({ placement: "right", titleBand: "band" });
  });

  it.each(["win32", "linux", null] as const)(
    "draws the band for either side strip on frameless %s",
    (platform) => {
      for (const placement of ["left", "right"] as const) {
        expect(
          appColumnChrome({ placement, platform, frameless: true }),
        ).toEqual({ placement, titleBand: "band" });
      }
    },
  );
});

describe("sideStripOwnsTitleBar", () => {
  it("is true only on a frameless macOS window with the strip at the left", () => {
    for (const placement of ["top", "left", "right"] as const) {
      for (const platform of PLATFORMS) {
        for (const frameless of [true, false]) {
          expect(
            sideStripOwnsTitleBar({ placement, platform, frameless }),
          ).toBe(frameless && platform === "darwin" && placement === "left");
        }
      }
    }
  });
});
