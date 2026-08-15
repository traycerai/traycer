import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hook's whole job is to turn the pull-only cache into a reactive input,
// so the cache itself is the one dependency the test must control.
const readySessionHosts = vi.hoisted(() => ({ value: new Set<string>() }));
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
    };
  },
);

import { useRemoteSessionsPollReadiness } from "../use-remote-sessions-poll-readiness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  readySessionHosts.value = new Set();
  vi.useRealTimers();
});

describe("useRemoteSessionsPollReadiness", () => {
  it("picks up a readiness flip on the next poll tick, changing the lookup's identity exactly once", () => {
    const { result } = renderHook(() =>
      useRemoteSessionsPollReadiness(["host-a", "host-b"]),
    );
    const initial = result.current;
    expect(initial("host-a")).toBe(false);
    expect(initial("host-b")).toBe(false);

    readySessionHosts.value = new Set(["host-b"]);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    const flipped = result.current;
    expect(flipped).not.toBe(initial);
    expect(flipped("host-a")).toBe(false);
    expect(flipped("host-b")).toBe(true);

    // No change -> the identity holds through further ticks, so memoized
    // consumers do not recompute on quiet polls.
    act(() => {
      vi.advanceTimersByTime(3_000);
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
