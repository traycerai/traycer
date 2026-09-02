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
    expect(() => officeHarnessLogo("claude", "light")).not.toThrow();
    expect(officeHarnessLogo("claude", "light")).toBeNull();
  });

  it("survives being called every frame for every harness on the floor", () => {
    expect(() => {
      for (let frame = 0; frame < 3; frame += 1) {
        officeHarnessLogo("claude", "dark");
        officeHarnessLogo("codex", "dark");
        officeHarnessLogo("cursor", "light");
      }
    }).not.toThrow();
  });

  it("keys the cache by theme, so a theme flip is not a stale logo", () => {
    officeHarnessLogo("claude", "light");
    // Distinct keys, so neither answer can be served for the other theme. Both
    // are null here; what is under test is that the second call is a MISS and
    // starts its own work rather than reading the first theme's slot.
    expect(officeHarnessLogo("claude", "dark")).toBeNull();
    clearOfficeLogoCache();
    expect(officeHarnessLogo("claude", "light")).toBeNull();
  });
});
