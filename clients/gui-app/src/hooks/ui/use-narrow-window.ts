import * as React from "react";

/**
 * WIDTH signal, and only width: "is the window narrower than the mobile
 * breakpoint right now?" The installed app's phone-layout policy is NOT
 * folded in here - that is `useIsMobileViewport()`, which reads this and
 * answers yes at every width in the installed app. Read this one for a
 * surface whose usable rendering is a fact about pixels rather than about
 * the shell: a two-column diff is unreadable at a phone's width and fine on
 * an iPad in landscape, which runs the same phone-layout bundle.
 */
const MOBILE_BREAKPOINT = 768;
// Range syntax, because it is the exact complement of Tailwind's `md` and
// `(max-width: 767px)` is not. `innerWidth` was an integer and `matches` is
// not, so at 767.5px the prefixed form would have moved the shell.
const MOBILE_QUERY = `(width < ${MOBILE_BREAKPOINT}px)`;

export function subscribeToMobileQuery(onChange: () => void): () => void {
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
export function readIsNarrowWindowSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function readIsNarrowWindowServerSnapshot(): boolean {
  return false;
}

export function useIsNarrowWindow(): boolean {
  return React.useSyncExternalStore(
    subscribeToMobileQuery,
    readIsNarrowWindowSnapshot,
    readIsNarrowWindowServerSnapshot,
  );
}
