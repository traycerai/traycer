import { describe, expect, it } from "vitest";
import {
  resolveTileOverlay,
  type TileOverlayView,
} from "@/components/epic-canvas/renderers/resolve-tile-overlay";
import type { BrowserViewStatus } from "@traycer-clients/shared/platform/browser-view";

/**
 * Load-bearing invariant: pointer blocking is gated on the guest not yet
 * being interactive, never on the same flag that hides the overlay. A live,
 * presented guest must never be click-blocked by a stale loader, and a
 * terminal surface (dead / stalled) must always keep blocking so its Retry
 * stays clickable.
 */
describe("resolveTileOverlay", () => {
  it("hides the overlay and never blocks once the tile is ready, regardless of guest interactivity or document commit", () => {
    for (const guestInteractive of [true, false]) {
      for (const documentCommitted of [true, false]) {
        expect(
          resolveTileOverlay(
            "ready",
            guestInteractive,
            false,
            documentCommitted,
          ),
        ).toEqual({
          visible: false,
          blocking: false,
          surface: "loading",
        });
        expect(
          resolveTileOverlay(
            "ready",
            guestInteractive,
            true,
            documentCommitted,
          ),
        ).toEqual({
          visible: false,
          blocking: false,
          surface: "loading",
        });
      }
    }
  });

  it("shows a blocking dead surface regardless of guest interactivity, stall state, or document commit", () => {
    for (const guestInteractive of [true, false]) {
      for (const navigationStalled of [true, false]) {
        for (const documentCommitted of [true, false]) {
          expect(
            resolveTileOverlay(
              "dead",
              guestInteractive,
              navigationStalled,
              documentCommitted,
            ),
          ).toEqual({ visible: true, blocking: true, surface: "dead" });
        }
      }
    }
  });

  it("shows a blocking stalled surface while loading and stalled, regardless of guest interactivity or document commit", () => {
    for (const guestInteractive of [true, false]) {
      for (const documentCommitted of [true, false]) {
        expect(
          resolveTileOverlay(
            "loading",
            guestInteractive,
            true,
            documentCommitted,
          ),
        ).toEqual({
          visible: true,
          blocking: true,
          surface: "stalled",
        });
      }
    }
  });

  it("does not block a live, interactive guest behind a stale loader", () => {
    expect(resolveTileOverlay("loading", true, false, true)).toEqual({
      visible: false,
      blocking: false,
      surface: "loading",
    });
  });

  it("blocks pointer events while loading and the guest is not yet interactive", () => {
    expect(resolveTileOverlay("loading", false, false, true)).toEqual({
      visible: true,
      blocking: true,
      surface: "loading",
    });
    expect(resolveTileOverlay("loading", false, false, false)).toEqual({
      visible: true,
      blocking: true,
      surface: "loading",
    });
  });

  it("still paints the loader over an interactive guest that has not committed a document yet", () => {
    expect(resolveTileOverlay("loading", true, false, false)).toEqual({
      visible: true,
      blocking: false,
      surface: "loading",
    });
  });

  it("hides the loader once an interactive guest has committed a document", () => {
    expect(resolveTileOverlay("loading", true, false, true)).toEqual({
      visible: false,
      blocking: false,
      surface: "loading",
    });
  });

  it("covers the full status/guestInteractive/navigationStalled/documentCommitted truth table", () => {
    const statuses: readonly BrowserViewStatus[] = ["loading", "ready", "dead"];
    const bools = [true, false] as const;
    const cases = statuses.flatMap((status) =>
      bools.flatMap((guestInteractive) =>
        bools.flatMap((navigationStalled) =>
          bools.map((documentCommitted) => ({
            status,
            guestInteractive,
            navigationStalled,
            documentCommitted,
          })),
        ),
      ),
    );
    expect(cases).toHaveLength(24);
    for (const c of cases) {
      const result = resolveTileOverlay(
        c.status,
        c.guestInteractive,
        c.navigationStalled,
        c.documentCommitted,
      );
      expect(result).toEqual(expectedOverlay(c));
    }
  });
});

function expectedOverlay(c: {
  readonly status: BrowserViewStatus;
  readonly guestInteractive: boolean;
  readonly navigationStalled: boolean;
  readonly documentCommitted: boolean;
}): TileOverlayView {
  if (c.status === "ready") {
    return { visible: false, blocking: false, surface: "loading" };
  }
  if (c.status === "dead") {
    return { visible: true, blocking: true, surface: "dead" };
  }
  if (c.navigationStalled) {
    return { visible: true, blocking: true, surface: "stalled" };
  }
  return {
    visible: !c.guestInteractive || !c.documentCommitted,
    blocking: !c.guestInteractive,
    surface: "loading",
  };
}
