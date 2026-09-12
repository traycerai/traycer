import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_ZOOM_FACTOR,
  MAX_BROWSER_ZOOM_FACTOR,
  MIN_BROWSER_ZOOM_FACTOR,
  readBrowserZoomFactor,
} from "@/lib/browser-view/browser-tile-defaults";

describe("readBrowserZoomFactor", () => {
  it("keeps a remembered zoom a user actually set", () => {
    expect(readBrowserZoomFactor(1.25)).toBe(1.25);
  });

  it("reads a tile written before zoom was remembered as never zoomed", () => {
    // A missing key must not discard the whole tile.
    expect(readBrowserZoomFactor(undefined)).toBe(DEFAULT_BROWSER_ZOOM_FACTOR);
  });

  it("refuses a non-number rather than propagating it to the compositor", () => {
    expect(readBrowserZoomFactor("2")).toBe(DEFAULT_BROWSER_ZOOM_FACTOR);
    expect(readBrowserZoomFactor(null)).toBe(DEFAULT_BROWSER_ZOOM_FACTOR);
    expect(readBrowserZoomFactor(Number.NaN)).toBe(DEFAULT_BROWSER_ZOOM_FACTOR);
  });

  it("pins a stored value to the bounds main will accept", () => {
    expect(readBrowserZoomFactor(99)).toBe(MAX_BROWSER_ZOOM_FACTOR);
    expect(readBrowserZoomFactor(0.01)).toBe(MIN_BROWSER_ZOOM_FACTOR);
  });

  it("agrees with the control action's own bounds", () => {
    // The wire schema accepts 0.25..5; a value that survives persistence must
    // be one main will still take.
    expect(MIN_BROWSER_ZOOM_FACTOR).toBe(0.25);
    expect(MAX_BROWSER_ZOOM_FACTOR).toBe(5);
  });
});
