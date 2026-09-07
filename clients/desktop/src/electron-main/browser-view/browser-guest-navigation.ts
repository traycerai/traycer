import { URL } from "node:url";
import { log } from "../app/logger";
import {
  confirmAndLaunchExternalScheme,
  DANGEROUS_EXTERNAL_SCHEMES,
  launchExternalFromGuest,
  SAFE_EXTERNAL_SCHEMES,
} from "../app/security";
import type { BrowserViewListenerMap } from "./manager/browser-view-entry";

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

/** `file:` stays OUT of {@link isAllowedGuestNavigationUrl}: a loaded website must never pivot itself to `file:`, so every page-driven door (`will-navigate`, `will-redirect`. */
export function isAllowedHostInitiatedNavigationUrl(url: string): boolean {
  if (isAllowedGuestNavigationUrl(url)) return true;
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

/** Not the URL: a refused target is by construction a scheme this guest may not have, and for `javascript:` and `data:` the whole payload lives in the part after the colon. */
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

/** A hidden subframe (`will-frame-navigate`) is excluded on purpose - a page must not be able to silently launch an app from an off-screen `<iframe>`. */
const EXTERNAL_ROUTABLE_SOURCES: ReadonlySet<BrowserGuestNavigationSource> =
  new Set([
    "window-open",
    "popup-window-open",
    "will-navigate",
    "will-redirect",
  ]);

/**
 * Chrome-like hand-off for a guest navigation the tab may not load itself, across three classes so a real external scheme is never a silent no-op: 1. {@link SAFE_EXTERNAL_SCHEMES}.
 * 2. {@link DANGEROUS_EXTERNAL_SCHEMES} (and any `about:` but `about:blank`) - stays refused and traced; never reaches `shell.openExternal`.
 */
export function handleExternalGuestScheme(
  url: string,
  source: BrowserGuestNavigationSource,
  hasGesture: boolean,
): boolean {
  if (url === "about:blank") return false;
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    traceRefusedGuestNavigation(url, source);
    return false;
  }
  if (scheme === "http:" || scheme === "https:") return false;
  if (scheme === "about:" || DANGEROUS_EXTERNAL_SCHEMES.has(scheme)) {
    traceRefusedGuestNavigation(url, source);
    return false;
  }
  log.info("[browser-view] handed a guest navigation to the OS", {
    source,
    scheme,
  });
  if (hasGesture && SAFE_EXTERNAL_SCHEMES.has(scheme)) {
    void launchExternalFromGuest(url);
    return true;
  }
  void confirmAndLaunchExternalScheme(url);
  return true;
}

function isExternalRoutableSource(
  source: BrowserGuestNavigationSource,
): boolean {
  return EXTERNAL_ROUTABLE_SOURCES.has(source);
}

export function guestNavigationGuards(
  hasGesture: () => boolean,
): BrowserViewListenerMap {
  return {
    "will-navigate": (event: BrowserGuestNavigationEvent, url: string) => {
      refuseUnlessAllowed(event, event.url ?? url, "will-navigate", hasGesture);
    },
    "will-redirect": (event: BrowserGuestNavigationEvent, url: string) => {
      refuseUnlessAllowed(event, event.url ?? url, "will-redirect", hasGesture);
    },
    // Electron hands this one a single details object carrying its own url,
    // not the `(event, url)` pair the other two use.
    "will-frame-navigate": (
      details: BrowserGuestNavigationEvent & { readonly url: string },
    ) => {
      refuseUnlessAllowed(
        details,
        details.url,
        "will-frame-navigate",
        hasGesture,
      );
    },
  };
}

/** {@link guestNavigationGuards} on a webContents that keeps no listener map. */
export function installGuestNavigationGuard(
  webContents: {
    on: NodeJS.EventEmitter["on"];
  },
  hasGesture: () => boolean,
): void {
  for (const [event, listener] of Object.entries(
    guestNavigationGuards(hasGesture),
  )) {
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
  hasGesture: () => boolean,
): void {
  if (isAllowedGuestNavigationUrl(url)) return;
  // Chromium must not load the target either way; a page-driven source (but not
  // a hidden subframe) additionally hands a real external scheme to the OS.
  event.preventDefault();
  if (isExternalRoutableSource(source)) {
    handleExternalGuestScheme(url, source, hasGesture());
    return;
  }
  traceRefusedGuestNavigation(url, source);
}
