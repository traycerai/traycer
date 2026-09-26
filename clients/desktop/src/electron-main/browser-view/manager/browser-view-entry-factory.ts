import type { Event, Input, RenderProcessGoneDetails, Result } from "electron";
import type { BrowserViewStatus } from "@traycer-clients/shared/platform/browser-view";
import { log } from "../../app/logger";
import { guestNavigationGuards } from "../browser-guest-navigation";
import type { BrowserViewWebContents } from "../browser-view-port";
import type { BrowserSessionProfile } from "../browser-session";
import type { BrowserViewAnnotationHost } from "./browser-view-annotation-host";
import type { BrowserViewChords } from "./browser-view-chords";
import type {
  BrowserViewEntry,
  BrowserViewNativeIdentity,
} from "./browser-view-entry";
import {
  nativeBrowserViewGuestKey as nativeGuestKey,
  type BrowserViewEntryRegistry,
} from "./browser-view-entry-registry";
import type { BrowserViewFind } from "./browser-view-find";
import type { BrowserViewPopups } from "./browser-view-popups";

/** Chromium's `net::ERR_ABORTED`: the navigation was cancelled, not refused. */
const ERR_ABORTED = -3;

/** Bounded, single-line copy for a load failure the tile shows the user. */
function failedLoadReason(errorDescription: string): string {
  const description = errorDescription.trim();
  if (description === "") return "This page did not load";
  return `This page did not load (${description.slice(0, 80)})`;
}

interface BrowserViewEntryFactoryOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly annotations: BrowserViewAnnotationHost;
  readonly find: BrowserViewFind;
  readonly popups: BrowserViewPopups;
  readonly chords: BrowserViewChords;
  readonly observePrimaryProfileOrigin: (
    url: string,
    webContents: BrowserViewWebContents,
    profile: BrowserSessionProfile,
  ) => void;
  readonly setStatus: (
    entry: BrowserViewEntry,
    status: BrowserViewStatus,
    reason: string | null,
  ) => void;
  readonly emitStatus: (entry: BrowserViewEntry) => void;
  readonly requestZoom: (entry: BrowserViewEntry, factor: number) => void;
  readonly refreshViewport: (entry: BrowserViewEntry) => void;
  readonly emitFocus: (entry: BrowserViewEntry) => void;
  readonly closeEntry: (entry: BrowserViewEntry) => void;
}

/**
 * Builds one guest record and wires its `webContents` events to the modules
 * that care. Everything a guest can report on its own - navigation, title,
 * paint, popups, find results, crashes, reserved chords - is routed from here;
 * the coordinator only owns what a caller asks for.
 */
export class BrowserViewEntryFactory {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly annotations: BrowserViewAnnotationHost;
  private readonly find: BrowserViewFind;
  private readonly popups: BrowserViewPopups;
  private readonly chords: BrowserViewChords;
  private readonly observePrimaryProfileOrigin: (
    url: string,
    webContents: BrowserViewWebContents,
    profile: BrowserSessionProfile,
  ) => void;
  private readonly setStatus: (
    entry: BrowserViewEntry,
    status: BrowserViewStatus,
    reason: string | null,
  ) => void;
  private readonly emitStatus: (entry: BrowserViewEntry) => void;
  private readonly requestZoom: (
    entry: BrowserViewEntry,
    factor: number,
  ) => void;
  private readonly refreshViewport: (entry: BrowserViewEntry) => void;
  private readonly emitFocus: (entry: BrowserViewEntry) => void;
  private readonly closeEntry: (entry: BrowserViewEntry) => void;

  constructor(options: BrowserViewEntryFactoryOptions) {
    this.entries = options.entries;
    this.annotations = options.annotations;
    this.find = options.find;
    this.popups = options.popups;
    this.chords = options.chords;
    this.observePrimaryProfileOrigin = options.observePrimaryProfileOrigin;
    this.setStatus = options.setStatus;
    this.emitStatus = options.emitStatus;
    this.requestZoom = options.requestZoom;
    this.refreshViewport = options.refreshViewport;
    this.emitFocus = options.emitFocus;
    this.closeEntry = options.closeEntry;
  }

