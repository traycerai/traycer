import * as React from "react";
import {
  readIsNarrowWindowSnapshot,
  subscribeToMobileQuery,
} from "@/hooks/ui/use-narrow-window";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";

/**
 * VIEWPORT signal: "is the window currently narrow?" - nothing more, except in
 * the installed mobile app, which ships only the phone layout, so the answer
 * there is always yes.
 *
 * This is one of THREE distinct device/shell signals; picking the wrong one
 * causes subtle bugs, so choose by the question you are asking:
 *
 * - "Would resizing the window change this?" -> `useIsMobileViewport()`
 *   (this file). Pure layout: hamburger vs tab strip, drawer vs dialog.
 *   Flips live with the media query - a narrow DESKTOP browser window gets
 *   the mobile layout, and that is correct. The one exception is the
 *   installed mobile app, which has no desktop layout to offer and says so
 *   through `isPhoneLayoutOnly()` below; resizing cannot move it.
 * - "Is this the installed mobile app, as a product?" -> `isMobileApp()`
 *   (`@/lib/mobile-app`). Set once by the Capacitor entry, immutable.
 *   UX-policy divergence only (e.g. the single-composer draft model) -
 *   NEVER layout, and never inherited by a responsively-narrow website.
 * - "Can this shell physically do X?" -> capability fields on `IRunnerHost`
 *   (e.g. `workspaceFolders.canPickNatively`). Abilities, not identity: a
 *   desktop browser also lacks a native folder dialog without being the
 *   mobile app.
 */

function readIsMobileSnapshot(): boolean {
  // Policy before measurement: the installed app has one layout at any width.
  // The width half - the query, its subscription and why it is read instead
  // of `innerWidth` - lives in `use-narrow-window.ts`, which surfaces keyed
  // on pixels alone read directly.
  if (isPhoneLayoutOnly()) return true;
  return readIsNarrowWindowSnapshot();
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
