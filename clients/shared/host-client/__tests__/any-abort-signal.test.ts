import { describe, expect, it, vi } from "vitest";
import { anyAbortSignal } from "../any-abort-signal";

const nativeAnyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");

function withoutAbortSignalAny<T>(run: () => T): T {
  Object.defineProperty(AbortSignal, "any", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  try {
    return run();
  } finally {
    if (nativeAnyDescriptor === undefined) {
      Reflect.deleteProperty(AbortSignal, "any");
    } else {
      Object.defineProperty(AbortSignal, "any", nativeAnyDescriptor);
    }
  }
}

describe("anyAbortSignal", () => {
  it("delegates to the native AbortSignal.any when the runtime has it", () => {
    const any = vi.spyOn(AbortSignal, "any");
    try {
      const first = new AbortController();
      const second = new AbortController();

      const signal = anyAbortSignal(first.signal, second.signal);

      expect(any).toHaveBeenCalledWith([first.signal, second.signal]);
      second.abort("gone");
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe("gone");
    } finally {
      any.mockRestore();
    }
  });

  it("aborts with the first source's reason when the API is missing", () => {
    withoutAbortSignalAny(() => {
      const first = new AbortController();
      const second = new AbortController();
      const signal = anyAbortSignal(first.signal, second.signal);

      first.abort("binding-replaced");

      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe("binding-replaced");
    });
  });

  it("aborts with the second source's reason when the API is missing", () => {
    withoutAbortSignalAny(() => {
      const first = new AbortController();
      const second = new AbortController();
      const signal = anyAbortSignal(first.signal, second.signal);

      second.abort("context-aborted");

      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe("context-aborted");
    });
  });

  it("returns an already-aborted signal when a source is already aborted", () => {
    withoutAbortSignalAny(() => {
      const first = new AbortController();
      const second = new AbortController();
      second.abort("already-dead");

      const signal = anyAbortSignal(first.signal, second.signal);

      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe("already-dead");
    });
  });

  it("reuses one composed signal per source pair when the API is missing", () => {
    withoutAbortSignalAny(() => {
      const first = new AbortController();
      const second = new AbortController();

      // The whole point of the pair cache: a session issues many requests
      // under one binding/context pair and must not attach a listener set per
      // request - the same composed signal answers all of them.
      expect(anyAbortSignal(first.signal, second.signal)).toBe(
        anyAbortSignal(first.signal, second.signal),
      );
    });
  });

  it("detaches from the surviving source once the other fires", () => {
    withoutAbortSignalAny(() => {
      const first = new AbortController();
      const second = new AbortController();
      const detachFirst = vi.spyOn(first.signal, "removeEventListener");
      const detachSecond = vi.spyOn(second.signal, "removeEventListener");
      anyAbortSignal(first.signal, second.signal);

      first.abort("binding-replaced");

      expect(detachSecond).toHaveBeenCalledWith("abort", expect.any(Function));
      detachFirst.mockRestore();
      detachSecond.mockRestore();
    });
  });
});
