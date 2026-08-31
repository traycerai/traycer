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
    console.info("[kbd] transition watchdog fired", { open });
  }, TRANSITION_WATCHDOG_MS);
}

/**
 * Tag + test-id, with any test-id carrying a path separator redacted: some
 * test-ids embed user filesystem paths (e.g. the folder-location rows'
 * `folder-location-import-<worktreePath>`), which must not land in a log.
 */
function describeTarget(el: Element): string {
  const testId = el.getAttribute("data-testid");
  const tag = el.tagName.toLowerCase();
  if (testId === null) return tag;
  return testId.includes("/") ? `${tag}[redacted-path]` : `${tag}[${testId}]`;
}

function describeActiveElement(): string {
  const el = document.activeElement;
  return el === null ? "none" : describeTarget(el);
}

/**
 * TEMPORARY instrumentation (with gui-app's "[kbd] dismiss" log) for the
 * reported keyboard open/close flap: every keyboard event and every
 * focus/blur is stamped so a keyboard that closes right after opening can be
 * attributed from a device log. Console-only, so it is readable where the
 * flap is reproduced - the dev loop, whose debug-signed build Safari Web
 * Inspector can attach to; a distribution build forwards none of it.
 * Remove once the flap is diagnosed.
 */
function logKeyboardEvent(name: string, heightPx: number): void {
  console.info(`[kbd] ${name}`, {
    heightPx,
    active: describeActiveElement(),
    t: Math.round(performance.now()),
  });
}

function warnListenerAttachFailure(event: string): (error: unknown) => void {
  return (error: unknown) => {
    console.error(`[kbd] ${event} listener failed to attach`, error);
  };
}

export function startNativeKeyboardBridge(): void {
  if (started) return;
  started = true;
  Keyboard.addListener("keyboardWillShow", (info) => {
    logKeyboardEvent("willShow", info.keyboardHeight);
    transition(true);
  }).catch(warnListenerAttachFailure("keyboardWillShow"));
  Keyboard.addListener("keyboardDidShow", (info) => {
    logKeyboardEvent("didShow", info.keyboardHeight);
    settle(true);
  }).catch(warnListenerAttachFailure("keyboardDidShow"));
  Keyboard.addListener("keyboardWillHide", () => {
    logKeyboardEvent("willHide", 0);
    transition(false);
  }).catch(warnListenerAttachFailure("keyboardWillHide"));
  Keyboard.addListener("keyboardDidHide", () => {
    logKeyboardEvent("didHide", 0);
    settle(false);
  }).catch(warnListenerAttachFailure("keyboardDidHide"));

  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      console.info("[kbd] focusin", {
        target: target === null ? "unknown" : describeTarget(target),
        t: Math.round(performance.now()),
      });
    },
    { capture: true },
  );
  document.addEventListener(
    "focusout",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      console.info("[kbd] focusout", {
        target: target === null ? "unknown" : describeTarget(target),
        next: describeActiveElement(),
        t: Math.round(performance.now()),
      });
    },
    { capture: true },
  );
}
