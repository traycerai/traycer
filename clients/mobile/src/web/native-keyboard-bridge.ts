import type { PluginListenerHandle } from "@capacitor/core";
import type { KeyboardInfo } from "@capacitor/keyboard";
import { setNativeKeyboardState } from "@traycer-clients/gui-app";

const TRANSITION_WATCHDOG_MS = 700;

export interface KeyboardPluginSlice {
  addListener(
    eventName: "keyboardWillShow" | "keyboardDidShow",
    listenerFunc: (info: KeyboardInfo) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "keyboardWillHide" | "keyboardDidHide",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
}

function warnListenerAttachFailure(event: string): (error: unknown) => void {
  return (error: unknown) => {
    console.error(`[kbd] ${event} listener failed to attach`, error);
  };
}

export function startNativeKeyboardBridge(input: {
  readonly plugin: KeyboardPluginSlice;
  /** Whether this shell overlays the keyboard, so the inset is ours to own. */
  readonly drivesInset: boolean;
}): void {
  const { plugin, drivesInset } = input;
  let watchdog: number | null = null;
  let open = false;
  let heightPx = 0;

  function publish(nextOpen: boolean, transitioning: boolean): void {
    open = nextOpen;
    if (drivesInset) {
      document.documentElement.style.setProperty(
        "--keyboard-inset",
        nextOpen ? `${heightPx}px` : "0px",
      );
    }
    setNativeKeyboardState({ open: nextOpen, transitioning });
  }

  function settle(nextOpen: boolean): void {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    publish(nextOpen, false);
  }

  /**
   * `transitioning` spans will..did in either direction; gui-app consumers (the terminal's pty re-grid) wait it out so they reflow once at the settled size.
   */
  function transition(nextOpen: boolean): void {
    publish(nextOpen, true);
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      watchdog = null;
      publish(nextOpen, false);
    }, TRANSITION_WATCHDOG_MS);
  }

  if (drivesInset) {
    document.documentElement.classList.add("traycer-native-keyboard");
  }
  plugin
    .addListener("keyboardWillShow", (info) => {
    // Reported before the animation starts, which is what lets the
      // safe-height tokens glide with the keyboard instead of jumping after it.
      heightPx = info.keyboardHeight;
      transition(true);
    })
    .catch(warnListenerAttachFailure("keyboardWillShow"));
  plugin
    .addListener("keyboardDidShow", (info) => {
      // Stale, and the mirror of the `willHide` guard below: a hide has already been declared and is still in flight, so this belongs to the show that hide superseded.
      // `watchdog !== null` is what separates this from a genuine show arriving while closed and settled, which must still open.
      if (!open && watchdog !== null) return;
      // The settled height is the one the inset must rest at: a predictive bar appearing during the animation makes it differ from what `willShow` promised, and nothing else would ever correct that.
      heightPx = info.keyboardHeight;
      settle(true);
    })
    .catch(warnListenerAttachFailure("keyboardDidShow"));
  plugin
    .addListener("keyboardWillHide", () => {
      if (!open && watchdog === null) return;
      transition(false);
    })
    .catch(warnListenerAttachFailure("keyboardWillHide"));
  plugin
    .addListener("keyboardDidHide", () => {
      settle(false);
    })
    .catch(warnListenerAttachFailure("keyboardDidHide"));
}
