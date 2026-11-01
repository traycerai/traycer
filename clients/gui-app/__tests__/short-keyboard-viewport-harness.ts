import { act } from "@testing-library/react";
import { setNativeKeyboardState } from "@/lib/native-keyboard";

/**
 * The installed iOS app with its software keyboard up: the window's raw height,
 * the `--keyboard-inset` the native bridge writes, and the plugin's open state.
 * A test reads the same three values the shell does and lets the real hook
 * answer. `height - inset` is what the focus layout compares to its limit.
 */
export interface KeyboardViewport {
  readonly height: number;
  readonly inset: number;
}

/** Measured on the devices in the landscape report. */
export const IPHONE_17: KeyboardViewport = { height: 402, inset: 208 };
export const IPHONE_PRO_MAX: KeyboardViewport = { height: 440, inset: 208 };
export const IPHONE_DUO_OPEN: KeyboardViewport = { height: 669, inset: 264 };
export const IPAD_PRO_11: KeyboardViewport = { height: 834, inset: 428 };

export function setLayoutViewportHeight(height: number): void {
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: height,
    configurable: true,
  });
}

/** The screen on its side: phone portrait is never short. */
export function holdScreenLandscape(): void {
  Object.defineProperty(window.screen, "orientation", {
    configurable: true,
    value: {
      type: "landscape-primary",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}

/** Raises the native keyboard over a window of `viewport.height`. */
export function raiseNativeKeyboard(viewport: KeyboardViewport): void {
  setLayoutViewportHeight(viewport.height);
  document.documentElement.style.setProperty(
    "--keyboard-inset",
    `${viewport.inset}px`,
  );
  act(() => {
    setNativeKeyboardState({ open: true, transitioning: false });
  });
}

/** The bridge's will-hide: the inset goes to 0 and the state to closed. */
export function lowerNativeKeyboard(): void {
  document.documentElement.style.removeProperty("--keyboard-inset");
  act(() => {
    setNativeKeyboardState({ open: false, transitioning: false });
  });
}

/** Cleanup: leaves the document and the native state as they were found. */
export function restoreKeyboardEnvironment(): void {
  Reflect.deleteProperty(document.documentElement, "clientHeight");
  Reflect.deleteProperty(window.screen, "orientation");
  document.documentElement.style.removeProperty("--keyboard-inset");
  setNativeKeyboardState({ open: false, transitioning: false });
}
