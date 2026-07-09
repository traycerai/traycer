import { afterEach, describe, expect, it } from "vitest";
import { deriveTitleBarOverlayColors } from "@/lib/title-bar-overlay-colors";

/**
 * The Windows native min/max/close controls are drawn by Electron from the
 * `titleBarOverlay` colors. They must track the app's active theme + light/dark
 * mode, so the derived overlay colors are read from the same `--canvas` /
 * `--canvas-foreground` surface tokens the header itself paints with.
 */
describe("deriveTitleBarOverlayColors", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("converts oklch surface tokens to rgb so Chromium's overlay can parse them", () => {
    // Tailwind stores several presets' surfaces as `oklch()` literals, which the
    // native overlay can't parse - they must land as `rgb(...)`.
    document.documentElement.style.setProperty("--canvas", "oklch(1 0 0)");
    document.documentElement.style.setProperty(
      "--canvas-foreground",
      "oklch(0 0 0)",
    );

    const colors = deriveTitleBarOverlayColors(document);

    expect(colors).toEqual({
      color: "rgb(255, 255, 255)",
      symbolColor: "rgb(0, 0, 0)",
    });
    expect(colors.color).not.toContain("oklch");
  });

  it("tracks the active surface so a light theme yields light controls (not the dark default)", () => {
    document.documentElement.style.setProperty("--canvas", "#ffffff");
    document.documentElement.style.setProperty(
      "--canvas-foreground",
      "#171717",
    );

    const colors = deriveTitleBarOverlayColors(document);

    expect(colors.color).toBe("#ffffff");
    expect(colors.symbolColor).toBe("#171717");
    expect(colors.color).not.toBe("#0b0b0d");
  });

  it("falls back to the dark shell defaults when the surface tokens are unset", () => {
    expect(deriveTitleBarOverlayColors(document)).toEqual({
      color: "#0b0b0d",
      symbolColor: "#e5e5e5",
    });
  });
});
