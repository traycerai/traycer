import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRefreshSpinner } from "../use-refresh-spinner";

function createDeferredRefresh(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise = (): void => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

describe("useRefreshSpinner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not trigger a refresh while external refreshing is active", () => {
    const onRefresh = vi.fn(() => Promise.resolve());

    const { result } = renderHook(() =>
      useRefreshSpinner({
        onRefresh,
        externalRefreshing: true,
        timeoutMs: 1_000,
      }),
    );

    act(() => {
      result.current.trigger();
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("keeps feedback visible when refresh finishes immediately", async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn(() => Promise.resolve());

    const { result } = renderHook(() =>
      useRefreshSpinner({
        onRefresh,
        externalRefreshing: false,
        timeoutMs: 1_000,
      }),
    );

    act(() => {
      result.current.trigger();
    });
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.refreshing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current.refreshing).toBe(false);
  });

  it("does not warn when unmounted while minimum feedback timer is pending", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const onRefresh = vi.fn(() => Promise.resolve());

    const { result, unmount } = renderHook(() =>
      useRefreshSpinner({
        onRefresh,
        externalRefreshing: false,
        timeoutMs: 1_000,
      }),
    );

    act(() => {
      result.current.trigger();
    });
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("clears feedback when the safety timeout fires before the minimum duration", () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn(() => new Promise<void>(() => {}));

    const { result } = renderHook(() =>
      useRefreshSpinner({
        onRefresh,
        externalRefreshing: false,
        timeoutMs: 100,
      }),
    );

    act(() => {
      result.current.trigger();
    });
    expect(result.current.refreshing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.refreshing).toBe(false);
  });

  it("clears feedback immediately when a long refresh completes", async () => {
    vi.useFakeTimers();
    const refresh = createDeferredRefresh();
    const onRefresh = vi.fn(() => refresh.promise);

    const { result } = renderHook(() =>
      useRefreshSpinner({
        onRefresh,
        externalRefreshing: false,
        timeoutMs: 1_000,
      }),
    );

    act(() => {
      result.current.trigger();
    });
    expect(result.current.refreshing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(351);
    });
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      refresh.resolve();
      await Promise.resolve();
    });
    expect(result.current.refreshing).toBe(false);
  });
});
