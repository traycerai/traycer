import type {
  BrowserViewBridge,
  BrowserViewGuestMountRequested,
  BrowserViewGuestReleaseRequested,
} from "@traycer-clients/shared/platform/browser-view";
import { runPresentationLossBlur } from "@/components/epic-tabs/pane-visibility-context";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";

const PERSISTENT_BROWSER_GUEST_HOST_TEST_ID = "persistent-browser-guest-host";
const BROWSER_GUEST_REGISTRATION_ATTRIBUTE = "data-browser-guest-registration";
const BROWSER_GUEST_STATE_ATTRIBUTE = "data-browser-guest-state";

export interface BrowserGuestActivateEvent {
  readonly defaultPrevented: boolean;
  readonly scope: EventTarget | null;
  readonly target: EventTarget | null;
}

type BrowserGuestActivateHandler = (
  viewTabId: string,
  paneId: string,
  event: BrowserGuestActivateEvent,
) => void;

export interface BrowserGuestActivate {
  readonly pointerDown: BrowserGuestActivateHandler;
  readonly focus: BrowserGuestActivateHandler;
}

export interface BrowserGuestTilePlacement {
  readonly registrationId: string;
  readonly instanceId: string;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly presented: boolean;
}

export function browserGuestCssAnchorName(registrationId: string): string {
  return `--traycer-bv-${registrationId}`;
}

const BLANK_GUEST_SRC = "about:blank";
const UNBOUND_VIEWPORT_WIDTH_PX = 1280;
const UNBOUND_VIEWPORT_HEIGHT_PX = 800;
const UNBOUND_OFFSET_PX = 10_000;

interface PlacementRecord {
  readonly owner: symbol;
  readonly placement: BrowserGuestTilePlacement;
}

interface GuestRecord {
  readonly registrationId: string;
  readonly wrapper: HTMLElement;
  readonly webview: HTMLElement;
}

interface RunningHost {
  readonly disposeMount: () => void;
  readonly disposeRelease: () => void;
  readonly hostElement: HTMLElement;
}

const guests = new Map<string, GuestRecord>();
const placements = new Map<string, PlacementRecord>();
let running: RunningHost | null = null;
let onActivate: BrowserGuestActivate | null = null;

/**
 * Arm the window-level host. Idempotent while already running: later
 * calls only replace the activate callbacks. The React owner returns
 * `stopPersistentBrowserGuestHost` from its layout effect so unmount
 * and bridge replacement tear down and resubscribe.
 */
export function startPersistentBrowserGuestHost(
  bridge: BrowserViewBridge,
  nextOnActivate: BrowserGuestActivate | null,
): void {
  onActivate = nextOnActivate;
  if (running !== null) return;
  const body = document.body;
  const hostElement = createHostElement();
  body.appendChild(hostElement);
  const mountSub = bridge.onGuestMountRequested(handleMount);
  const releaseSub = bridge.onGuestReleaseRequested(handleRelease);
  running = {
    disposeMount: mountSub.dispose,
    disposeRelease: releaseSub.dispose,
    hostElement,
  };
}

export function stopPersistentBrowserGuestHost(): void {
  const current = running;
  running = null;
  onActivate = null;
  if (current === null) return;
  current.disposeMount();
  current.disposeRelease();
  for (const registrationId of [...guests.keys()]) {
    removeGuest(registrationId);
  }
  current.hostElement.remove();
  // Live tile publishers still own `placements`; do not clear them here.
}

export function setBrowserGuestTilePlacement(
  owner: symbol,
  placement: BrowserGuestTilePlacement,
): void {
  placements.set(placement.registrationId, { owner, placement });
  const guest = guests.get(placement.registrationId);
  if (guest !== undefined) applyGuestPresentation(guest, placement);
}

export function clearBrowserGuestTilePlacement(
  owner: symbol,
  registrationId: string,
): void {
  const current = placements.get(registrationId);
  if (current === undefined || current.owner !== owner) return;
  placements.delete(registrationId);
  const guest = guests.get(registrationId);
  if (guest !== undefined) applyGuestPresentation(guest, null);
}

function handleMount(request: BrowserViewGuestMountRequested): void {
  if (running === null || guests.has(request.registrationId)) return;
  const wrapper = document.createElement("div");
  wrapper.setAttribute(
    BROWSER_GUEST_REGISTRATION_ATTRIBUTE,
    request.registrationId,
  );
  const webview = createGuestWebview(request.registrationId, request.partition);
  wrapper.appendChild(webview);
  running.hostElement.appendChild(wrapper);
  const guest: GuestRecord = {
    registrationId: request.registrationId,
    wrapper,
    webview,
  };
  guests.set(request.registrationId, guest);
  wrapper.addEventListener(
    "pointerdown",
    (event) => {
      handleGuestPointerDown(guest, event);
    },
    true,
  );
  wrapper.addEventListener(
    "focus",
    (event) => {
      handleGuestFocus(guest, event);
    },
    true,
  );
  applyGuestPresentation(
    guest,
    placements.get(request.registrationId)?.placement ?? null,
  );
}

