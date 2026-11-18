/**
 * Whether this WINDOW can be seen, from two inputs:
 *
 * 1. The Page Visibility API (`document.visibilityState`), which is what a
 *    plain browser tab hides on when it is backgrounded.
 * 2. The desktop shell's own answer for this window - shown and not
 *    minimised, as main sees it - pushed in through
 *    `lib/epics/desktop-window-visibility.ts`.
 *
 * Desktop windows are background-throttled, so the first input reports a
 * minimised or hidden window as `"hidden"` there too, and a covered one on
 * macOS. Electron updates it on occlusion only there: on Windows and Linux a
 * covered window stays `"visible"` until it is minimised or hidden. While a
 * browser tile's WebRTC video plane keeps throttling off (#1613,
 * `lib/browser-view/tiles/desktop-background-rendering.ts`), DOM visibility
 * stays visible and only main can still report minimise/hide.
 *
 * Two questions, so two answers:
 *
 * - {@link isDocumentVisible} - is anything here worth painting or polling?
 *   Both inputs AND-ed, so a covered macOS window stops animating and polling.
 * - {@link isWindowOnScreen} - may this window still claim the host state its
 *   tasks hold (renderer parking and the cross-window report)? On the desktop
 *   that is main's answer ALONE: a window the user has only covered with
 *   another app is a window they are switching back to, and parking it makes
 *   every return re-open its tasks on the host. Before the shell reports (a
 *   plain browser, an older preload) it is the Page Visibility API.
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
 * A single module-level listener rather than one per component: these are facts
 * about the window, every reader of one question wants the same answer, and
 * per-component listeners would multiply with the surfaces they are meant to
 * describe. Subscribers hear an edge of EITHER input and re-read the answer
 * they use.
 *
 * NOT folded into `setEpicSurfaceVisibility`'s set, which stays per-renderer
 * surface PLACEMENT. Composition happens at the two consumers that combine the
 * window with placement; see the comment on that setter for why the difference
 * matters.
 */
const listeners = new Set<() => void>();
let installed = false;
// `true` until the desktop shell says otherwise: in a plain browser there is no
// shell, and on the desktop a wrong "visible" only defers a reclaim, where a
// wrong "hidden" would park something the user is looking at.
let desktopWindowOnScreen = true;
// Whether the desktop shell is reporting `desktopWindowOnScreen` for this
// window at all. Until it is, the default `true` above is not an answer, so
// `isWindowOnScreen` falls back to the Page Visibility API.
let desktopShellReporting = false;

export function isDocumentVisible(): boolean {
  return isBrowserDocumentVisible() && desktopWindowOnScreen;
}

export function isWindowOnScreen(): boolean {
  return desktopShellReporting
    ? desktopWindowOnScreen
    : isBrowserDocumentVisible();
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

/**
 * Whether the desktop shell reports this window's on-screen state, which makes
 * its answer the only input to {@link isWindowOnScreen}. Set once the bridge
 * has delivered its first answer, cleared on teardown. Notifies only on a real
 * change.
 */
export function setDesktopWindowOnScreenReporting(reporting: boolean): void {
  if (desktopShellReporting === reporting) return;
  desktopShellReporting = reporting;
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
  desktopShellReporting = false;
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
