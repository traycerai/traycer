import type { BrowserViewStatus } from "@traycer-clients/shared/platform/browser-view";

/**
 * Which loader/terminal surface the tile overlay shows. The wire status union
 * is only `loading | ready | dead`; `stalled` is a client-derived terminal
 * state for a `loading` that went silent, not a new wire phase.
 */
export type TileOverlaySurface = "loading" | "stalled" | "dead";

export interface TileOverlayView {
  /** The overlay is painted (opaque) over the guest. */
  readonly visible: boolean;
  /** The overlay intercepts pointer events instead of passing them through. */
  readonly blocking: boolean;
  readonly surface: TileOverlaySurface;
}

/**
 * Resolves what the tile overlay does. Pointer blocking is gated on the guest
 * not yet being interactive - never on the same flag that hides the overlay -
 * so a live, presented guest is never click-blocked by a stale loader. A
 * terminal surface (dead / stalled) blocks so its Retry stays clickable.
 */
export function resolveTileOverlay(
  status: BrowserViewStatus,
  guestInteractive: boolean,
  navigationStalled: boolean,
): TileOverlayView {
  if (status === "ready") {
    return { visible: false, blocking: false, surface: "loading" };
  }
  if (status === "dead") {
    return { visible: true, blocking: true, surface: "dead" };
  }
  if (navigationStalled) {
    return { visible: true, blocking: true, surface: "stalled" };
  }
  return { visible: true, blocking: !guestInteractive, surface: "loading" };
}
