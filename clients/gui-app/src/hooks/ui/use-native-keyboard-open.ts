import * as React from "react";
import {
  getNativeKeyboardState,
  subscribeNativeKeyboardState,
} from "@/lib/native-keyboard";

function readOpen(): boolean {
  return getNativeKeyboardState().open;
}

function readOpenServer(): boolean {
  return false;
}

/**
 * Reactive "the native shell says the keyboard is up" - the plugin-fed
 * counterpart to `useVirtualKeyboardInset`, and the only live signal in the
 * installed app's native-resize keyboard mode (where the measured inset is 0
 * the whole time the keyboard is up). Always false outside the installed app.
 */
export function useNativeKeyboardOpen(): boolean {
  return React.useSyncExternalStore(
    subscribeNativeKeyboardState,
    readOpen,
    readOpenServer,
  );
}
