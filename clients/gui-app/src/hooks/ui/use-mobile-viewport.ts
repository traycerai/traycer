import * as React from "react";

/**
 * VIEWPORT signal: "is the window currently narrow?" - nothing more.
 *
 * This is one of THREE distinct device/shell signals; picking the wrong one
 * causes subtle bugs, so choose by the question you are asking:
 *
 * - "Would resizing the window change this?" -> `useIsMobileViewport()`
 *   (this file). Pure layout: hamburger vs tab strip, drawer vs dialog.
 *   Flips live with the media query - a narrow DESKTOP browser window gets
 *   the mobile layout, and that is correct.
 * - "Is this the installed mobile app, as a product?" -> `isMobileApp()`
 *   (`@/lib/mobile-app`). Set once by the Capacitor entry, immutable.
 *   UX-policy divergence only (e.g. the single-composer draft model) -
 *   NEVER layout, and never inherited by a responsively-narrow website.
 * - "Can this shell physically do X?" -> capability fields on `IRunnerHost`
 *   (e.g. `workspaceFolders.canPickNatively`). Abilities, not identity: a
 *   desktop browser also lacks a native folder dialog without being the
 *   mobile app.
 */

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribeToMobileQuery(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function readIsMobileSnapshot(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function readIsMobileServerSnapshot(): boolean {
  return false;
}

export function useIsMobileViewport(): boolean {
  return React.useSyncExternalStore(
    subscribeToMobileQuery,
    readIsMobileSnapshot,
    readIsMobileServerSnapshot,
  );
}

/**
 * Imperative read of the same breakpoint for command-time call sites (event
 * handlers, non-subscribing actions) that must not re-render on viewport
 * changes.
 */
export function isMobileViewport(): boolean {
  return readIsMobileSnapshot();
}
