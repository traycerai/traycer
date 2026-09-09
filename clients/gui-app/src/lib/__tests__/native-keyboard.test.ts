import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNativeKeyboardState,
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
