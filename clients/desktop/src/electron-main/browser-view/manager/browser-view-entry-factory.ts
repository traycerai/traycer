import type { Event, Input, RenderProcessGoneDetails, Result } from "electron";
import type {
  BrowserViewElectronTabHandoffChange,
  BrowserViewStatus,
} from "@traycer-clients/shared/platform/browser-view";
import { log } from "../../app/logger";
import type {
  BrowserViewPopupWindow,
  ManagedBrowserView,
} from "../browser-view-port";
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
import type { BrowserViewGeometry } from "./browser-view-geometry";
import type { BrowserViewOverlay } from "./browser-view-overlay";
import type { BrowserViewPopups } from "./browser-view-popups";
import type { BrowserViewDebugSessions } from "./debug-session-for";

interface BrowserViewEntryFactoryOptions {
  readonly createView: () => ManagedBrowserView;
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly geometry: BrowserViewGeometry;
  readonly overlay: BrowserViewOverlay;
  readonly annotations: BrowserViewAnnotationHost;
  readonly find: BrowserViewFind;
  readonly popups: BrowserViewPopups;
  readonly chords: BrowserViewChords;
  readonly debugSessions: BrowserViewDebugSessions;
  readonly observePrimaryProfileOrigin: (
    url: string,
    webContents: ManagedBrowserView["webContents"],
  ) => void;
  readonly setStatus: (
    entry: BrowserViewEntry,
    status: BrowserViewStatus,
    reason: string | null,
  ) => void;
  readonly emitStatus: (entry: BrowserViewEntry) => void;
  readonly closeEntry: (
    entry: BrowserViewEntry,
    handoffReason: BrowserViewElectronTabHandoffChange["reason"] | null,
  ) => void;
}

/**
 * Builds one guest record and wires its `webContents` events to the modules
 * that care. Everything a guest can report on its own - navigation, title,
 * paint, popups, find results, crashes, reserved chords - is routed from here;
 * the coordinator only owns what a caller asks for.
 */
export class BrowserViewEntryFactory {
  private readonly createView: () => ManagedBrowserView;
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly geometry: BrowserViewGeometry;
  private readonly overlay: BrowserViewOverlay;
  private readonly annotations: BrowserViewAnnotationHost;
  private readonly find: BrowserViewFind;
  private readonly popups: BrowserViewPopups;
  private readonly chords: BrowserViewChords;
  private readonly debugSessions: BrowserViewDebugSessions;
  private readonly observePrimaryProfileOrigin: (
    url: string,
    webContents: ManagedBrowserView["webContents"],
  ) => void;
  private readonly setStatus: (
    entry: BrowserViewEntry,
    status: BrowserViewStatus,
    reason: string | null,
  ) => void;
  private readonly emitStatus: (entry: BrowserViewEntry) => void;
  private readonly closeEntry: (
    entry: BrowserViewEntry,
    handoffReason: BrowserViewElectronTabHandoffChange["reason"] | null,
  ) => void;

  constructor(options: BrowserViewEntryFactoryOptions) {
    this.createView = options.createView;
    this.entries = options.entries;
    this.geometry = options.geometry;
    this.overlay = options.overlay;
    this.annotations = options.annotations;
    this.find = options.find;
    this.popups = options.popups;
    this.chords = options.chords;
    this.debugSessions = options.debugSessions;
    this.observePrimaryProfileOrigin = options.observePrimaryProfileOrigin;
    this.setStatus = options.setStatus;
    this.emitStatus = options.emitStatus;
    this.closeEntry = options.closeEntry;
  }

