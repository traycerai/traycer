/**
 * JS read of `:root` safe-area insets for libraries that take geometry as a value (Radix `collisionPadding`).
 * Cache; publish on resize.
 */
export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

let snapshot: SafeAreaInsets = NO_INSETS;
let current = false;
let watching = false;
const listeners = new Set<() => void>();

function readEdge(styles: CSSStyleDeclaration, edge: string): number {
  const parsed = Number.parseFloat(
    styles.getPropertyValue(`--safe-area-inset-${edge}`),
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameInsets(left: SafeAreaInsets, right: SafeAreaInsets): boolean {
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left
  );
}

function retire(): void {
  current = false;
  for (const listener of listeners) listener();
}

function watchViewport(): void {
  // Registered once for the life of the document, deliberately unremoved: the cache is module state with no owner to tear it down, and the handler only marks it stale.
  // Subscribers come and go through their own returned unsubscribe; this pair is the store itself.
  if (watching || typeof window === "undefined") return;
  window.addEventListener("resize", retire);
  window.addEventListener("orientationchange", retire);
  watching = true;
}

export function readSafeAreaInsets(): SafeAreaInsets {
  if (current) return snapshot;
  if (typeof window === "undefined") return NO_INSETS;
  watchViewport();
  const styles = window.getComputedStyle(document.documentElement);
  const next: SafeAreaInsets = {
    top: readEdge(styles, "top"),
    right: readEdge(styles, "right"),
    bottom: readEdge(styles, "bottom"),
    left: readEdge(styles, "left"),
  };
  if (!sameInsets(snapshot, next)) snapshot = next;
  current = true;
  return snapshot;
}

/**
 * Server snapshot for `useSyncExternalStore`.
 * A constant, so it is trivially reference-stable.
 */
export function readSafeAreaInsetsServerSnapshot(): SafeAreaInsets {
  return NO_INSETS;
}

export function subscribeToSafeAreaInsets(listener: () => void): () => void {
  watchViewport();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
