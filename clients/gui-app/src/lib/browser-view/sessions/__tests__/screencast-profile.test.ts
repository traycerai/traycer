import { afterEach, describe, expect, it } from "vitest";
import {
  clampScreencastDpr,
  screencastProfile,
} from "@/lib/browser-view/sessions/screencast-profile";
import { setMobileApp } from "@/lib/mobile-app";

afterEach(() => {
  setMobileApp(false);
});

describe("screencastProfile", () => {
  it("reports the device ratio unchanged off the installed app", () => {
    setMobileApp(false);
    const profile = screencastProfile();
    expect(profile.maxDpr).toBeNull();
    expect(clampScreencastDpr(profile, 3)).toBe(3);
    expect(clampScreencastDpr(profile, 1)).toBe(1);
  });

  it("clamps a phone's device ratio so the host stops sizing frames at 3x", () => {
    setMobileApp(true);
    const profile = screencastProfile();
    expect(clampScreencastDpr(profile, 3)).toBe(1.5);
  });

  it("never raises a ratio the device reports below the ceiling", () => {
    setMobileApp(true);
    expect(clampScreencastDpr(screencastProfile(), 1)).toBe(1);
  });

  it("asks a phone for a smaller, cheaper frame than a desktop tile", () => {
    setMobileApp(false);
    const desktop = screencastProfile();
    setMobileApp(true);
    const mobile = screencastProfile();
    expect(mobile.quality).toBeLessThan(desktop.quality);
    expect(mobile.maxWidth).toBeLessThan(desktop.maxWidth);
    // Portrait, unlike the landscape desktop default: a phone frame trimmed to
    // 720 tall would lose most of the page it is showing.
    expect(mobile.maxHeight).toBeGreaterThan(mobile.maxWidth);
  });

  it("costs a phone frame a fraction of an unclamped one", () => {
    setMobileApp(true);
    const profile = screencastProfile();
    const viewport = { width: 390, height: 844 };
    const clamped =
      Math.min(
        viewport.width * clampScreencastDpr(profile, 3),
        profile.maxWidth,
      ) *
      Math.min(
        viewport.height * clampScreencastDpr(profile, 3),
        profile.maxHeight,
      );
    const unclamped = viewport.width * 3 * (viewport.height * 3);
    expect(clamped * 3).toBeLessThan(unclamped);
  });
});
