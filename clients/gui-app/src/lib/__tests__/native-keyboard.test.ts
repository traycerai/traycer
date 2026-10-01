import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNativeKeyboardState,
  readNativeKeyboardInsetPx,
  runWhenNativeKeyboardSettled,
  setNativeKeyboardState,
  subscribeNativeKeyboardState,
  type NativeKeyboardState,
} from "@/lib/native-keyboard";

const CLOSED: NativeKeyboardState = {
  open: false,
  transitioning: false,
};

beforeEach(() => {
  setNativeKeyboardState(CLOSED);
});

describe("setNativeKeyboardState", () => {
  it("notifies subscribers on a state change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNativeKeyboardState(listener);

    setNativeKeyboardState({ open: true, transitioning: true });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getNativeKeyboardState()).toEqual({
      open: true,
      transitioning: true,
    });

    unsubscribe();
  });

  it("does not re-notify on an identical state write", () => {
    setNativeKeyboardState({ open: true, transitioning: false });

    const listener = vi.fn();
    const unsubscribe = subscribeNativeKeyboardState(listener);

    setNativeKeyboardState({ open: true, transitioning: false });

    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });
});

describe("runWhenNativeKeyboardSettled", () => {
  it("runs immediately when not transitioning", () => {
    const fn = vi.fn();

    runWhenNativeKeyboardSettled(fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("defers until transitioning flips false", () => {
    setNativeKeyboardState({ open: true, transitioning: true });

    const fn = vi.fn();
    runWhenNativeKeyboardSettled(fn);

    expect(fn).not.toHaveBeenCalled();

    setNativeKeyboardState({ open: true, transitioning: false });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never runs a cancelled callback, even after settle", () => {
    setNativeKeyboardState({ open: true, transitioning: true });

    const fn = vi.fn();
    const cancel = runWhenNativeKeyboardSettled(fn);
    cancel();

    setNativeKeyboardState({ open: true, transitioning: false });

    expect(fn).not.toHaveBeenCalled();
  });
});

describe("readNativeKeyboardInsetPx", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--keyboard-inset");
  });

  it("reads the covered height the native bridge publishes", () => {
    document.documentElement.style.setProperty("--keyboard-inset", "336px");

    expect(readNativeKeyboardInsetPx()).toBe(336);
  });

  it("reads 0 where nothing publishes it and while the keyboard is closed", () => {
    // Android, the browser and desktop never write the variable; the iOS
    // shell writes 0px while the keyboard is down.
    expect(readNativeKeyboardInsetPx()).toBe(0);
    document.documentElement.style.setProperty("--keyboard-inset", "0px");
    expect(readNativeKeyboardInsetPx()).toBe(0);
  });
});
