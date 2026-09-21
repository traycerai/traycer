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
 * Deliberately height-free: the plugin's keyboard height is published as the
 * `--keyboard-inset` CSS variable instead, which the shell's safe-height tokens
 * animate with the keyboard, and which `readNativeKeyboardInsetPx` reads for
 * code that needs it as a number. The two are written together, the inset
 * first, so a listener here always reads the height that matches the state.
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

/**
 * Height, in CSS px, of the viewport strip the software keyboard covers, or 0
 * when nothing is covered.
 *
 * Read from `--keyboard-inset`, the one value the app's own layout subtracts
 * for the keyboard, so anything placed against the viewport lines up with it.
 * The native bridge writes it inline on the root element, and only in the
 * shell that overlays the keyboard (the installed iOS app), where it is the
 * plugin's reported height while open and 0 while closed. Android's OS resizes
 * the web view instead, so nothing is covered and the variable is never
 * written; nor is it in a browser or on desktop. An unset or unparsable value
 * reads 0.
 *
 * The inline style is read rather than the computed one because the bridge is
 * its only writer, and it keeps this a plain attribute read with no style
 * resolution. The value changes exactly when the state above does, so
 * `subscribeNativeKeyboardState` is the change signal for it. It moves at the
 * will- events, so for the length of a hide animation it reads 0 while the
 * keyboard is still sliding away - the same as the layout does.
 */
export function readNativeKeyboardInsetPx(): number {
  if (typeof document === "undefined") return 0;
  const parsed = Number.parseFloat(
    document.documentElement.style.getPropertyValue("--keyboard-inset"),
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
