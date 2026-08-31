import { Keyboard } from "@capacitor/keyboard";
import { setNativeKeyboardState } from "@traycer-clients/gui-app";

/**
 * Feeds gui-app's native keyboard state from the Capacitor Keyboard plugin's
 * will/did show/hide events - the only authoritative "keyboard is open"
 * signal under `resize: native`, where the webview is shrunk so the
 * visualViewport-derived inset gui-app falls back to measures 0 the whole
 * time the keyboard is up.
 *
 * `transitioning` spans will-show..did-show and will-hide..did-hide; gui-app
 * consumers (the terminal's PTY re-grid) wait it out so they reflow once at
 * the settled size. The watchdog below force-settles in case a did- event is
 * dropped (backgrounding mid-animation, plugin hiccup): a state stuck
 * "transitioning" would hold the terminal's resize forever, which is worse
 * than one mid-animation repaint.
 */
const TRANSITION_WATCHDOG_MS = 700;

let started = false;
let watchdog: number | null = null;

function settle(open: boolean): void {
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  setNativeKeyboardState({ open, transitioning: false });
}

function transition(open: boolean): void {
  setNativeKeyboardState({ open, transitioning: true });
  if (watchdog !== null) clearTimeout(watchdog);
  watchdog = window.setTimeout(() => {
    watchdog = null;
    setNativeKeyboardState({ open, transitioning: false });
  }, TRANSITION_WATCHDOG_MS);
}

function warnListenerAttachFailure(event: string): (error: unknown) => void {
  return (error: unknown) => {
    console.error(`[kbd] ${event} listener failed to attach`, error);
  };
}

export function startNativeKeyboardBridge(): void {
  if (started) return;
  started = true;
  Keyboard.addListener("keyboardWillShow", () => {
    transition(true);
  }).catch(warnListenerAttachFailure("keyboardWillShow"));
  Keyboard.addListener("keyboardDidShow", () => {
    settle(true);
  }).catch(warnListenerAttachFailure("keyboardDidShow"));
  Keyboard.addListener("keyboardWillHide", () => {
    transition(false);
  }).catch(warnListenerAttachFailure("keyboardWillHide"));
  Keyboard.addListener("keyboardDidHide", () => {
    settle(false);
  }).catch(warnListenerAttachFailure("keyboardDidHide"));
}