function handleRelease(request: BrowserViewGuestReleaseRequested): void {
  removeGuest(request.registrationId);
}

function removeGuest(registrationId: string): void {
  const guest = guests.get(registrationId);
  if (guest === undefined) return;
  guests.delete(registrationId);
  relinquishGuestFocus(guest);
  guest.wrapper.remove();
}

function handleGuestPointerDown(guest: GuestRecord, event: Event): void {
  const placement = placements.get(guest.registrationId)?.placement;
  if (placement === undefined || !placement.presented) return;
  onActivate?.pointerDown(placement.viewTabId, placement.paneId, {
    defaultPrevented: event.defaultPrevented,
    scope: guest.wrapper,
    target: event.target,
  });
}

function handleGuestFocus(guest: GuestRecord, event: Event): void {
  const placement = placements.get(guest.registrationId)?.placement;
  if (placement === undefined || !placement.presented) return;
  onActivate?.focus(placement.viewTabId, placement.paneId, {
    defaultPrevented: event.defaultPrevented,
    scope: guest.wrapper,
    target: event.target,
  });
}

function createHostElement(): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-testid", PERSISTENT_BROWSER_GUEST_HOST_TEST_ID);
  element.style.position = "fixed";
  element.style.inset = "0px";
  element.style.pointerEvents = "none";
  element.style.zIndex = "0";
  return element;
}

function createGuestWebview(
  registrationId: string,
  partition: string,
): HTMLElement {
  const webview = document.createElement("webview");
  // Electron 42.11 does not forward the `name` attribute to
  // `will-attach-webview`. The fragment is the grant correlation main
  // actually receives (`params.src`). Keep `name` for a later Electron
  // that restores it.
  webview.setAttribute("src", `${BLANK_GUEST_SRC}#${registrationId}`);
  webview.setAttribute("partition", partition);
  webview.setAttribute("name", registrationId);
  webview.style.display = "flex";
  webview.style.width = "100%";
  webview.style.height = "100%";
  webview.style.border = "none";
  return webview;
}

function applyGuestPresentation(
  guest: GuestRecord,
  placement: BrowserGuestTilePlacement | null,
): void {
  const nextPresented = placement !== null && placement.presented;
  if (
    guest.wrapper.getAttribute(BROWSER_GUEST_STATE_ATTRIBUTE) === "presented" &&
    !nextPresented
  ) {
    relinquishGuestFocus(guest);
  }
  if (placement === null) {
    applyUnbound(guest.wrapper);
    return;
  }
  if (placement.presented) {
    applyPresented(guest, placement);
    return;
  }
  applyRetained(guest.wrapper);
}

function relinquishGuestFocus(guest: GuestRecord): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !guest.wrapper.contains(active)) {
    return;
  }
  runPresentationLossBlur(() => {
    active.blur();
  });
}

function applyPresented(
  guest: GuestRecord,
  placement: BrowserGuestTilePlacement,
): void {
  const anchorName = browserGuestCssAnchorName(guest.registrationId);
  const { wrapper } = guest;
  wrapper.style.cssText = [
    "position: fixed",
    `position-anchor: ${anchorName}`,
    `top: anchor(${anchorName} top)`,
    `left: anchor(${anchorName} left)`,
    `width: anchor-size(${anchorName} width)`,
    `height: anchor-size(${anchorName} height)`,
    "opacity: 1",
    "pointer-events: auto",
    "display: block",
  ].join(";");
  wrapper.inert = false;
  wrapper.removeAttribute("aria-hidden");
  wrapper.setAttribute(BROWSER_GUEST_STATE_ATTRIBUTE, "presented");
  wrapper.setAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE, placement.instanceId);
  wrapper.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, placement.paneId);
  wrapper.setAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE, placement.viewTabId);
}

function applyRetained(wrapper: HTMLElement): void {
  wrapper.style.cssText = "display: none; pointer-events: none; opacity: 0";
  wrapper.inert = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.setAttribute(BROWSER_GUEST_STATE_ATTRIBUTE, "retained");
  clearHostedTileOwnership(wrapper);
}

function applyUnbound(wrapper: HTMLElement): void {
  // Independently composited <webview> can leak under visibility:hidden.
  // Opacity makes one compositor group; the offscreen inset keeps it
  // out of the window even if that group still produces pixels.
  wrapper.style.cssText = [
    "position: fixed",
    `inset-inline-start: -${UNBOUND_OFFSET_PX}px`,
    "inset-block-start: 0",
    `width: ${UNBOUND_VIEWPORT_WIDTH_PX}px`,
    `height: ${UNBOUND_VIEWPORT_HEIGHT_PX}px`,
    "opacity: 0",
    "pointer-events: none",
    "display: block",
  ].join(";");
  wrapper.inert = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.setAttribute(BROWSER_GUEST_STATE_ATTRIBUTE, "unbound");
  clearHostedTileOwnership(wrapper);
}

function clearHostedTileOwnership(wrapper: HTMLElement): void {
  wrapper.removeAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE);
  wrapper.removeAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE);
  wrapper.removeAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE);
}
