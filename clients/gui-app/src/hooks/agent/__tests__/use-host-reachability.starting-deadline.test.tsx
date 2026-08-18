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

/**
 * A REAL remote entry with `connectivity: "unknown"`, mapped through the
 * production `hostListItemToDirectoryEntry` rather than hand-rolled - the
 * `remoteStatus`/`isRemoteHostDirectoryEntry` shape `hostUnavailability`
 * switches on is exactly the thing a synthetic literal risks getting wrong.
 */
function remoteEntryWithConnectivity(
  hostId: string,
  connectivity: "unknown" | "local-only",
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
 * F4/S2: `host-starting` was the one arm with no way out. These pin the
 * deadline that closes it - the fall to `unreachable` at the budget, that the
 * fall carries `basis: "starting-deadline"` (the field that gates the
 * persisted "Terminal permanently closed" notification, see
 * `terminal-tile-close-navigation.test.tsx`'s basis gate suite) - and that
 * every OTHER verdict this hook can produce keeps `basis: "directory"`, so a
 * future change cannot widen the weak-evidence label past the one arm that
 * earns it.
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

    // Advancing past what WOULD have been the original deadline must not
    // retroactively flip a now-reachable host to unreachable - the arm that
    // re-checks `directoryVerdict.status !== "host-starting"` before
    // applying the fall is what this asserts.
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

  // S4(a): `indeterminate` connectivity means the cloud could not read
  // liveness - we learned NOTHING - and the cost of guessing wrong is
  // asymmetric (`use-host-reachability.ts:150-157`). Guessing dead replaces a
  // working chat with a Clone offer and fires a PERSISTED terminal-closed
  // notification; guessing alive costs one recoverable failed dial. This must
  // never regress into a death claim off a single unreadable liveness probe.
  it("reports reachable, never a death claim, for indeterminate connectivity", () => {
    list.value = {
      data: [remoteEntryWithConnectivity("host-a", "unknown")],
      fetchStatus: "idle",
    };
    const { result } = renderHook(() => useHostReachability("host-a"));
    expect(result.current.status).toBe("reachable");
    expect(result.current.unavailability).toBeNull();
  });
  /**
   * The REASON, not just the verdict. `plan-restricted` and `offline` are both
   * "this client cannot open a session", so a swap between them keeps every
   * status assertion green while telling the reader the wrong thing: that a
   * machine which is running perfectly well is off, and that the remedy is a
   * restart rather than an upgrade. That is not hypothetical - it is the
   * defect that made every plan-restricted host read as "offline" for months,
   * and the reason `dead-tile-banner.tsx` carries a five-arm copy table and
   * `tile-host-load-copy.ts` keys its table on the contract's own union.
   *
   * A wrong CONSTANT rather than a wrong verdict, and the narrowest thing in
   * this suite - which is exactly why nothing else here would catch it.
   * P4.3's lease-derivation sweep rewrites these surfaces, so this pin is what
   * stops the swap being re-introduced silently.
   */
  it("carries plan-restricted as its own reason, never collapsed to offline", () => {
    list.value = {
      data: [remoteEntryWithConnectivity("host-a", "local-only")],
      fetchStatus: "idle",
    };
    const { result } = renderHook(() => useHostReachability("host-a"));
    expect(result.current.status).toBe("unreachable");
    expect(result.current.unavailability).toBe("plan-restricted");
    expect(result.current.unavailability).not.toBe("offline");
    expect(result.current.basis).toBe("directory");
  });
});
