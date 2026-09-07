import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import {
  useHostReachability,
  type HostReachability,
} from "@/hooks/agent/use-host-reachability";

interface ListState {
  readonly data: readonly HostDirectoryEntry[] | undefined;
  readonly fetchStatus: string;
}

const list = vi.hoisted<{ value: ListState }>(() => ({
  value: { data: [], fetchStatus: "idle" },
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => list.value,
}));

function entry(overrides: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "This Mac",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:55300/rpc",
    version: "1.0.0",
    transportDialability: "dialable",
    ...overrides,
  };
}

/** A REAL remote entry with `connectivity: "unknown"`, mapped through the production `hostListItemToDirectoryEntry` rather than hand-rolled - the `remoteStatus`/`isRemoteHostDirectoryEntry` shape `hostUnavailability` switches on is exactly the thing a synthetic literal risks getting wrong. */
function remoteEntryWithConnectivity(
  hostId: string,
  connectivity: "unknown" | "connectable",
  planAllowsRemote: boolean,
): HostDirectoryEntry {
  const listItem: HostListItem = {
    hostId,
    displayName: `label-${hostId}`,
    platform: "Ubuntu",
    kind: "personal",
    publicKey: `pk-${hostId}`,
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-07-03T11:59:50.000Z",
    },
    updatePolicy: "manual",
  };
  return hostListItemToDirectoryEntry(
    listItem,
    "wss://relay.example.test/attach",
    planAllowsRemote,
  );
}

const HOST_STARTING_BUDGET_MS = 15_000;

beforeEach(() => {
  vi.useFakeTimers();
  list.value = { data: [], fetchStatus: "idle" };
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * `host-starting` falls to `unreachable` at the budget with `basis: "starting-deadline"`. Every other verdict keeps `basis: "directory"`.
 */
describe("useHostReachability - starting-deadline basis", () => {
  it("falls from host-starting to unreachable at the budget, with unavailability offline and basis starting-deadline", () => {
    list.value = { data: [], fetchStatus: "idle" };
    const { result, rerender } = renderHook(() =>
      useHostReachability("host-a"),
    );
    expect(result.current.status).toBe("host-starting");
    expect(result.current.basis).toBe("directory");

    act(() => {
      vi.advanceTimersByTime(HOST_STARTING_BUDGET_MS - 1);
    });
    rerender();
    expect(result.current.status).toBe("host-starting");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    rerender();
    const fallen: HostReachability = result.current;
    expect(fallen.status).toBe("unreachable");
    expect(fallen.unavailability).toBe("offline");
    expect(fallen.basis).toBe("starting-deadline");
  });

  it("a host that publishes before the budget never falls - the deadline's key clears with the status", () => {
    list.value = { data: [], fetchStatus: "idle" };
    const { result, rerender } = renderHook(() =>
      useHostReachability("host-a"),
    );
    expect(result.current.status).toBe("host-starting");

    act(() => {
      vi.advanceTimersByTime(HOST_STARTING_BUDGET_MS / 2);
    });
    // The host publishes: the directory now lists it as dialable.
    list.value = { data: [entry({})], fetchStatus: "idle" };
    rerender();
    expect(result.current.status).toBe("reachable");
    expect(result.current.basis).toBe("directory");

    // Advancing past what WOULD have been the original deadline must not retroactively flip a now-reachable host to unreachable - the arm that re-checks `directoryVerdict.status !== "host-starting"` before applying the fall is what this asserts.
    act(() => {
      vi.advanceTimersByTime(HOST_STARTING_BUDGET_MS);
    });
    rerender();
    expect(result.current.status).toBe("reachable");
    expect(result.current.basis).toBe("directory");
  });

  it.each([
    [
      "reachable (populated, dialable)",
      { data: [entry({})], fetchStatus: "idle" },
    ],
    [
      "unreachable (host not listed)",
      { data: [entry({ hostId: "other" })], fetchStatus: "idle" },
    ],
    [
      "checking (query in flight)",
      { data: undefined, fetchStatus: "fetching" },
    ],
  ] as const)(
    "every other verdict keeps basis directory: %s",
    (_label, state) => {
      list.value = state;
      const { result } = renderHook(() => useHostReachability("host-a"));
      expect(result.current.basis).toBe("directory");
    },
  );

  // This must never regress into a death claim off a single unreadable liveness probe.
  it("reports reachable, never a death claim, for indeterminate connectivity", () => {
    list.value = {
      data: [remoteEntryWithConnectivity("host-a", "unknown", true)],
      fetchStatus: "idle",
    };
    const { result } = renderHook(() => useHostReachability("host-a"));
    expect(result.current.status).toBe("reachable");
    expect(result.current.unavailability).toBeNull();
  });
  /**
   * Assert the reason, not just the verdict: `plan-restricted` and `offline` both block a session but must not swap copy.
   */
  it("carries plan-restricted as its own reason, never collapsed to offline", () => {
    list.value = {
      data: [remoteEntryWithConnectivity("host-a", "connectable", false)],
      fetchStatus: "idle",
    };
    const { result } = renderHook(() => useHostReachability("host-a"));
    expect(result.current.status).toBe("unreachable");
    expect(result.current.unavailability).toBe("plan-restricted");
    expect(result.current.unavailability).not.toBe("offline");
    expect(result.current.basis).toBe("directory");
  });
});
