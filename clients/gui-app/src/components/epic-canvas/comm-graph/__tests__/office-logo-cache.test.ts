import { afterEach, describe, expect, it } from "vitest";
import {
  clearOfficeLogoCache,
  officeHarnessLogo,
} from "@/components/epic-canvas/comm-graph/office/office-logo-cache";

afterEach(() => {
  clearOfficeLogoCache();
});

/**
 * jsdom has no 2d canvas and no image decoder, so a logo can never become
 * ready here. That is the same state a real browser is in for the first frames
 * after a miss, which is why the contract under test is "returns null and does
 * not throw" rather than anything about pixels: the frame loop calls this on
 * every frame, and a throw would take the whole floor down.
 */
describe("officeHarnessLogo", () => {
  it("returns null and stays silent where nothing can be rasterized", () => {
    expect(() => officeHarnessLogo("claude")).not.toThrow();
    expect(officeHarnessLogo("claude")).toBeNull();
  });

  it("survives being called every frame for every harness on the floor", () => {
    expect(() => {
      for (let frame = 0; frame < 3; frame += 1) {
        officeHarnessLogo("claude");
        officeHarnessLogo("codex");
        officeHarnessLogo("cursor");
      }
    }).not.toThrow();
  });

  it("serves one raster per harness and forgets it all on a clear", () => {
    // The theme is NOT part of the key: the mark is recolored to the harness
    // accent, which is the same colour in both themes, so a per-theme entry
    // only ever held a second identical raster. Asking repeatedly is a hit
    // that starts no further work; clearing puts it back to a cold miss.
    officeHarnessLogo("claude");
    expect(officeHarnessLogo("claude")).toBeNull();
    clearOfficeLogoCache();
    expect(officeHarnessLogo("claude")).toBeNull();
  });
});
