import { afterEach, describe, expect, it } from "vitest";
import {
  clampScreencastDpr,
  computeScreencastProfile,
  resetScreencastProfileMemo,
  screencastProfile,
  type ScreencastDisplayExtent,
} from "@/lib/browser-view/sessions/screencast-profile";
import { setMobileApp } from "@/lib/mobile-app";

const retinaLaptop: ScreencastDisplayExtent = {
  cssWidth: 1_512,
  cssHeight: 982,
  devicePixelRatio: 2,
};

afterEach(() => {
  setMobileApp(false);
  resetScreencastProfileMemo();
});

describe("computeScreencastProfile", () => {
  it("budgets a desktop frame at the display's own physical extent", () => {
    const profile = computeScreencastProfile(retinaLaptop, false);
    expect(profile.maxWidth).toBe(3_024);
    expect(profile.maxHeight).toBe(1_964);
    expect(profile.maxDpr).toBeNull();
  });

  it("leaves a tile on that display untrimmed, which a fixed 720p box did not", () => {
    // The tile geometry from the field report: a 1272x800 CSS tile on a 2x
    // display asks the host for 2544x1600 physical pixels.
    const profile = computeScreencastProfile(retinaLaptop, false);
    const requested = { width: 1_272 * 2, height: 800 * 2 };
    expect(Math.min(requested.width, profile.maxWidth)).toBe(requested.width);
    expect(Math.min(requested.height, profile.maxHeight)).toBe(
      requested.height,
    );
  });

  it("keeps glyph edges out of the quantizer on a desktop shell", () => {
    expect(computeScreencastProfile(retinaLaptop, false).quality).toBe(92);
  });

  it("spends a handheld frame's saving on quality, not on addressable pixels", () => {
    const handheld = computeScreencastProfile(
      { cssWidth: 390, cssHeight: 844, devicePixelRatio: 3 },
      true,
    );
    expect(handheld.maxDpr).toBe(2);
    expect(handheld.quality).toBeLessThan(
      computeScreencastProfile(retinaLaptop, false).quality,
    );
    // Sized at the clamped ratio, so the reported ratio and the edges agree.
    expect(handheld.maxWidth).toBe(780);
    expect(handheld.maxHeight).toBe(1_688);
  });

  it("guards a decoded frame's allocation on an outsized display", () => {
    const profile = computeScreencastProfile(
      { cssWidth: 6_016, cssHeight: 3_384, devicePixelRatio: 2 },
      false,
    );
    expect(profile.maxWidth).toBe(3_840);
    expect(profile.maxHeight).toBe(3_840);
  });

  it("never sizes below one device pixel on a degenerate extent", () => {
    const profile = computeScreencastProfile(
      { cssWidth: 0, cssHeight: Number.NaN, devicePixelRatio: 0 },
      false,
    );
    expect(profile.maxWidth).toBeGreaterThanOrEqual(1);
    expect(profile.maxHeight).toBeGreaterThanOrEqual(1);
  });
});

describe("clampScreencastDpr", () => {
  it("reports the device ratio unchanged off the installed app", () => {
    const profile = computeScreencastProfile(retinaLaptop, false);
    expect(clampScreencastDpr(profile, 3)).toBe(3);
    expect(clampScreencastDpr(profile, 1)).toBe(1);
  });

  it("clamps a phone's ratio without raising one already below the ceiling", () => {
    const profile = computeScreencastProfile(retinaLaptop, true);
    expect(clampScreencastDpr(profile, 3)).toBe(2);
    expect(clampScreencastDpr(profile, 1)).toBe(1);
  });
});

describe("screencastProfile", () => {
  it("returns one object per shell and display, so a render cannot re-open the stream", () => {
    expect(screencastProfile()).toBe(screencastProfile());
  });

  it("re-reads the budget when the shell changes", () => {
    const desktop = screencastProfile();
    setMobileApp(true);
    const handheld = screencastProfile();
    expect(handheld).not.toBe(desktop);
    expect(handheld.maxDpr).toBe(2);
    expect(handheld.quality).toBeLessThan(desktop.quality);
  });

  it("asks for more than the retired fixed box on any real display", () => {
    const profile = screencastProfile();
    expect(profile.quality).toBeGreaterThan(70);
    expect(profile.maxWidth).toBeGreaterThanOrEqual(1_280);
  });
});
