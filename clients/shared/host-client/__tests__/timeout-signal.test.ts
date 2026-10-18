import { afterEach, describe, expect, it, vi } from "vitest";
import { timeoutSignal } from "../timeout-signal";

const nativeTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");

function removeNativeTimeout(): void {
  Object.defineProperty(AbortSignal, "timeout", {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (nativeTimeout === undefined) {
    Reflect.deleteProperty(AbortSignal, "timeout");
  } else {
    Object.defineProperty(AbortSignal, "timeout", nativeTimeout);
  }
});

describe("timeoutSignal", () => {
  it("delegates to AbortSignal.timeout where the runtime has it", () => {
    const native = vi.spyOn(AbortSignal, "timeout");

    const signal = timeoutSignal(1234);

    expect(native).toHaveBeenCalledWith(1234);
    expect(signal.aborted).toBe(false);
  });

  describe("without AbortSignal.timeout", () => {
    it("aborts with a TimeoutError exactly when the window ends", () => {
      removeNativeTimeout();
      vi.useFakeTimers();

      const signal = timeoutSignal(10_000);
      vi.advanceTimersByTime(9_999);
      expect(signal.aborted).toBe(false);

      vi.advanceTimersByTime(1);

      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(DOMException);
      expect(signal.reason).toMatchObject({ name: "TimeoutError" });
    });

    it("leaves no pending timer behind once it has fired", () => {
      removeNativeTimeout();
      vi.useFakeTimers();

      timeoutSignal(5_000);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(5_000);

      expect(vi.getTimerCount()).toBe(0);
    });

    it("unrefs its timer so it never holds a process open", () => {
      removeNativeTimeout();
      const unref = vi.fn();
      vi.stubGlobal(
        "setTimeout",
        vi.fn(() => ({ unref })),
      );

      timeoutSignal(10_000);

      expect(unref).toHaveBeenCalledTimes(1);
    });

    it("accepts a runtime whose timers are plain numbers (browser WebView)", () => {
      removeNativeTimeout();
      vi.stubGlobal(
        "setTimeout",
        vi.fn(() => 7),
      );

      expect(timeoutSignal(10_000).aborted).toBe(false);
    });

    it("gives every call its own signal", () => {
      removeNativeTimeout();
      vi.useFakeTimers();

      const first = timeoutSignal(1_000);
      vi.advanceTimersByTime(500);
      const second = timeoutSignal(1_000);
      vi.advanceTimersByTime(500);

      expect(first.aborted).toBe(true);
      expect(second.aborted).toBe(false);
    });
  });
});
