import { describe, expect, it } from "vitest";
import { resolveTileOverlay } from "@/components/epic-canvas/renderers/resolve-tile-overlay";
import type { BrowserViewStatus } from "@traycer-clients/shared/platform/browser-view";

/**
 * Load-bearing invariant: pointer blocking is gated on the guest not yet
 * being interactive, never on the same flag that hides the overlay. A live,
 * presented guest must never be click-blocked by a stale loader, and a
 * terminal surface (dead / stalled) must always keep blocking so its Retry
 * stays clickable.
 */
describe("resolveTileOverlay", () => {
  it("hides the overlay and never blocks once the tile is ready, regardless of guest interactivity", () => {
    for (const guestInteractive of [true, false]) {
      expect(resolveTileOverlay("ready", guestInteractive, false)).toEqual({
        visible: false,
        blocking: false,
        surface: "loading",
      });
      expect(resolveTileOverlay("ready", guestInteractive, true)).toEqual({
        visible: false,
        blocking: false,
        surface: "loading",
      });
    }
  });

  it("shows a blocking dead surface regardless of guest interactivity or stall state", () => {
    for (const guestInteractive of [true, false]) {
      for (const navigationStalled of [true, false]) {
        expect(
          resolveTileOverlay("dead", guestInteractive, navigationStalled),
        ).toEqual({ visible: true, blocking: true, surface: "dead" });
      }
    }
  });

  it("shows a blocking stalled surface while loading and stalled, regardless of guest interactivity", () => {
    for (const guestInteractive of [true, false]) {
      expect(resolveTileOverlay("loading", guestInteractive, true)).toEqual({
        visible: true,
        blocking: true,
        surface: "stalled",
      });
    }
  });

  it("does not block a live, interactive guest behind a stale loader", () => {
    expect(resolveTileOverlay("loading", true, false)).toEqual({
      visible: true,
      blocking: false,
      surface: "loading",
    });
  });

  it("blocks pointer events while loading and the guest is not yet interactive", () => {
    expect(resolveTileOverlay("loading", false, false)).toEqual({
      visible: true,
      blocking: true,
      surface: "loading",
    });
  });

  it("covers the full status/guestInteractive/navigationStalled truth table", () => {
    const statuses: readonly BrowserViewStatus[] = ["loading", "ready", "dead"];
    for (const status of statuses) {
      for (const guestInteractive of [true, false]) {
        for (const navigationStalled of [true, false]) {
          const result = resolveTileOverlay(
            status,
            guestInteractive,
            navigationStalled,
          );
          if (status === "ready") {
            expect(result).toEqual({
              visible: false,
              blocking: false,
              surface: "loading",
            });
          } else if (status === "dead") {
            expect(result).toEqual({
              visible: true,
              blocking: true,
              surface: "dead",
            });
          } else if (navigationStalled) {
            expect(result).toEqual({
              visible: true,
              blocking: true,
              surface: "stalled",
            });
          } else {
            expect(result).toEqual({
              visible: true,
              blocking: !guestInteractive,
              surface: "loading",
            });
          }
        }
      }
    }
  });
});
