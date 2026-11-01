import { act } from "@testing-library/react";
import { setNativeKeyboardState } from "@/lib/native-keyboard";

/**
 * The installed iOS app with its software keyboard up: the window's raw height,
 * its top safe-area inset, the `--keyboard-inset` the native bridge writes, and
 * the plugin's open state. A test reads the same values the shell does and lets
 * the real hook answer. `height - top - inset` is what the focus layout
 * compares to its limit.
 */
export interface KeyboardViewport {
  readonly height: number;
  readonly top: number;
  readonly inset: number;
}

/** Measured on the devices in the landscape report. */
export const IPHONE_17: KeyboardViewport = { height: 402, top: 0, inset: 208 };
export const IPHONE_PRO_MAX: KeyboardViewport = {
  height: 440,
  top: 0,
  inset: 208,
};
export const IPHONE_DUO_OPEN: KeyboardViewport = {
  height: 669,
  top: 0,
  inset: 264,
};
export const IPAD_PRO_11: KeyboardViewport = {
  height: 834,
  top: 32,
  inset: 428,
};

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

/** Sets the top safe-area inset; the resize retires the cached insets. */
function setTopInset(top: number): void {
  document.documentElement.style.setProperty(
    "--safe-area-inset-top",
    `${top}px`,
  );
  window.dispatchEvent(new Event("resize"));
}

/** Raises the native keyboard over a window of `viewport.height`. */
export function raiseNativeKeyboard(viewport: KeyboardViewport): void {
  setLayoutViewportHeight(viewport.height);
  document.documentElement.style.setProperty(
    "--keyboard-inset",
    `${viewport.inset}px`,
  );
  act(() => {
    setTopInset(viewport.top);
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
  document.documentElement.style.removeProperty("--safe-area-inset-top");
  window.dispatchEvent(new Event("resize"));
  setNativeKeyboardState({ open: false, transitioning: false });
}
