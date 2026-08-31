import { Capacitor } from "@capacitor/core";
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

/**
 * iOS runs the keyboard in overlay mode (`resize: none` in
 * capacitor.config.ts): the webview keeps its full height and this bridge
 * drives gui-app's `--keyboard-inset` from `keyboardWillShow`, which reports
 * the height BEFORE the animation starts - the safe-height tokens subtract
 * it and the `traycer-native-keyboard` glide rule animates the change in
 * sync with the keyboard. Android is deliberately not driven: the OS resizes
 * the webview itself (smoothly), so `100dvh` already tracks the keyboard and
 * writing the inset would shrink the layout twice.
 */
function setKeyboardInset(px: number): void {
  document.documentElement.style.setProperty("--keyboard-inset", `${px}px`);
}

export function startNativeKeyboardBridge(): void {
  if (started) return;
  started = true;
  const drivesInset = Capacitor.getPlatform() === "ios";
  if (drivesInset) {
    document.documentElement.classList.add("traycer-native-keyboard");
  }
  Keyboard.addListener("keyboardWillShow", (info) => {
    if (drivesInset) setKeyboardInset(info.keyboardHeight);
    transition(true);
  }).catch(warnListenerAttachFailure("keyboardWillShow"));
  Keyboard.addListener("keyboardDidShow", () => {
    settle(true);
  }).catch(warnListenerAttachFailure("keyboardDidShow"));
  Keyboard.addListener("keyboardWillHide", () => {
    if (drivesInset) setKeyboardInset(0);
    transition(false);
  }).catch(warnListenerAttachFailure("keyboardWillHide"));
  Keyboard.addListener("keyboardDidHide", () => {
    settle(false);
  }).catch(warnListenerAttachFailure("keyboardDidHide"));
}
