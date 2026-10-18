import { useLayoutEffect, useSyncExternalStore } from "react";

/**
 * The one fullscreen MCP App a window may show (plan §2.7, Overlay).
 *
 * Fullscreen sits in the top layer, above everything else in the window, so it
 * must never cover something the reader has to answer. Two rules hold that:
 *
 * - **Blockers.** While anything that needs the reader is up, no app may claim
 *   fullscreen - not the one that asked, not any other. A blocker is held for
 *   that UI's whole lifetime: an app's approval card or download confirm, a
 *   link confirm, a chat's pending approvals or agent question
 *   ({@link holdFullscreenBlocker}, {@link useFullscreenBlocker}), any dialog
 *   in the document, and focus in a composer. A claim made while one is up is
 *   refused, and a blocker that appears under a claim ends it.
 * - **One claim.** A second claim while one is held is refused, and the app
 *   that asked keeps its current mode.
 *
 * While it is fullscreen the row's transcript row is kept mounted by the
 * virtualized list ({@link useFullscreenPinnedRowKeys}): unmounting it would
 * destroy the app's document.
 */

export interface FullscreenClaim {
  /** Drops the app back to inline. Called when the claim is yielded. */
  readonly exit: () => void;
  /** The transcript row (message id) to keep mounted, if known. */
  readonly pinnedRowKey: string | null;
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

function dialogOpen(): boolean {
  return document.querySelector(OPEN_DIALOG_SELECTOR) !== null;
}

function composerFocused(): boolean {
  const active = document.activeElement;
  return active !== null && active.closest(COMPOSER_SELECTOR) !== null;
}

/** Whether something that needs the reader is up anywhere in the window. */
export function isFullscreenBlocked(): boolean {
  return blockers.size > 0 || dialogOpen() || composerFocused();
}

function watch(): () => void {
  const observer = new MutationObserver(() => {
    if (dialogOpen()) yieldFullscreen();
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
  if (current !== null || isFullscreenBlocked()) return false;
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