  create(
    requestedUrl: string,
    identity: BrowserViewNativeIdentity,
  ): BrowserViewEntry {
    const view = this.createView();
    const entry: BrowserViewEntry = {
      surface: null,
      surfaceBindingId: null,
      guestKey: nativeGuestKey(identity.key),
      identity,
      view,
      listeners: {
        "before-input-event": (event: Event, input: Input): void => {
          this.handleBeforeInputEvent(entry, event, input);
        },
        "did-create-window": (window: BrowserViewPopupWindow): void => {
          this.popups.handleDidCreateWindow(entry, window);
        },
        "did-frame-finish-load": (): void => {
          if (entry.internalNavigation) return;
          this.overlay.invalidateSnapshot(entry, "frame-finish-load");
        },
        "did-finish-load": (): void => {
          if (entry.internalNavigation) return;
          this.overlay.invalidateSnapshot(entry, "finish-load");
        },
        "did-navigate": (_event: Event, url: string): void => {
          this.handleCommittedNavigation(entry, url);
        },
        "did-start-navigation": (
          _event: Event,
          _url: string,
          isInPlace: boolean,
          isMainFrame: boolean,
        ): void => {
          this.handleViewStartNavigation(entry, isInPlace, isMainFrame);
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
        "page-title-updated": (): void => {
          if (entry.internalNavigation) return;
          entry.currentTitle = entry.view.webContents.getTitle();
          this.overlay.invalidateSnapshot(entry, "page-title-updated");
          this.emitStatus(entry);
        },
        paint: (): void => {
          this.overlay.invalidateSnapshot(entry, "paint");
        },
        "render-process-gone": (
          _event: Event,
          details: RenderProcessGoneDetails,
        ): void => {
          this.handleRenderProcessGone(entry, details.reason);
        },
      },
      parentWindowId: null,
      desiredVisible: false,
      bounds: null,
      lastAppliedBounds: null,
      requestedUrl,
      currentUrl: requestedUrl,
      currentTitle: "",
      status: "loading",
      statusReason: null,
      findState: {
        appRequestId: 0,
        query: "",
        matchCase: false,
        sessionsByElectronRequestId: new Map(),
      },
      certificateError: null,
      debugSession: null,
      annotationSession: null,
      devToolsWindow: null,
      viewportPreset: "responsive",
      overlayOwnerIds: [],
      overlaySnapshotStale: false,
      overlayAwaitingPaintAck: false,
      overlayParked: false,
      visible: null,
      lastLoggedVisible: null,
      rendererResetPending: false,
      closePromise: null,
      internalNavigation: false,
    };
    const webContents = view.webContents;
    webContents.setWindowOpenHandler((details) =>
      this.popups.handleWindowOpen(entry, details),
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

  private handleCommittedNavigation(
    entry: BrowserViewEntry,
    url: string,
  ): void {
    if (entry.internalNavigation) return;
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.view.webContents.getTitle();
    this.observePrimaryProfileOrigin(url, entry.view.webContents);
    entry.certificateError = null;
    this.overlay.invalidateSnapshot(entry, "navigation-committed");
    this.setStatus(entry, "ready", null);
    void this.debugSessions
      .ensure(entry)
      .enableAfterCommit()
      .catch(() => undefined);
    this.geometry.applyVisibility(entry);
  }

  private handleInPageNavigation(
    entry: BrowserViewEntry,
    url: string,
    isMainFrame: boolean,
  ): void {
    if (entry.internalNavigation) return;
    if (!isMainFrame) return;
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.view.webContents.getTitle();
    this.observePrimaryProfileOrigin(url, entry.view.webContents);
    this.annotations.end(entry, "navigation");
    this.overlay.invalidateSnapshot(entry, "in-page-navigation");
    this.emitStatus(entry);
  }

  private handleRenderProcessGone(
    entry: BrowserViewEntry,
    detail: string,
  ): void {
    this.annotations.end(entry, "crash");
    this.overlay.invalidateSnapshot(entry, "render-process-gone");
    this.setStatus(entry, "dead", detail);
    this.geometry.applyVisibility(entry);
    this.closeEntry(entry, "crash-no-capture");
  }

  private handleBeforeInputEvent(
    entry: BrowserViewEntry,
    event: Event,
    input: Input,
  ): void {
    if (input.type !== "keyDown") return;
    const reserved = this.chords.match(input);
    if (reserved !== null) {
      event.preventDefault();
      this.chords.forwardToHostWindow(entry, reserved);
      return;
    }
    if (!(input.control || input.meta || input.shift || input.alt)) return;
    const step = browserZoomStepForKey(input.key);
    if (step === null) return;
    event.preventDefault();
    const factor = step === 0 ? 1 : steppedEntryZoom(entry, step);
    if (applyEntryZoom(entry, factor)) this.emitStatus(entry);
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
  entry.view.webContents.setZoomFactor(factor);
  return true;
}

export function steppedEntryZoom(
  entry: BrowserViewEntry,
  direction: 1 | -1,
): number {
  const current = entry.view.webContents.getZoomFactor();
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
