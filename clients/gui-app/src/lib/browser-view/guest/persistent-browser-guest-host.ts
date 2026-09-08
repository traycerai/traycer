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
const OFFSCREEN_VIEWPORT_WIDTH_PX = 1280;
const OFFSCREEN_VIEWPORT_HEIGHT_PX = 800;
const OFFSCREEN_OFFSET_PX = 10_000;
const OFFSCREEN_CSS_TEXT = [
  "position: fixed",
  `inset-inline-start: -${OFFSCREEN_OFFSET_PX}px`,
  "inset-block-start: 0",
  `width: ${OFFSCREEN_VIEWPORT_WIDTH_PX}px`,
  `height: ${OFFSCREEN_VIEWPORT_HEIGHT_PX}px`,
  "opacity: 0",
  "pointer-events: none",
  "display: block",
].join(";");

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
  readonly hostElement: HTMLElement;
}

const guests = new Map<string, GuestRecord>();
const placements = new Map<string, PlacementRecord>();
let running: RunningHost | null = null;
let onActivate: BrowserGuestActivate | null = null;

/** Arm the window-level host; the returned disposer tears it down. */
export function startPersistentBrowserGuestHost(
  bridge: BrowserViewBridge,
  nextOnActivate: BrowserGuestActivate,
): () => void {
  onActivate = nextOnActivate;
  const hostElement = createHostElement();
  document.body.appendChild(hostElement);
  const mountSub = bridge.onGuestMountRequested(handleMount);
  const releaseSub = bridge.onGuestReleaseRequested(handleRelease);
  const host: RunningHost = { hostElement };
  running = host;
  return () => {
    if (running !== host) return;
    running = null;
    onActivate = null;
    mountSub.dispose();
    releaseSub.dispose();
    for (const registrationId of [...guests.keys()]) {
      removeGuest(registrationId);
    }
    hostElement.remove();
    // Live tile publishers still own `placements`; do not clear them here.
  };
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
  // The fragment is the grant correlation main actually receives
  // (`params.src`).
  webview.setAttribute("src", `${BLANK_GUEST_SRC}#${registrationId}`);
  webview.setAttribute("partition", partition);
  // GSI/OAuth open their sign-in window after async work, so Chromium only
  // creates it when the guest is allowed popups; main gesture-gates the open.
  webview.setAttribute("allowpopups", "");
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
  if (placement !== null && placement.presented) {
    applyGuestPosture(
      guest.wrapper,
      "presented",
      presentedCssText(guest.registrationId),
      placement,
    );
    return;
  }
  // Independently composited <webview> can leak under visibility:hidden, and
  // display:none stops it compositing altogether (CDP/PiP frames go blank).
  // Opacity makes one compositor group; the offscreen inset keeps it out of
  // the window even if that group still produces pixels. Retained and unbound
  // share that posture - only the state attribute differs.
  applyGuestPosture(
    guest.wrapper,
    placement === null ? "unbound" : "retained",
    OFFSCREEN_CSS_TEXT,
    null,
  );
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

function presentedCssText(registrationId: string): string {
  const anchorName = browserGuestCssAnchorName(registrationId);
  return [
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
}

function applyGuestPosture(
  wrapper: HTMLElement,
  state: "presented" | "retained" | "unbound",
  cssText: string,
  ownership: BrowserGuestTilePlacement | null,
): void {
  wrapper.style.cssText = cssText;
  wrapper.inert = ownership === null;
  wrapper.setAttribute(BROWSER_GUEST_STATE_ATTRIBUTE, state);
  if (ownership === null) {
    wrapper.setAttribute("aria-hidden", "true");
    clearHostedTileOwnership(wrapper);
    return;
  }
  wrapper.removeAttribute("aria-hidden");
  wrapper.setAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE, ownership.instanceId);
  wrapper.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, ownership.paneId);
  wrapper.setAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE, ownership.viewTabId);
}

function clearHostedTileOwnership(wrapper: HTMLElement): void {
  wrapper.removeAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE);
  wrapper.removeAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE);
  wrapper.removeAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE);
}
