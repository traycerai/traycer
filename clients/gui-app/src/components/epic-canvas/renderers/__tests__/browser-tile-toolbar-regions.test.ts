import { describe, expect, it } from "vitest";
import { browserToolbarRegions } from "@/components/epic-canvas/renderers/browser-tile-toolbar-regions";
import type {
  TileChromeCapabilities,
  TileController,
} from "@/components/epic-canvas/renderers/tile-controller";

const NO_CAPABILITIES: TileChromeCapabilities = {
  navigate: false,
  back: false,
  forward: false,
  reload: false,
  zoom: false,
  devtools: false,
  find: false,
  siteInfo: false,
  annotate: false,
  screenshot: false,
  previewWindow: false,
  recording: false,
  hardReload: false,
  appearance: false,
  clearCache: false,
  audio: false,
};

function controllerWith(
  capabilities: Partial<TileChromeCapabilities>,
  overrides: Partial<TileController>,
): TileController {
  return {
    viewport: null,
    capabilities: { ...NO_CAPABILITIES, ...capabilities },
    profile: "primary",
    onSaveScreenshot: null,
    onToggleRecording: null,
    onRotateViewport: null,
    onTogglePreviewWindow: () => undefined,
    isRecording: false,
    ...overrides,
  } as TileController;
}

describe("browserToolbarRegions", () => {
  it("shows nothing for a tile with no capabilities at all", () => {
    expect(browserToolbarRegions(controllerWith({}, {}), false)).toEqual({
      showNav: false,
      showAddress: false,
      showTrailing: false,
    });
  });

  it("shows nav for any one navigation capability", () => {
    expect(browserToolbarRegions(controllerWith({ back: true }, {}), false).showNav).toBe(
      true,
    );
    expect(
      browserToolbarRegions(controllerWith({ reload: true }, {}), false).showNav,
    ).toBe(true);
  });

  it("ties the address region to navigate alone", () => {
    expect(
      browserToolbarRegions(controllerWith({ navigate: true }, {}), false).showAddress,
    ).toBe(true);
  });

  it.each([
    "zoom",
    "devtools",
    "siteInfo",
    "appearance",
    "clearCache",
    "audio",
    "hardReload",
    "previewWindow",
  ] as const)(
    "opens the trailing region for the overflow-menu capability %s",
    (capability) => {
      // Each of these renders a row in the overflow menu, so a trailing region
      // that ignored it would hide a control whose capability is on - the bug
      // this table exists to prevent.
      expect(
        browserToolbarRegions(controllerWith({ [capability]: true }, {}), false)
          .showTrailing,
      ).toBe(true);
    },
  );

  it("opens the trailing region for a picture-in-picture control", () => {
    expect(browserToolbarRegions(controllerWith({}, {}), true).showTrailing).toBe(
      true,
    );
  });

  it("opens the trailing region for a private session, which says so there", () => {
    expect(
      browserToolbarRegions(controllerWith({}, { profile: "isolated" }), false)
        .showTrailing,
    ).toBe(true);
  });

  it("needs both the recording capability and a guest to record", () => {
    expect(
      browserToolbarRegions(controllerWith({ recording: true }, {}), false)
        .showTrailing,
    ).toBe(false);
    expect(
      browserToolbarRegions(
        controllerWith(
          { recording: true },
          { onToggleRecording: () => undefined },
        ),
        false,
      ).showTrailing,
    ).toBe(true);
  });

  it("needs both the screenshot capability and a guest to capture", () => {
    expect(
      browserToolbarRegions(controllerWith({ screenshot: true }, {}), false)
        .showTrailing,
    ).toBe(false);
    expect(
      browserToolbarRegions(
        controllerWith(
          { screenshot: true },
          { onSaveScreenshot: () => undefined },
        ),
        false,
      ).showTrailing,
    ).toBe(true);
  });
});
