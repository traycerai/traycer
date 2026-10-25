import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  READ_BOUND_MS,
  useBoundedRead,
} from "@/hooks/environment/team/use-bounded-read";

interface Query {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly refetch: () => Promise<unknown>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBoundedRead", () => {
  it("is pending, then failed once the bound passes with no answer", () => {
    const query: Query = {
      isPending: true,
      isError: false,
      refetch: () => Promise.resolve(),
    };
    const { result } = renderHook(() => useBoundedRead(query));
    expect(result.current).toMatchObject({ pending: true, failed: false });

    act(() => {
      vi.advanceTimersByTime(READ_BOUND_MS - 1);
    });
    expect(result.current.pending).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toMatchObject({ pending: false, failed: true });
  });

  it("retries by reading again and waiting the bound again", () => {
    const refetch = vi.fn<() => Promise<unknown>>(() => Promise.resolve());
    const query: Query = { isPending: true, isError: false, refetch };
    const { result } = renderHook(() => useBoundedRead(query));
    act(() => {
      vi.advanceTimersByTime(READ_BOUND_MS);
    });
    expect(result.current.failed).toBe(true);

    act(() => {
      result.current.retry();
    });
    expect(refetch).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ pending: true, failed: false });
    act(() => {
      vi.advanceTimersByTime(READ_BOUND_MS);
    });
    expect(result.current).toMatchObject({ pending: false, failed: true });
  });

  it("clears the failure when a late answer lands", () => {
    let query: Query = {
      isPending: true,
      isError: false,
      refetch: () => Promise.resolve(),
    };
    const { result, rerender } = renderHook(() => useBoundedRead(query));
    act(() => {
      vi.advanceTimersByTime(READ_BOUND_MS);
    });
    expect(result.current.failed).toBe(true);

    query = { ...query, isPending: false };
    rerender();
    expect(result.current).toMatchObject({ pending: false, failed: false });
  });

  it("reports a failed read at once, without waiting", () => {
    const { result } = renderHook(() =>
      useBoundedRead({
        isPending: false,
        isError: true,
        refetch: () => Promise.resolve(),
      }),
    );
    expect(result.current).toMatchObject({ pending: false, failed: true });
  });
});
