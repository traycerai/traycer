import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCanvasBoardMounts } from "../use-canvas-board-mounts";

const A = "boards/a.html";
const B = "boards/b.html";
const C = "boards/c.html";
const D = "boards/d.html";
// A render callback must hand the hook the SAME reference across renders
// when nothing changed: the hook itself only re-admits once `desired`
// changes identity, so a fresh `new Set()` built inline every render would
// never settle.
const EMPTY: ReadonlySet<string> = new Set();

afterEach(() => {
  vi.useRealTimers();
});

describe("useCanvasBoardMounts", () => {
  it("admits at most three boards as loading at a time, in desired order", () => {
    const desired = new Set([A, B, C, D]);
    const { result } = renderHook(() => useCanvasBoardMounts(desired, true));

    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));
  });

  it.each([
    ["ready", A, new Set([A, B, C, D])],
    ["crashed", B, new Set([A, B, C, D])],
  ] as const)(
    "frees a slot once a board reports %s, admitting the next candidate",
    (status, path, expected) => {
      const desired = new Set([A, B, C, D]);
      const { result } = renderHook(() => useCanvasBoardMounts(desired, true));

      act(() => {
        result.current.onBoardStatus(path, status);
      });

      expect(result.current.liveBoards).toEqual(expected);
    },
  );

  it.each(["loading", "disposed"] as const)(
    "ignores a %s status and keeps the slot occupied",
    (status) => {
      const desired = new Set([A, B, C, D]);
      const { result } = renderHook(() => useCanvasBoardMounts(desired, true));

      act(() => {
        result.current.onBoardStatus(A, status);
      });

      expect(result.current.liveBoards).toEqual(new Set([A, B, C]));
    },
  );

  it("does not grow past the desired set once every slot is settled", () => {
    const desired = new Set([A, B]);
    const { result } = renderHook(() => useCanvasBoardMounts(desired, true));

    act(() => {
      result.current.onBoardStatus(A, "ready");
      result.current.onBoardStatus(B, "ready");
    });

    expect(result.current.liveBoards).toEqual(new Set([A, B]));
  });

  it("ignores a stale status report for a board already dropped from the desired set", () => {
    let desired = new Set([A, B, C]);
    const { result, rerender } = renderHook(
      ({ desired }: { desired: ReadonlySet<string> }) =>
        useCanvasBoardMounts(desired, true),
      { initialProps: { desired } },
    );
    act(() => {
      result.current.onBoardStatus(A, "ready");
    });
    const onBoardStatusBeforeDrop = result.current.onBoardStatus;

    // A frees C's loading slot, then A itself leaves the desired set before
    // its own status settles.
    desired = new Set([B, C]);
    rerender({ desired });
    expect(result.current.liveBoards).toEqual(new Set([B, C]));

    act(() => {
      onBoardStatusBeforeDrop(A, "ready");
    });

    expect(result.current.liveBoards).toEqual(new Set([B, C]));
  });

  it("drops a board's slot once it leaves the desired set, freeing room for a new candidate", () => {
    let desired = new Set([A, B, C]);
    const { result, rerender } = renderHook(
      ({ desired }: { desired: ReadonlySet<string> }) =>
        useCanvasBoardMounts(desired, true),
      { initialProps: { desired } },
    );
    act(() => {
      result.current.onBoardStatus(A, "ready");
      result.current.onBoardStatus(B, "ready");
      result.current.onBoardStatus(C, "ready");
    });
    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));

    desired = new Set([B, C, D]);
    rerender({ desired });

    expect(result.current.liveBoards).toEqual(new Set([B, C, D]));
  });

  it("keeps settled boards in place when only the desired set's priority order changes", () => {
    let desired = new Set([A, B, C]);
    const { result, rerender } = renderHook(
      ({ desired }: { desired: ReadonlySet<string> }) =>
        useCanvasBoardMounts(desired, true),
      { initialProps: { desired } },
    );
    act(() => {
      result.current.onBoardStatus(A, "ready");
      result.current.onBoardStatus(B, "ready");
      result.current.onBoardStatus(C, "ready");
    });

    // Same members, new priority order (as the selector would hand back
    // once the viewport moved): the members already hold their slots.
    desired = new Set([C, A, B]);
    rerender({ desired });

    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));
  });

  it("mounts nothing for an empty desired set", () => {
    const { result } = renderHook(() => useCanvasBoardMounts(EMPTY, true));

    expect(result.current.liveBoards.size).toBe(0);
  });

  it("keeps the current working set immediately once the pane is hidden, not an empty one", () => {
    const desired = new Set([A, B, C]);
    const { result, rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useCanvasBoardMounts(desired, visible),
      { initialProps: { visible: true } },
    );
    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));

    rerender({ visible: false });

    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));
  });

  it("ignores a new desired set computed from the pane's false hidden geometry", () => {
    const first = new Set([A, B, C]);
    const { result, rerender } = renderHook(
      ({
        desired,
        visible,
      }: {
        desired: ReadonlySet<string>;
        visible: boolean;
      }) => useCanvasBoardMounts(desired, visible),
      { initialProps: { desired: first, visible: true } },
    );
    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));

    // A hidden pane reports zero size; a selector run against that would
    // hand back a different set the hook must not act on while hidden.
    rerender({ desired: new Set([D]), visible: false });

    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));
  });

  it("releases the retained set once hidden for 180000ms", () => {
    vi.useFakeTimers();
    const desired = new Set([A, B, C]);
    const { result, rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useCanvasBoardMounts(desired, visible),
      { initialProps: { visible: true } },
    );
    rerender({ visible: false });

    act(() => {
      vi.advanceTimersByTime(179_999);
    });
    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.liveBoards.size).toBe(0);
  });

  it("cancels the release and keeps the retained set if the pane returns before 180000ms", () => {
    vi.useFakeTimers();
    const desired = new Set([A, B, C]);
    const { result, rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useCanvasBoardMounts(desired, visible),
      { initialProps: { visible: true } },
    );
    rerender({ visible: false });

    act(() => {
      vi.advanceTimersByTime(100_000);
    });
    rerender({ visible: true });
    act(() => {
      vi.advanceTimersByTime(200_000);
    });

    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));
  });

  it("re-admits up to the concurrency cap once a released pane becomes visible again", () => {
    vi.useFakeTimers();
    const desired = new Set([A, B, C, D]);
    const { result, rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useCanvasBoardMounts(desired, visible),
      { initialProps: { visible: true } },
    );
    rerender({ visible: false });
    act(() => {
      vi.advanceTimersByTime(180_000);
    });
    expect(result.current.liveBoards.size).toBe(0);

    rerender({ visible: true });

    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));
  });

  it("settles on the same admitted set under StrictMode's double-invoked render", () => {
    const desired = new Set([A, B, C, D]);
    const { result } = renderHook(() => useCanvasBoardMounts(desired, true), {
      wrapper: StrictMode,
    });

    expect(result.current.liveBoards).toEqual(new Set([A, B, C]));

    act(() => {
      result.current.onBoardStatus(A, "ready");
    });

    expect(result.current.liveBoards).toEqual(new Set([A, B, C, D]));
  });
});
