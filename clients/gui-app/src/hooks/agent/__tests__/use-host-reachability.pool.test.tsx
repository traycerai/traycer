import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POOL_HOST_LABEL,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import { poolSessionPresence } from "@traycer-clients/shared/host-transport/remote/pool-session-presence";
import { RESTART_INTENT_EPISODE_MS } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { HOST_STARTING_BUDGET_MS } from "@/lib/host/bounded-load-budgets";

/**
 * The server pool is in no directory and holds no lease, and its session
 * dials lazily, so nothing can prove it dead: it never reads `unreachable`.
 * It is `host-starting` only while an announced drain holds and no session is
 * ready; every other moment, before the first dial included, it is
 * `reachable`.
 */

const directory = vi.hoisted<{ value: readonly HostDirectoryEntry[] }>(() => ({
  value: [],
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: directory.value, fetchStatus: "idle" }),
}));

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

beforeEach(() => {
  vi.useFakeTimers();
  directory.value = [];
  readySessionHosts.value = new Set<string>();
});

afterEach(() => {
  poolSessionPresence.sessionEstablished("pool");
  vi.useRealTimers();
});

describe("useHostReachability for the server pool", () => {
  it("reads reachable as the pool, with or without a ready session, and never unreachable", () => {
    const { result } = renderHook(() => useHostReachability("pool"));
    expect(result.current).toMatchObject({
      status: "reachable",
      unavailability: null,
      basis: "directory",
      hostKind: "pool",
      hostLabel: POOL_HOST_LABEL,
    });

    readySessionHosts.value = new Set(["pool"]);
    act(() => {
      fireReadinessChanged();
    });
    expect(result.current.status).toBe("reachable");

    readySessionHosts.value = new Set<string>();
    act(() => {
      fireReadinessChanged();
    });
    expect(result.current.status).toBe("reachable");
  });

  it("holds host-starting through an announced drain, past the starting budget, and reads reachable again once the episode lapses", () => {
    const { result } = renderHook(() => useHostReachability("pool"));

    act(() => {
      poolSessionPresence.reportRestartIntent("pool", "tombstone-1");
    });
    expect(result.current).toMatchObject({
      status: "host-starting",
      hostKind: "pool",
      hostLabel: POOL_HOST_LABEL,
    });

    // The starting budget does not run while the drain is announced: a
    // budget that ran would have fallen to unreachable by now.
    act(() => {
      vi.advanceTimersByTime(HOST_STARTING_BUDGET_MS + 5_000);
    });
    expect(result.current.status).toBe("host-starting");

    act(() => {
      vi.advanceTimersByTime(RESTART_INTENT_EPISODE_MS);
    });
    expect(result.current.status).toBe("reachable");
  });

  it("reads reachable the moment the session is ready again, drain or not", () => {
    const { result } = renderHook(() => useHostReachability("pool"));
    act(() => {
      poolSessionPresence.reportRestartIntent("pool", "tombstone-2");
    });
    expect(result.current.status).toBe("host-starting");

    readySessionHosts.value = new Set(["pool"]);
    act(() => {
      fireReadinessChanged();
    });
    expect(result.current.status).toBe("reachable");
  });
});
