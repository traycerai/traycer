/**
 * Whether this WINDOW is on screen at all. Two inputs, AND-ed:
 *
 * 1. The Page Visibility API (`document.visibilityState`), which is what a
 *    plain browser tab hides on when it is backgrounded.
 * 2. The desktop shell's own answer for this window - shown and not
 *    minimised, as main sees it - pushed in through
 *    `lib/epics/desktop-window-visibility.ts`.
 *
 * Desktop keeps background throttling disabled for receiver callbacks/stats
 * (#1613) and transport keepalives: intensive timer throttling can delay a
 * heartbeat beyond its pong cutoff. DOM visibility therefore stays visible;
 * the second input supplies minimise/hide. Neither detects native occlusion.
 *
 * `visibilityState`, deliberately, and NOT `document.hasFocus()`. Focus answers
 * a different question: a window the user can plainly see loses focus the
 * moment they click another app, and a signal that gates reclamation must never
 * fire for a window the user is looking at.
 *
 * A LEAF with no imports, because both consumers reach it from module scope and
 * one of them (`lib/epics/epic-parking.ts`) is itself imported by anything that
 * touches a chat - see the note there about keeping that graph small. The
 * desktop input is therefore PUSHED in by a setter rather than read from the
 * bridge here.
 *
 * A single module-level listener rather than one per component: this is one
 * fact about the window, every reader wants the same answer, and per-component
 * listeners would multiply with the surfaces they are meant to describe.
 *
 * NOT folded into `setEpicSurfaceVisibility`'s set, which stays per-renderer
 * surface PLACEMENT. Composition happens at the two consumers that want the
 * conjunction; see the comment on that setter for why the difference matters.
 */
const listeners = new Set<() => void>();
let installed = false;
// `true` until the desktop shell says otherwise: in a plain browser there is no
// shell, and on the desktop a wrong "visible" only defers a reclaim, where a
// wrong "hidden" would park something the user is looking at.
let desktopWindowOnScreen = true;

export function isDocumentVisible(): boolean {
  return isBrowserDocumentVisible() && desktopWindowOnScreen;
}

function isBrowserDocumentVisible(): boolean {
  // A non-DOM environment (a node-run unit test, prerender) has no window to
  // hide, so the honest answer is visible - the alternative reports every epic
  // hidden and hands the reclamation clock a start it never earned.
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/**
 * The desktop shell's answer for this window. Notifies subscribers only on a
 * real change, so the same push twice is not two edges.
 */
export function setDesktopWindowOnScreen(onScreen: boolean): void {
  if (desktopWindowOnScreen === onScreen) return;
  desktopWindowOnScreen = onScreen;
  notify();
}

export function subscribeDocumentVisibility(listener: () => void): () => void {
  listeners.add(listener);
  install();
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

function install(): void {
  if (installed) return;
  if (typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", notify);
}

/**
 * Test seam: drop every subscriber and forget the desktop answer, without
 * touching the DOM listener.
 */
export function __resetDocumentVisibilitySubscribersForTests(): void {
  listeners.clear();
  desktopWindowOnScreen = true;
}

/**
 * Test seam: drive both Page Visibility inputs the helper and
 * `isDocumentVisible()` read. Dispatching `visibilitychange` is what the
 * module's DOM listener forwards to subscribers.
 */
export function __setBrowserDocumentHiddenForTests(hidden: boolean): void {
  if (typeof document === "undefined") return;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
