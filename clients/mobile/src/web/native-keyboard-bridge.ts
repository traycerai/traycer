import type { PluginListenerHandle } from "@capacitor/core";
import type { KeyboardInfo } from "@capacitor/keyboard";
import { setNativeKeyboardState } from "@traycer-clients/gui-app";

/**
 * Feeds gui-app's native keyboard state from the Capacitor Keyboard plugin's
 * will/did show/hide events - the only authoritative "keyboard is open" signal
 * in the installed app, where the visualViewport-derived inset gui-app falls
 * back to measures 0 the whole time the keyboard is up.
 *
 * On iOS it also owns `--keyboard-inset`. That shell runs the keyboard in
 * overlay mode (`resize: none` in capacitor.config.ts), so the webview keeps
 * its full height and nothing about `100dvh` reacts to the keyboard; the
 * shell's safe-height tokens subtract this variable instead, and the
 * `traycer-native-keyboard` glide rule animates the change in sync with the
 * keyboard. Android is deliberately not driven: the OS resizes the webview
 * itself, so `100dvh` already tracks the keyboard and writing the inset would
 * shrink the layout twice.
 */
const TRANSITION_WATCHDOG_MS = 700;

/**
 * The slice of the Keyboard plugin this bridge uses, injected rather than
 * imported so a test can deliver the four events in any order the OS might -
 * the same package-boundary seam `push-registration.ts` opens for
 * `PushNotifications`.
 */
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
  /** Last height the plugin reported; the inset is this open, 0 closed. */
  let heightPx = 0;

  /**
   * The one writer for both halves of what this bridge publishes, and the
   * reason a dropped or reordered event is survivable: the CSS inset is
   * DERIVED from `open` here rather than zeroed inside a hide handler, so
   * every path that publishes a closed keyboard clears it, and no path changes
   * the state without passing through here.
   *
   * That shape is load-bearing. iOS delivers the hide pair in reverse for a
   * programmatic dismissal - which is how every dismissal in this app happens,
   * since `use-drag-to-dismiss-keyboard` blurs the field - so `didHide`
   * settles the state closed and the `willHide` behind it is correctly ignored
   * as stale. While the reset lived in that handler, being ignored took the
   * reset with it: `--keyboard-inset` stayed at the keyboard's height, leaving
   * the whole `h-safe-dvh` shell short by it with a dead band where the
   * keyboard had been, until some later cycle happened to arrive in order.
   */
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
   * `transitioning` spans will..did in either direction; gui-app consumers (the
   * terminal's PTY re-grid) wait it out so they reflow once at the settled
   * size. The watchdog force-settles in case a did- event is dropped
   * (backgrounding mid-animation, plugin hiccup): a state stuck "transitioning"
   * would hold that resize forever, which is worse than one mid-animation
   * repaint.
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
      // Reported BEFORE the animation starts, which is what lets the
      // safe-height tokens glide with the keyboard instead of jumping after it.
      heightPx = info.keyboardHeight;
      transition(true);
    })
    .catch(warnListenerAttachFailure("keyboardWillShow"));
  plugin
    .addListener("keyboardDidShow", (info) => {
      // The settled height is the one the inset must rest at: a predictive bar
      // appearing during the animation makes it differ from what `willShow`
      // promised, and nothing else would ever correct that.
      heightPx = info.keyboardHeight;
      settle(true);
    })
    .catch(warnListenerAttachFailure("keyboardDidShow"));
  plugin
    .addListener("keyboardWillHide", () => {
      // Stale, per the reverse-order delivery described on `publish`: the state
      // is already settled closed and the inset already cleared with it, so
      // honoring this would only start a phantom 700ms transition that
      // needlessly holds the terminal's settled re-grid.
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
