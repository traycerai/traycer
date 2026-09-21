import * as React from "react";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";

/**
 * VIEWPORT signal: "is the window currently narrow?" - nothing more, except in
 * a bundle that ships only the phone layout, where the answer is always yes.
 *
 * This is one of THREE distinct device/shell signals; picking the wrong one
 * causes subtle bugs, so choose by the question you are asking:
 *
 * - "Would resizing the window change this?" -> `useIsMobileViewport()`
 *   (this file). Pure layout: hamburger vs tab strip, drawer vs dialog.
 *   Flips live with the media query - a narrow DESKTOP browser window gets
 *   the mobile layout, and that is correct. The one exception is the mobile
 *   bundle, which has no desktop layout to offer and says so through
 *   `isPhoneLayoutOnly()` below; resizing cannot move it.
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
// Range syntax, because it is the exact complement of Tailwind's `md` and
// `(max-width: 767px)` is not. `innerWidth` was an integer and `matches` is
// not, so at 767.5px the prefixed form would have moved the shell.
const MOBILE_QUERY = `(width < ${MOBILE_BREAKPOINT}px)`;

function subscribeToMobileQuery(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  // The self-heal: a `change` that WKWebView coalesces or drops cannot leave
  // the app wedged in the wrong shell, because the resize accompanying it
  // re-asks. Re-reading is idempotent - React drops the update when the
  // snapshot is unchanged - so this costs a comparison, not a render.
  window.addEventListener("resize", onChange);
  return () => {
    mql.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

/**
 * Reads the QUERY, not `window.innerWidth`, and the two are not interchangeable
 * here.
 *
 * They used to disagree: the subscription was the query, the snapshot was
 * `innerWidth`. WKWebView updates the query BEFORE `innerWidth` settles, so
 * the `change` event arrived, React re-read the snapshot, and `innerWidth`
 * still described the previous size. `useSyncExternalStore` caches that
 * answer, the query does not fire twice, and the app stayed in the wrong shell
 * until something unrelated re-rendered it. Measured on an iPad mini: five of
 * six rotations delivered `change` against a stale width.
 */
function readIsMobileSnapshot(): boolean {
  // Policy before measurement: the mobile bundle has one layout at any width.
  if (isPhoneLayoutOnly()) return true;
  return window.matchMedia(MOBILE_QUERY).matches;
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
