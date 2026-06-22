import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnimationFrameThrottle } from "@/hooks/use-animation-frame-throttle";

describe("useAnimationFrameThrottle", () => {
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrameHandle: number;

  beforeEach(() => {
    frameCallbacks = new Map();
    nextFrameHandle = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrameHandle += 1;
      frameCallbacks.set(nextFrameHandle, callback);
      return nextFrameHandle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      frameCallbacks.delete(handle);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function flushFrame(): void {
    const pending = Array.from(frameCallbacks.entries());
    frameCallbacks.clear();
    const frameTime = performance.now();
    pending.forEach(([, callback]) => callback(frameTime));
  }

  it("coalesces multiple schedules in one frame to a single latest-arg call", () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useAnimationFrameThrottle(callback));

    result.current("a");
    result.current("b");
    result.current("c");
    expect(callback).not.toHaveBeenCalled();
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("c");
  });

  it("invokes the latest callback identity, not the one captured at schedule", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ callback }) => useAnimationFrameThrottle(callback),
      { initialProps: { callback: first } },
    );

    result.current(1);
    rerender({ callback: second });
    flushFrame();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("schedules a fresh frame after the previous one flushes", () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useAnimationFrameThrottle(callback));

    result.current("first");
    flushFrame();
    result.current("second");
    flushFrame();

    expect(callback.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("cancels the pending frame on unmount", () => {
    const callback = vi.fn();
    const { result, unmount } = renderHook(() =>
      useAnimationFrameThrottle(callback),
    );

    result.current("dropped");
    unmount();
    flushFrame();

    expect(callback).not.toHaveBeenCalled();
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("keeps the schedule function identity stable across renders", () => {
    const { result, rerender } = renderHook(
      ({ callback }) => useAnimationFrameThrottle(callback),
      { initialProps: { callback: vi.fn() } },
    );

    const firstSchedule = result.current;
    rerender({ callback: vi.fn() });
    expect(result.current).toBe(firstSchedule);
  });
});
