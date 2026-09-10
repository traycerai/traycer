/**
 * Whether this WINDOW is on screen at all - minimized, fully occluded, or a
 * backgrounded browser tab all read `false`.
 *
 * `visibilityState`, deliberately, and NOT `document.hasFocus()`. Focus answers
 * a different question: a window the user can plainly see loses focus the
 * moment they click another app, and a signal that gates reclamation must never
 * fire for a window the user is looking at.
 *
 * A LEAF with no imports, because both consumers reach it from module scope and
 * one of them (`lib/epics/epic-parking.ts`) is itself imported by anything that
 * touches a chat - see the note there about keeping that graph small.
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

export function isDocumentVisible(): boolean {
  // A non-DOM environment (a node-run unit test, prerender) has no window to
  // hide, so the honest answer is visible - the alternative reports every epic
  // hidden and hands the reclamation clock a start it never earned.
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export function subscribeDocumentVisibility(listener: () => void): () => void {
  listeners.add(listener);
  install();
  return () => {
    listeners.delete(listener);
  };
}

function install(): void {
  if (installed) return;
  if (typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", () => {
    for (const listener of Array.from(listeners)) listener();
  });
}

/** Test seam: drop every subscriber without touching the DOM listener. */
export function __resetDocumentVisibilitySubscribersForTests(): void {
  listeners.clear();
}
