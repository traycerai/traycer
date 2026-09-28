import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";

/**
 * `setInterval` that exists only while `isDocumentVisible()` is true.
 *
 * Desktop windows run with `backgroundThrottling: false`, which keeps Page
 * Visibility at `"visible"` through minimise. This helper therefore reads
 * `lib/dom/document-visibility.ts` (Page Visibility AND the shell's
 * on-screen bit) and never `document.hidden`.
 *
 * `fireOnShow` is a hide→show edge, not the initial start: today's
 * `setInterval` does not fire immediately, and a catch-up tick on first
 * subscribe would change every adopter's first frame.
 */

export interface VisibleIntervalOptions {
  readonly tick: () => void;
  readonly intervalMs: number;
  readonly fireOnShow: boolean;
}

let wakeups = 0;

export function startVisibleInterval(
  options: VisibleIntervalOptions,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  let intervalHandle: number | null = null;
  let seenHidden = false;
  let disposed = false;

  const start = (): void => {
    if (disposed || intervalHandle !== null) return;
    intervalHandle = window.setInterval(() => {
      wakeups += 1;
      options.tick();
    }, options.intervalMs);
  };

  const stop = (): void => {
    if (intervalHandle === null) return;
    window.clearInterval(intervalHandle);
    intervalHandle = null;
  };

  const apply = (): void => {
    if (disposed) return;
    if (isDocumentVisible()) {
      const shouldFireOnShow =
        options.fireOnShow && seenHidden && intervalHandle === null;
      start();
      if (shouldFireOnShow) {
        wakeups += 1;
        options.tick();
      }
      return;
    }
    seenHidden = true;
    stop();
  };

  apply();
  const unsubscribe = subscribeDocumentVisibility(apply);
  return () => {
    disposed = true;
    unsubscribe();
    stop();
  };
}

/** Interval callbacks plus `fireOnShow` ticks since the last test reset. */
export function __visibleIntervalWakeupsForTests(): number {
  return wakeups;
}

export function __resetVisibleIntervalWakeupsForTests(): void {
  wakeups = 0;
}
