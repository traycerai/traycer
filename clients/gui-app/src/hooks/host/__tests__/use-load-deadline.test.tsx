import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLoadDeadline } from "../use-load-deadline";

const BUDGET_MS = 15_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * `useLoadDeadline` is the epic's ONE loading deadline (invariant 6). The
 * whole reason it stores the ELAPSED KEY rather than a boolean is the re-arm
 * case below: a boolean-plus-reset-effect design reports the PREVIOUS wait's
 * verdict for one commit after the key changes, which is exactly the stale
 * "timed out" flash a fresh wait must never show.
 */
describe("useLoadDeadline", () => {
  it("answers false before the budget elapses", () => {
    const { result } = renderHook(() => useLoadDeadline("host-1", BUDGET_MS));
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(BUDGET_MS - 1);
    });
    expect(result.current).toBe(false);
  });

  it("fires exactly at the budget", () => {
    const { result } = renderHook(() => useLoadDeadline("host-1", BUDGET_MS));

    act(() => {
      vi.advanceTimersByTime(BUDGET_MS);
    });
    expect(result.current).toBe(true);
  });

  it("re-arms on a key change and answers false on the very first render after it - never a stale true", () => {
    const { result, rerender } = renderHook(
      ({ key }: { readonly key: string | null }) =>
        useLoadDeadline(key, BUDGET_MS),
      { initialProps: { key: "host-1" } },
    );

    act(() => {
      vi.advanceTimersByTime(BUDGET_MS);
    });
    expect(result.current).toBe(true);

    // A different key is a different wait. The stored value is the ELAPSED
    // KEY, so the very next render - with no advancing timer, no reset
    // effect - must already read false. A boolean-plus-effect implementation
    // would still read true here for one commit.
    rerender({ key: "host-2" });
    expect(result.current).toBe(false);

    // And it re-arms its own budget from zero rather than inheriting any
    // elapsed time from host-1's wait.
    act(() => {
      vi.advanceTimersByTime(BUDGET_MS - 1);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("disarms on null - nothing pending, nothing to time out", () => {
    const initialProps: { readonly key: string | null } = { key: "host-1" };
    const { result, rerender } = renderHook(
      ({ key }) => useLoadDeadline(key, BUDGET_MS),
      { initialProps },
    );

    rerender({ key: null });
    act(() => {
      vi.advanceTimersByTime(BUDGET_MS);
    });
    expect(result.current).toBe(false);
  });

  it("re-arms a repeated wait for the SAME key with a fresh budget", () => {
    const initialProps: { readonly key: string | null } = { key: "host-1" };
    const { result, rerender } = renderHook(
      ({ key }) => useLoadDeadline(key, BUDGET_MS),
      { initialProps },
    );
    act(() => {
      vi.advanceTimersByTime(BUDGET_MS);
    });
    expect(result.current).toBe(true);

    // Disarm, then wait for the same host again - a restart of the host that
    // just timed out. The second wait is a NEW episode: answering `true` on
    // its opening frame (the stored verdict of the first wait) rendered a
    // recovering host unreachable before its budget ever started.
    rerender({ key: null });
    rerender({ key: "host-1" });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(BUDGET_MS - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("clears its timer on unmount", () => {
    const { unmount } = renderHook(() => useLoadDeadline("host-1", BUDGET_MS));

    // A direct assertion on the fake-timer queue, not on whether advancing it
    // throws afterward - React 18 removed the "state update on an unmounted
    // component" warning and it was never a throw to begin with, so
    // `expect(() => act(...)).not.toThrow()` would pass whether or not the
    // effect's cleanup actually ran `clearTimeout`.
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
