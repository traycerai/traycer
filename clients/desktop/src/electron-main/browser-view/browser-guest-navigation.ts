import { URL } from "node:url";
import { log } from "../app/logger";
import type { BrowserViewListenerMap } from "./manager/browser-view-entry";

/**
 * What a browser guest is allowed to navigate to (browser security review, root
 * cause C).
 *
 * `installNavigationGuard` in `app/security.ts` covers the app shell only, so
 * until this existed a guest had no navigation policy at all: `file:`,
 * `javascript:`, `data:`, `devtools:` and the `traycer:` app scheme were all
 * reachable, from a page link and from the renderer-callable `navigate` control
 * action alike. A guest is a browser tab and a browser tab needs exactly two
 * schemes; `about:blank` is the third because provisioning loads it itself to
 * establish the first CDP target.
 *
 * The check is a scheme allow-list rather than a deny-list on purpose: a
 * deny-list is a list of the schemes somebody thought of.
 */
const ALLOWED_GUEST_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** Where a refused navigation was asked for, as the trace names it. */
export type BrowserGuestNavigationSource =
  | "navigate"
  | "will-navigate"
  | "will-redirect"
  | "will-frame-navigate"
  | "window-open"
  | "popup-window-open"
  | "cdp-navigate";

export function isAllowedGuestNavigationUrl(url: string): boolean {
  if (url === "about:blank") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ALLOWED_GUEST_SCHEMES.has(parsed.protocol);
}

/**
 * What THIS process may ask a guest to load - the host-initiated path only
 * (`navigate()`, reached from the renderer's `navigate` control action and the
 * accepted tab's initial navigation). It adds `file:` to the guest set so the
 * local-HTML preview flow works.
 *
 * `file:` stays OUT of {@link isAllowedGuestNavigationUrl}: a loaded website
 * must never pivot itself to `file:`, so every page-driven door
 * (`will-navigate`, `will-redirect`, `will-frame-navigate`, `window-open`,
 * `cdp-navigate`) keeps refusing it. Only a target the host chose reaches here.
 */
export function isAllowedHostInitiatedNavigationUrl(url: string): boolean {
  if (isAllowedGuestNavigationUrl(url)) return true;
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * The one line a refusal writes, carrying the SCHEME and nothing else.
 *
 * Not the URL: a refused target is by construction a scheme this guest may not
 * have, and for `javascript:` and `data:` the whole payload lives in the part
 * after the colon - path, query and all - so logging any more of it would put
 * attacker-chosen bytes into a file that gets pasted into support threads.
 * The scheme is the whole forensic content of the event anyway.
 */
export function traceRefusedGuestNavigation(
  url: string,
  source: BrowserGuestNavigationSource,
): void {
  log.warn("[browser-view] refused a guest navigation", {
    source,
    scheme: navigationScheme(url),
  });
}

function navigationScheme(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "<unparseable>";
  }
}

/**
 * Every event a PAGE can start a navigation from, guarded identically.
 *
 * Three rather than one, because `will-navigate` is narrower than it reads:
 * it does not fire for a server redirect (`will-redirect`) and it does not
 * fire for a subframe (`will-frame-navigate`), so a guard on it alone leaves
 * `<iframe src="file:///...">` and a 302 into a custom scheme reachable.
 *
 * Returned as a listener map rather than installed here, because a guest keeps
 * its listeners on the entry so teardown can remove them, while a popup has no
 * entry - {@link installGuestNavigationGuard} is the popup's half.
 */
export function guestNavigationGuards(): BrowserViewListenerMap {
  return {
    // The event object carries its own `url` and the positional one is
    // DEPRECATED in Electron 42 (`electron.d.ts`: `details`, then a
    // `@deprecated url: string`). Both are passed today, so this reads the
    // object first and keeps the positional as the fallback - a guard that
    // silently receives `undefined` when the deprecated argument is finally
    // dropped is a guard that stops naming what it is refusing.
    "will-navigate": (event: BrowserGuestNavigationEvent, url: string) => {
      refuseUnlessAllowed(event, event.url ?? url, "will-navigate");
    },
    "will-redirect": (event: BrowserGuestNavigationEvent, url: string) => {
      refuseUnlessAllowed(event, event.url ?? url, "will-redirect");
    },
    // Electron hands this one a single details object carrying its own url,
    // not the `(event, url)` pair the other two use.
    "will-frame-navigate": (
      details: BrowserGuestNavigationEvent & { readonly url: string },
    ) => {
      refuseUnlessAllowed(details, details.url, "will-frame-navigate");
    },
  };
}

/** {@link guestNavigationGuards} on a webContents that keeps no listener map. */
export function installGuestNavigationGuard(webContents: {
  on: NodeJS.EventEmitter["on"];
}): void {
  for (const [event, listener] of Object.entries(guestNavigationGuards())) {
    webContents.on(event, listener);
  }
}

interface BrowserGuestNavigationEvent {
  /** Present on the Electron event object; the positional `url` is deprecated. */
  readonly url?: string | undefined;
  preventDefault(): void;
}

function refuseUnlessAllowed(
  event: BrowserGuestNavigationEvent,
  url: string,
  source: BrowserGuestNavigationSource,
): void {
  if (isAllowedGuestNavigationUrl(url)) return;
  event.preventDefault();
  traceRefusedGuestNavigation(url, source);
}
