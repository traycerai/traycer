/**
 * The NATIVE shell's word on the soft keyboard, fed by the Capacitor entry
 * point from the Keyboard plugin's will/did show/hide events - the same
 * setter-before-render pattern as `setMobileApp`. Browser-safe: nothing here
 * imports Capacitor, and in a plain browser tab (or on desktop) the state
 * simply never leaves its closed default.
 *
 * Why this exists: the mobile app runs the keyboard in overlay mode
 * (`resize: none`), so the webview is never resized for it and the
 * visualViewport-derived inset (`useVirtualKeyboardInset`) measures 0 the whole
 * time the keyboard is up. Anything that needs "is the keyboard open?" as a fact -
 * the terminal key bar dropping its home-indicator padding, the terminal
 * deferring its PTY re-grid until the show/hide transition settles - was
 * reading a signal that could never fire. The plugin events are the only
 * authoritative source in that mode, and they arrive BEFORE the animation
 * starts, which the measured inset never could.
 *
 * Deliberately height-free: the plugin's keyboard height belongs to the
 * animated-inset work (which needs it alongside the animation's duration and
 * curve), and publishing it here before anything consumes it invites reading
 * a value that is wrong for half the transition - at will-hide the keyboard
 * still fills its full height while "0" would already be published.
 */
export interface NativeKeyboardState {
  /** Keyboard is up (or animating up). Flips on will-show/will-hide. */
  readonly open: boolean;
  /**
   * A show/hide animation is in flight (between the will- and did- events).
   * Consumers that trigger expensive reflows on container resize wait for
   * this to clear so they repaint once, at the settled size.
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
 * Run `fn` once the keyboard is not mid-transition - immediately when it
 * already isn't (the universal case outside the installed mobile app, where
 * the state never leaves closed). Returns a cancel; a cancelled callback
 * never runs.
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
