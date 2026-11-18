import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The hook's whole job is to turn the push-notified cache into a reactive
// input, so the cache's two exports are the dependencies the test must
// control: the readiness lookup itself, and the subscription that tells the
// hook something may have changed (redesign P4.1: push replaces the old 1s
// poll). A test-local listener set stands in for the cache's own listener
// set, and the test fires it explicitly wherever the poll used to tick.
const readySessionHosts = vi.hoisted(() => ({ value: new Set<string>() }));
const readinessListeners = vi.hoisted(() => ({
  value: new Set<() => void>(),
}));
vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      hasReadyRemoteSession: (hostId: string) =>
        readySessionHosts.value.has(hostId),
      subscribeRemoteSessionReadiness: (listener: () => void) => {
        readinessListeners.value.add(listener);
        return () => {
          readinessListeners.value.delete(listener);
        };
      },
    };
  },
);

function fireReadinessChanged(): void {
  for (const listener of [...readinessListeners.value]) {
    listener();
  }
}

import { useRemoteSessionsPollReadiness } from "../use-remote-sessions-poll-readiness";

afterEach(() => {
  readySessionHosts.value = new Set();
  readinessListeners.value.clear();
});

describe("useRemoteSessionsPollReadiness", () => {
  it("picks up a readiness flip on the next readiness notification, changing the lookup's identity exactly once", () => {
    const { result } = renderHook(() =>
      useRemoteSessionsPollReadiness(["host-a", "host-b"]),
    );
    const initial = result.current;
    expect(initial("host-a")).toBe(false);
    expect(initial("host-b")).toBe(false);

    readySessionHosts.value = new Set(["host-b"]);
    act(() => {
      fireReadinessChanged();
    });
    const flipped = result.current;
    expect(flipped).not.toBe(initial);
    expect(flipped("host-a")).toBe(false);
    expect(flipped("host-b")).toBe(true);

    // No change -> the identity holds through a further notification, so
    // memoized consumers do not recompute on a wake that moved no listed
    // host (the coarse-notify cost the cache module documents).
    act(() => {
      fireReadinessChanged();
    });
    expect(result.current).toBe(flipped);
  });

  it("never reports readiness for a host outside the subscribed list", () => {
    readySessionHosts.value = new Set(["host-elsewhere"]);
    const { result } = renderHook(() =>
      useRemoteSessionsPollReadiness(["host-a"]),
    );
    expect(result.current("host-elsewhere")).toBe(false);
  });
});
