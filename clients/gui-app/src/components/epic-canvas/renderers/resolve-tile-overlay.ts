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
 * terminal surface (dead / stalled) blocks while painted so its Retry stays
 * clickable.
 *
 * The loading AND stalled surfaces only paint when there is nothing
 * meaningful beneath them: the guest is not presented (`guestInteractive`
 * false - attaching, or re-attaching after a renderer reset), or the tile
 * has not yet seen a committed document (`documentCommitted` false - a fresh
 * tab still at its `about:blank` birth). Once a page has committed, a
 * navigation away from it keeps that page painted until the next one
 * commits, so status text over it is noise - "This page did not load" over a
 * page that plainly did is the complaint this exists to prevent. The toolbar
 * carries in-flight navigation instead, as in any browser: the spinner, and
 * a Stop in place of Reload. The stalled surface is reserved for a tab that
 * has never shown a page, where it is the only feedback there is.
 */
export function resolveTileOverlay(
  status: BrowserViewStatus,
  guestInteractive: boolean,
  navigationStalled: boolean,
  documentCommitted: boolean,
): TileOverlayView {
  if (status === "ready") {
    return { visible: false, blocking: false, surface: "loading" };
  }
  if (status === "dead") {
    return { visible: true, blocking: true, surface: "dead" };
  }
  const nothingBeneath = !guestInteractive || !documentCommitted;
  if (navigationStalled) {
    return {
      visible: nothingBeneath,
      blocking: nothingBeneath,
      surface: "stalled",
    };
  }
  return {
    visible: nothingBeneath,
    blocking: !guestInteractive,
    surface: "loading",
  };
}
