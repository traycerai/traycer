/**
 * Runtime read of the safe-area insets `index.css` declares on `:root`.
 *
 * CSS covers almost all of this app's safe-area handling - `#root` reserves
 * the top and horizontal insets, and the `safe-*` utility tokens carry the
 * rest - so reach for this ONLY where a number has to cross into JavaScript
 * because a library takes geometry as a value rather than as a style. Radix's
 * `collisionPadding` is the case it exists for: a floating surface collides
 * against the viewport, which includes the strips the app never paints into,
 * and no stylesheet can tell it otherwise.
 *
 * Cached rather than read per call. `getComputedStyle` is a forced style
 * resolution, and the call sites are on interaction paths that run often (a
 * tooltip resolves its padding on every open). The insets only move when the
 * viewport does, so a resize retires the cached value - orientation change
 * included, which is the one that actually changes them.
 *
 * Retirement is also PUBLISHED, not just recorded. A React consumer reads the
 * insets once and hands them to a library as a plain value; nothing about
 * nulling a cache would make that consumer read again, so a surface mounted in
 * portrait would keep portrait geometry across a rotation for as long as it
 * stays mounted. `subscribeToSafeAreaInsets` is what closes that, and it is
 * why the snapshot's identity is stable: `useSyncExternalStore` compares
 * snapshots by reference, so a fresh object per call would re-render forever.
 * A resize that leaves the insets unchanged keeps the previous object, so the
 * common case - a desktop window drag - notifies without re-rendering anyone.
 *
 * A value that cannot be parsed falls back to zero, the geometry of a device
 * with no inset at all. Failing in that direction degrades to exactly the
 * behaviour these call sites had before insets existed, rather than reserving
 * space on a device that has none.
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
  // Registered once for the life of the document, deliberately unremoved: the
  // cache is module state with no owner to tear it down, and the handler only
  // marks it stale. Subscribers come and go through their own returned
  // unsubscribe; this pair is the store itself.
  //
  // Reached from the read path as well as the subscribe path, because a
  // non-React caller has no subscription and would otherwise hold a value
  // across the rotation that invalidated it. Idempotent, so a `getSnapshot`
  // calling it mid-render - which React may do more than once - neither
  // duplicates the listeners nor changes what the read returns.
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
 * Server snapshot for `useSyncExternalStore`. A constant, so it is trivially
 * reference-stable.
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