  createFromWebContents(
    requestedUrl: string,
    identity: BrowserViewNativeIdentity,
    profile: BrowserSessionProfile,
    webContents: BrowserViewWebContents,
  ): BrowserViewEntry {
    const entry: BrowserViewEntry = {
      surface: null,
      surfaceBindingId: null,
      guestKey: nativeGuestKey(identity.key),
      identity,
      profile,
      webContents,
      listeners: {
        "before-input-event": (event: Event, input: Input): void => {
          this.handleBeforeInputEvent(entry, event, input);
        },
        "did-navigate": (_event: Event, url: string): void => {
          this.handleCommittedNavigation(entry, url);
        },
        // The page-initiated half of the guest scheme gate (browser security
        // review, root cause C). `navigate` in the manager covers what this
        // process asks for; these cover what the page asks for on its own -
        // a link, a scripted `location =`, a server redirect, a subframe.
        ...guestNavigationGuards(() =>
          this.popups.hadRecentGuestGesture(webContents),
        ),
        "did-start-navigation": (
          _event: Event,
          _url: string,
          isInPlace: boolean,
          isMainFrame: boolean,
        ): void => {
          this.handleViewStartNavigation(entry, isInPlace, isMainFrame);
        },
        // Deliberately NOT `did-fail-load` - see `handleFailedLoad`.
        "did-fail-provisional-load": (
          _event: Event,
          errorCode: number,
          errorDescription: string,
          validatedUrl: string,
          isMainFrame: boolean,
        ): void => {
          this.handleFailedLoad(
            entry,
            errorCode,
            errorDescription,
            validatedUrl,
            isMainFrame,
          );
        },
        "did-navigate-in-page": (
          _event: Event,
          url: string,
          isMainFrame: boolean,
        ): void => {
          this.handleInPageNavigation(entry, url, isMainFrame);
        },
        "found-in-page": (_event: Event, result: Result): void => {
          this.find.handleFoundInPage(entry, result);
        },
        focus: (): void => {
          this.emitFocus(entry);
        },
        "page-title-updated": (): void => {
          if (entry.internalNavigation) return;
          entry.currentTitle = entry.webContents.getTitle();
          this.emitStatus(entry);
        },
        "render-process-gone": (
          _event: Event,
          details: RenderProcessGoneDetails,
        ): void => {
          this.handleRenderProcessGone(entry, details.reason);
        },
        destroyed: (): void => {
          this.closeEntry(entry);
        },
      },
      desiredVisible: false,
      requestedUrl,
      currentUrl: requestedUrl,
      currentTitle: "",
      status: "loading",
      statusReason: null,
      navigationAttempt: 0,
      findState: {
        appRequestId: 0,
        query: "",
        matchCase: false,
        sessionsByElectronRequestId: new Map(),
      },
      certificateError: null,
      debugSession: null,
      seedLease: null,
      agentCdpLease: null,
      annotationSession: null,
      devToolsWindow: null,
      rendererResetPending: false,
      closePromise: null,
      internalNavigation: false,
      succeededByReplacement: false,
    };
    this.popups.installGuestGesture(webContents);
    // The tile's opener context is a live view of the entry: read at open time,
    // so a `window.open` resolves against the tile's current location and
    // surface. A popup gets its own context installed by the popups module.
    webContents.setWindowOpenHandler((details) =>
      this.popups.handleWindowOpen(
        { surface: entry.surface, currentUrl: entry.currentUrl },
        details,
        webContents,
      ),
    );
    for (const [event, handler] of Object.entries(entry.listeners)) {
      webContents.on(event, handler);
    }
    this.entries.register(entry);
    log.info("[browser-view] view created", {
      guestKey: entry.guestKey,
    });
    return entry;
  }

  private handleViewStartNavigation(
    entry: BrowserViewEntry,
    isInPlace: boolean,
    isMainFrame: boolean,
  ): void {
    if (entry.internalNavigation) return;
    if (!isMainFrame || isInPlace) return;
    this.annotations.end(entry, "navigation");
  }

