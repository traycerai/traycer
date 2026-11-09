import { useLayoutEffect, useSyncExternalStore } from "react";

/**
 * The one top-layer surface a window may show: a fullscreen MCP App, or an
 * expanded artifact (`components/artifacts/artifact-expansion.tsx`).
 *
 * The top layer paints above everything else in the window, so it must never
 * cover something the reader has to answer. Two rules hold that:
 *
 * - **Blockers.** While anything that needs the reader is up, nothing may
 *   claim the top layer - not the surface that asked, not any other. A blocker
 *   is held for that UI's whole lifetime: an app's approval card or download
 *   confirm, a link confirm, a chat's pending approvals or agent question
 *   ({@link holdFullscreenBlocker}, {@link useFullscreenBlocker}), any dialog
 *   outside the claimant's own surface, and focus in a composer. A claim made
 *   while one is up is refused, and a blocker that appears under a claim ends
 *   it.
 * - **One claim.** A second claim while one is held is refused, and the
 *   surface that asked keeps its current mode. So two artifacts, or an
 *   artifact and an app, can never be expanded at once.
 *
 * While the claim is held the transcript row behind it is kept mounted by the
 * virtualized list ({@link useFullscreenPinnedRowKeys}): unmounting it would
 * destroy the app's document, and would take an expanded artifact's surface
 * down with its row.
 */

export interface FullscreenClaim {
  /** Drops the surface back to inline. Called when the claim is yielded. */
  readonly exit: () => void;
  /** The transcript row (message id) to keep mounted, if known. */
  readonly pinnedRowKey: string | null;
  /**
   * The claimant's own surface, for a claimant whose nested UI reads as a
   * blocker of it. An expanded artifact raises the reader's own layers INSIDE
   * its surface - the canvas Pages popover, a menu from a control in its
   * toolbar - and a Radix popover carries `role="dialog"` like any other layer
   * of that family, so without this the first press of Pages would collapse
   * the artifact it was listing. A dialog inside the surface is the claimant's
   * own nested UI; `contains` counts the surface element itself too, which
   * also keeps the answer independent of whether the claimant has rendered the
   * surface it is claiming for.
   *
   * `null` when nothing about the surface is exempt, which is the stricter
   * answer: an MCP app's approval card is a SIBLING of its surface, so the app
   * passes `null` and every dialog in the document keeps blocking it.
   */
  readonly surface: (() => HTMLElement | null) | null;
}

/** A dialog that is on screen: a closed one some primitives keep mounted is not. */
const OPEN_DIALOG_SELECTOR = [
  '[role="dialog"]:not([hidden]):not([data-state="closed"])',
  '[role="alertdialog"]:not([hidden]):not([data-state="closed"])',
].join(", ");
const COMPOSER_SELECTOR = "[data-composer-editor]";
const NO_PINNED_ROWS: readonly string[] = [];

let current: FullscreenClaim | null = null;
let pinnedRowKeys: readonly string[] = NO_PINNED_ROWS;
let stopWatching: (() => void) | null = null;
const blockers = new Set<object>();
const listeners = new Set<() => void>();

function emit(): void {
  const key = current?.pinnedRowKey ?? null;
  pinnedRowKeys = key === null ? NO_PINNED_ROWS : [key];
  for (const listener of listeners) listener();
}

/** An open dialog that `surface` does not contain. `contains` counts itself. */
function dialogOpenOutside(surface: HTMLElement | null): boolean {
  if (surface === null) {
    return document.querySelector(OPEN_DIALOG_SELECTOR) !== null;
  }
  return Array.from(document.querySelectorAll(OPEN_DIALOG_SELECTOR)).some(
    (dialog) => !surface.contains(dialog),
  );
}

function composerFocused(): boolean {
  const active = document.activeElement;
  return active !== null && active.closest(COMPOSER_SELECTOR) !== null;
}

/**
 * Whether something that needs the reader is up, counting neither `surface`
 * itself nor a dialog inside it ({@link FullscreenClaim.surface}). Blockers
 * and composer focus are never exempted: both are raised outside any
 * claimant's surface, so scoping them would drop a real block.
 *
 * Module-private: a claimant states its surface on the claim and this answers
 * for it, both here and in the watch below.
 */
function isFullscreenBlockedOutside(surface: HTMLElement | null): boolean {
  return blockers.size > 0 || dialogOpenOutside(surface) || composerFocused();
}

/** Whether something that needs the reader is up anywhere in the window. */
export function isFullscreenBlocked(): boolean {
  return isFullscreenBlockedOutside(null);
}

function surfaceOf(claim: FullscreenClaim): HTMLElement | null {
  return claim.surface?.() ?? null;
}

function watch(): () => void {
  const observer = new MutationObserver(() => {
    const claim = current;
    if (claim === null) return;
    if (dialogOpenOutside(surfaceOf(claim))) yieldFullscreen();
  });
  // `role` and `data-state` too: a primitive may open a mounted dialog in
  // place rather than adding a node.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["role", "hidden", "data-state"],
  });
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (target instanceof Element && target.closest(COMPOSER_SELECTOR)) {
      yieldFullscreen();
    }
  };
  document.addEventListener("focusin", onFocusIn, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", onFocusIn, true);
  };
}

/**
 * `true` when the claim now holds fullscreen; `false` when another does or
 * something that needs the reader is up.
 */
export function claimFullscreen(claim: FullscreenClaim): boolean {
  if (current === claim) return true;
  // Scoped, so the answer does not depend on whether the claimant has already
  // rendered the surface it is claiming for.
  if (current !== null || isFullscreenBlockedOutside(surfaceOf(claim))) {
    return false;
  }
  current = claim;
  stopWatching = watch();
  emit();
  return true;
}

/** The claim's holder left fullscreen itself (or unmounted). */
export function releaseFullscreen(claim: FullscreenClaim): void {
  if (current !== claim) return;
  current = null;
  stopWatching?.();
  stopWatching = null;
  emit();
}

/** Something needs the reader: whichever app is fullscreen drops to inline. */
export function yieldFullscreen(): void {
  const claim = current;
  if (claim === null) return;
  releaseFullscreen(claim);
  claim.exit();
}

/**
 * Hold fullscreen off until the returned release runs: any claim ends now and
 * none is admitted meanwhile. Releasing twice is harmless.
 */
export function holdFullscreenBlocker(): () => void {
  const token = {};
  blockers.add(token);
  yieldFullscreen();
  return () => {
    blockers.delete(token);
  };
}

/** Holds a blocker for as long as `needsReader` is true. */
export function useFullscreenBlocker(needsReader: boolean): void {
  // Layout, not passive: the block starts in the commit that shows the UI.
  useLayoutEffect(() => {
    if (!needsReader) return;
    return holdFullscreenBlocker();
  }, [needsReader]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPinnedRowKeys(): readonly string[] {
  return pinnedRowKeys;
}

/** The transcript rows the list must keep mounted. Stable while unchanged. */
export function useFullscreenPinnedRowKeys(): readonly string[] {
  return useSyncExternalStore(subscribe, getPinnedRowKeys, getPinnedRowKeys);
}
