import { vi, type Mock } from "vitest";

/**
 * Test support for the iOS 15.5 WebView floor, which has neither
 * `AbortSignal.timeout` (iOS 16) nor `AbortSignal.any` (iOS 17.4): calling
 * either there is a `TypeError`. A suite calls {@link removeNativeAbortHelpers}
 * in `beforeEach` and `vi.restoreAllMocks()` / `vi.unstubAllGlobals()` in
 * `afterEach`.
 */
export function removeNativeAbortHelpers(): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    throw new TypeError("AbortSignal.timeout is not a function");
  });
  vi.spyOn(AbortSignal, "any").mockImplementation(() => {
    throw new TypeError("AbortSignal.any is not a function");
  });
}

/**
 * Stubs the global `fetch` with one that never answers on its own and, like
 * the real one, rejects with the signal's reason once the signal aborts.
 */
export function stubHangingFetch(): Mock<typeof fetch> {
  const hanging = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) return;
        const rejectWithReason = (): void => {
          reject(signal.reason);
        };
        if (signal.aborted) {
          rejectWithReason();
          return;
        }
        signal.addEventListener("abort", rejectWithReason, { once: true });
      }),
  );
  vi.stubGlobal("fetch", hanging);
  return hanging;
}

/** The signal the most recent `fetch` call was handed. */
export function signalOfLastFetch(fetchMock: Mock<typeof fetch>): AbortSignal {
  const signal = fetchMock.mock.lastCall?.[1]?.signal;
  if (signal === undefined || signal === null) {
    throw new Error("the last fetch call carried no abort signal");
  }
  return signal;
}