  /**
   * A main-frame navigation that ended on an error page. Without this, a
   * reload or a history move whose page fails (offline, DNS, a refused
   * connection) left the entry at `loading` for good - the `did-navigate`
   * settle only fires for a successful commit.
   *
   * Only `did-fail-provisional-load` is a settle, and it is treated exactly
   * like `did-navigate` - unconditionally for the current navigation. That
   * follows from the emitter, not the event's name or its docs. In Electron
   * 42.11.1 (`shell/browser/api/electron_api_web_contents.cc`,
   * `WebContents::DidFinishNavigation`): a navigation that never committed
   * - cancelled by a stop, a download, or a newer navigation superseding it
   * - returns before emitting ANYTHING, so a superseded navigation cannot
   * be mistaken for the current one; a navigation that committed an ERROR
   * PAGE emits `did-fail-provisional-load` and then, unless the code is
   * `ERR_ABORTED`, `did-fail-load` too. So the provisional event fires
   * exactly once per failed navigation, and Chromium only ever commits the
   * newest one.
   *
   * `did-fail-load` is deliberately not listened to: it doubles the
   * provisional event for the same navigation, and `WebContents::DidFailLoad`
   * also emits it for a COMMITTED document whose load was interrupted (the
   * page being left while still loading resources) - a false settle for the
   * navigation that interrupted it.
   *
   * `ERR_ABORTED` is ignored rather than settled. Today it never reaches
   * this event (an abort never commits); if a later Electron emits it here
   * for a cancelled navigation, ignoring it degrades to the stall surface
   * instead of reporting `ready` under a superseder still in flight.
   */
  private handleFailedLoad(
    entry: BrowserViewEntry,
    errorCode: number,
    errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean,
  ): void {
    if (entry.internalNavigation) return;
    if (!isMainFrame) return;
    if (!entry.identity.lifecycle.accepted) return;
    if (entry.status !== "loading") return;
    if (errorCode === ERR_ABORTED) return;
    // The guest is now showing Chromium's error page FOR this url, so the
    // entry follows it exactly as a successful commit would - otherwise the
    // toolbar and the host's tab state keep naming the page that was left.
    entry.currentUrl = validatedUrl;
    entry.requestedUrl = validatedUrl;
    entry.currentTitle = entry.webContents.getTitle();
    this.setStatus(entry, "ready", failedLoadReason(errorDescription));
  }

  private handleCommittedNavigation(
    entry: BrowserViewEntry,
    url: string,
  ): void {
    if (entry.internalNavigation) return;
    // The renderer-owned guest is born at `about:blank`, and that birth
    // navigation commits on this listener after the entry already carries the
    // host's intended `requestedUrl`. Recording it here would overwrite that
    // intent with `about:blank`, so the accepted initial navigation would then
    // load `about:blank` and the tile would hang. Guest-driven navigations
    // only count once the host has accepted the tab and issued its intended
    // navigation.
    if (!entry.identity.lifecycle.accepted) return;
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.webContents.getTitle();
    this.observePrimaryProfileOrigin(url, entry.webContents, entry.profile);
    entry.certificateError = null;
    // Agent/CDP navigation does not pass through navigate(), so the entry may
    // already be ready. Publish the committed URL even without a later title
    // event (an untitled page may never emit one).
    if (entry.status === "ready" && entry.statusReason === null) {
      this.emitStatus(entry);
    } else {
      this.setStatus(entry, "ready", null);
    }
    this.refreshViewport(entry);
    // Recovery for a tab something is driving - never an attach of its own.
    void entry.debugSession?.enableWhileLeased().catch(() => undefined);
  }

