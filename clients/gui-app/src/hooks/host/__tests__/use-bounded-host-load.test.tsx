import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useBoundedHostLoad } from "../use-bounded-host-load";

const BUDGET_MS = 15_000;

function seedLease(
  status: "connecting" | "ready" | "degraded" | "restarting-expected",
): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: "host-1",
    targetHostId: "host-1",
    effectiveHostId: "host-1",
    leases: [{ hostId: "host-1", status, dead: null }],
    selectionRevision: 1,
  });
}

function seedDeadLease(): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: "host-1",
    targetHostId: "host-1",
    effectiveHostId: "host-1",
    leases: [{ hostId: "host-1", status: "dead", dead: { reason: "offline" } }],
    selectionRevision: 1,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  vi.useRealTimers();
});

/**
 * `useBoundedHostLoad` is TOTAL (invariant 6): every arm is a caller-facing
 * word, none of them means "keep spinning indefinitely". These pin the
 * decision table in the source comment - which lease states read as
 * `loading` vs `connecting`, that a `dead` lease short-circuits the budget
 * entirely (F13), and that the deadline survives a lease flapping through
 * intermediate states because it is keyed on the host alone.
 */
describe("useBoundedHostLoad", () => {
  it("answers ready when nothing is pending", () => {
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: false,
      }),
    );
    expect(result.current).toEqual({ kind: "ready" });
  });

  it("answers dead IMMEDIATELY off a dead lease, without advancing the clock - F13's core", () => {
    seedDeadLease();
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );

    // No `act(() => vi.advanceTimersByTime(...))` anywhere in this test. A
    // published dead verdict must not make the reader wait out the 15s
    // budget to be told a fact the authority already knows.
    expect(result.current).toEqual({
      kind: "dead",
      dead: { reason: "offline" },
      hostLabel: "Work laptop",
    });
  });

  it("answers loading when the lease is ready - host itself is up, content still pending", () => {
    seedLease("ready");
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );
    expect(result.current).toEqual({
      kind: "loading",
      hostLabel: "Work laptop",
    });
  });

  it("answers loading when the lease is degraded too", () => {
    seedLease("degraded");
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );
    expect(result.current).toEqual({
      kind: "loading",
      hostLabel: "Work laptop",
    });
  });

  it("answers connecting when the lease is null - authority hasn't spoken yet", () => {
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );
    expect(result.current).toEqual({
      kind: "connecting",
      hostLabel: "Work laptop",
    });
  });

  it("answers connecting when the lease is literally connecting", () => {
    seedLease("connecting");
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );
    expect(result.current).toEqual({
      kind: "connecting",
      hostLabel: "Work laptop",
    });
  });

  // `restarting-expected` is the one non-dead status that carries a product
  // meaning of its own ("a restart is expected, do not panic" - P1.4). It
  // falls through to `connecting` by construction (the hook's `if` only
  // special-cases `ready`/`degraded`), which is correct, but nothing else
  // pins that fall-through - a future refactor routing it to `loading` or
  // `timed-out` instead would be a real regression this catches.
  it("answers connecting when the lease is restarting-expected too", () => {
    seedLease("restarting-expected");
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );
    expect(result.current).toEqual({
      kind: "connecting",
      hostLabel: "Work laptop",
    });
  });

  it("times out a connecting host once the budget elapses", () => {
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );
    expect(result.current.kind).toBe("connecting");

    act(() => {
      vi.advanceTimersByTime(BUDGET_MS);
    });
    expect(result.current).toEqual({
      kind: "timed-out",
      hostLabel: "Work laptop",
    });
  });

  /**
   * Added after sealed probe P12 (`useHostLease`'s `find(hostId)` swapped for
   * `leases[0]`) SURVIVED: every other test here seeds exactly ONE lease, so
   * the wrong-host lookup and the right one are indistinguishable. A window
   * with two hosts is the only shape that can tell them apart, and this hook
   * is the canonical per-host projection every later status surface reads -
   * a lease belonging to another machine is the worst possible answer for it
   * to give.
   */
  it("reads THIS host's lease, not merely the first one published", () => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: "host-other",
      targetHostId: "host-other",
      effectiveHostId: "host-other",
      leases: [
        { hostId: "host-other", status: "ready", dead: null },
        {
          hostId: "host-1",
          status: "dead",
          dead: { reason: "plan-restricted" },
        },
      ],
      selectionRevision: 1,
    });
    const { result } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );
    // `leases[0]` would answer `loading` off the OTHER host's ready lease.
    expect(result.current).toEqual({
      kind: "dead",
      dead: { reason: "plan-restricted" },
      hostLabel: "Work laptop",
    });
  });

  it("a lease flapping connecting -> degraded -> connecting still reaches timed-out - the deadline is keyed on the host alone, not on status", () => {
    seedLease("connecting");
    const { result, rerender } = renderHook(() =>
      useBoundedHostLoad({
        hostId: "host-1",
        hostLabel: "Work laptop",
        pending: true,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(BUDGET_MS / 2);
    });
    expect(result.current.kind).toBe("connecting");

    // The flap: status changes, but the HOST (the deadline's key) does not.
    // If the deadline were keyed on status, this would re-arm the budget
    // from zero and the elapsed half would be lost. The zustand `setState`
    // calls are wrapped in `act` so the test's passing does not depend on
    // `rerender()`'s flush timing being synchronous.
    act(() => {
      seedLease("degraded");
    });
    rerender();
    act(() => {
      seedLease("connecting");
    });
    rerender();

    act(() => {
      vi.advanceTimersByTime(BUDGET_MS / 2);
    });
    expect(result.current).toEqual({
      kind: "timed-out",
      hostLabel: "Work laptop",
    });
  });
});
