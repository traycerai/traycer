/**
 * The NATIVE shell's word on the soft keyboard, fed by the Capacitor entry point from the Keyboard plugin's will/did show/hide events - the same setter-before-render pattern as `setMobileApp`.
 */
export interface NativeKeyboardState {
  /** Keyboard is up (or animating up). Flips on will-show/will-hide. */
  readonly open: boolean;
  /**
   * A show/hide animation is in flight (between the will- and did- events).
   * Consumers that trigger expensive reflows on container resize wait for this to clear so they repaint once, at the settled size.
   */
  readonly transitioning: boolean;
}

let state: NativeKeyboardState = { open: false, transitioning: false };
const listeners = new Set<() => void>();

/** Fed exclusively by the native shell's keyboard bridge. */
export function setNativeKeyboardState(next: NativeKeyboardState): void {
  if (next.open === state.open && next.transitioning === state.transitioning) {
    return;
  }
  state = next;
  // Iterated over a copy so a listener unsubscribing mid-notify is safe.
  for (const listener of [...listeners]) listener();
}

export function getNativeKeyboardState(): NativeKeyboardState {
  return state;
}

export function subscribeNativeKeyboardState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Run `fn` once the keyboard is not mid-transition - immediately when it already isn't (the universal case outside the installed mobile app, where the state never leaves closed).
 * Returns a cancel; a cancelled callback never runs.
 */
export function runWhenNativeKeyboardSettled(fn: () => void): () => void {
  if (!state.transitioning) {
    fn();
    return () => {};
  }
  let cancelled = false;
  const unsubscribe = subscribeNativeKeyboardState(() => {
    if (cancelled || state.transitioning) return;
    unsubscribe();
    fn();
  });
  return () => {
    cancelled = true;
    unsubscribe();
  };
}