  private handleInPageNavigation(
    entry: BrowserViewEntry,
    url: string,
    isMainFrame: boolean,
  ): void {
    if (entry.internalNavigation) return;
    if (!isMainFrame) return;
    // See handleCommittedNavigation: a pre-acceptance guest navigation must not
    // overwrite the host's intended initial URL.
    if (!entry.identity.lifecycle.accepted) return;
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.webContents.getTitle();
    this.observePrimaryProfileOrigin(url, entry.webContents, entry.profile);
    this.annotations.end(entry, "navigation");
    // A same-document navigation is a settle too. Back/forward between two
    // pushState history entries (any Turbo-style app: GitHub, for one) fires
    // `did-start-navigation` + `did-navigate-in-page` and never
    // `did-navigate`, so a history move that set `loading` would otherwise
    // never return to `ready` and the tile's loader would sit over a live
    // page for good. `setStatus` dedupes on an unchanged status, so the
    // already-ready case (an ordinary pushState / hash change) still has to
    // publish the new url/title/history readings through a bare emit.
    if (entry.status !== "ready" || entry.statusReason !== null) {
      this.setStatus(entry, "ready", null);
      return;
    }
    this.emitStatus(entry);
  }

  private handleRenderProcessGone(
    entry: BrowserViewEntry,
    detail: string,
  ): void {
    this.annotations.end(entry, "crash");
    // A crashed guest is reported as a plain `dead` tab status and its
    // renderer guest is released. There is nothing to capture from a gone
    // renderer and nothing to hand off - the host re-materializes the durable
    // tab later.
    this.setStatus(entry, "dead", detail);
    this.closeEntry(entry);
  }

  private handleBeforeInputEvent(
    entry: BrowserViewEntry,
    event: Event,
    input: Input,
  ): void {
    if (input.type !== "keyDown") return;
    // The guest seam runs BEFORE the macOS app-menu accelerator and is the
    // only place in the chain that knows a browser tile has focus, so the
    // whole focus-scoped input policy is decided here. `preventDefault` is
    // what stops a menu equivalent (Cmd+W's "Close Tab") from also firing.
    // The guest's OWN window decides the policy: each renderer registers a
    // table derived from its own surface state, and this seam is the only
    // place that knows which window's guest has focus.
    const reserved = this.chords.match(entry.surface?.windowId ?? null, input);
    if (reserved !== null) {
      event.preventDefault();
      // Every reserved chord is one-shot - holding Cmd+T at ~25 Hz would open
      // (and split for) a tab per repeat - but the repeat is still CLAIMED
      // above, or it walks straight into the menu equivalent while the first
      // press's asynchronous close is still in flight.
      if (!input.isAutoRepeat) this.chords.dispatch(entry.surface, reserved);
      return;
    }
    if (!(input.control || input.meta || input.shift || input.alt)) return;
    const step = browserZoomStepForKey(input.key);
    if (step === null) return;
    event.preventDefault();
    const factor = step === 0 ? 1 : steppedEntryZoom(entry, step);
    this.requestZoom(entry, factor);
  }
}

/**
 * Applies a zoom factor unless an annotation session has the page pinned
 * (its overlay geometry is computed in page pixels). Reports whether the guest
 * actually changed, so the caller knows whether to re-emit status.
 */
export function applyEntryZoom(
  entry: BrowserViewEntry,
  factor: number,
): boolean {
  if (entry.annotationSession?.zoomLocked() === true) return false;
  entry.webContents.setZoomFactor(factor);
  return true;
}

export function steppedEntryZoom(
  entry: BrowserViewEntry,
  direction: 1 | -1,
): number {
  const current = entry.webContents.getZoomFactor();
  if (direction === 1) {
    return (
      BROWSER_ZOOM_FACTORS.find((factor) => factor > current + 0.001) ??
      BROWSER_ZOOM_FACTORS[BROWSER_ZOOM_FACTORS.length - 1]
    );
  }
  const previous = BROWSER_ZOOM_FACTORS.slice()
    .reverse()
    .find((factor) => factor < current - 0.001);
  return previous ?? BROWSER_ZOOM_FACTORS[0];
}

function browserZoomStepForKey(key: string): 1 | -1 | 0 | null {
  if (key === "+" || key === "=") return 1;
  if (key === "-" || key === "_") return -1;
  if (key === "0" || key === ")") return 0;
  return null;
}

const BROWSER_ZOOM_FACTORS: readonly number[] = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];
