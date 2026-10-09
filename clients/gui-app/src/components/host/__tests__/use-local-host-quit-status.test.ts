// This suite covers two things at two different altitudes:
//
// - `decideVerdict` as a pure function - every precedence branch, with no
//   hooks or mocks at all.
// - `useLocalHostQuitStatus` as an integration of its real dependencies
//   EXCEPT `useHostQuery` itself. `useHostQuery` composes readiness,
//   TanStack's polling table and a live `HostClient` round trip - none of
//   which this hook's own branching depends on, and driving all of that for
//   every case below would test `useHostQuery` a second time rather than
//   this hook's composition of its RESULT shape (`data`/`dataUpdatedAt`/
//   `isError`/`errorUpdatedAt`/`refetch`). So `useHostQuery` is mocked at its
//   own leaf module - the same boundary `local-host-restart-flow.test.tsx`
//   draws around `useHostClientForHostId` and `useHostDirectoryList` - and
//   every other dependency (`useHostBinding`, `resolveLocalEntry`,
//   `looksDialable`, the negotiated-manifest registry) stays real.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  decideVerdict,
  HOST_QUIT_STATUS_BOUND_MS,
  useLocalHostQuitStatus,
} from "@/components/host/use-local-host-quit-status";

// ---------------------------------------------------------------------------
// `decideVerdict` - pure function, precedence order
// ---------------------------------------------------------------------------

const BUSY_BREAKDOWN: HostBusyBreakdownV2 = {
  workingAgents: 1,
  activeTerminalAgents: 0,
  busyTerminals: 0,
  shells: 0,
  scheduledWakes: null,
};

describe("decideVerdict", () => {
  it("no local entry at all wins over every other input - no-local-host", () => {
    expect(
      decideVerdict({
        hasLocalEntry: false,
        dialable: true,
        canAsk: true,
        freshData: { busy: true, busySessionCount: 1, busyBreakdown: null },
        freshError: true,
        timedOut: true,
        statusMinor: 6,
      }),
    ).toEqual({ kind: "no-local-host" });
  });

  it("an entry that cannot be dialed reads not-running at once, whatever else is known", () => {
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: false,
        canAsk: false,
        freshData: null,
        freshError: false,
        timedOut: false,
        statusMinor: null,
      }),
    ).toEqual({ kind: "not-running" });
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: false,
        canAsk: true,
        freshData: null,
        freshError: true,
        timedOut: true,
        statusMinor: 6,
      }),
    ).toEqual({ kind: "not-running" });
  });

  it("a dialable entry this renderer cannot ask reads unknown/no-connection, before any timeout", () => {
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: true,
        canAsk: false,
        freshData: null,
        freshError: false,
        timedOut: false,
        statusMinor: null,
      }),
    ).toEqual({ kind: "unknown", reason: "no-connection" });
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: true,
        canAsk: false,
        freshData: null,
        freshError: true,
        timedOut: true,
        statusMinor: null,
      }),
    ).toEqual({ kind: "unknown", reason: "no-connection" });
  });

  it("fresh data beats a freshError/timedOut that raced it - busy", () => {
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: true,
        canAsk: true,
        freshData: {
          busy: true,
          busySessionCount: 3,
          busyBreakdown: BUSY_BREAKDOWN,
        },
        freshError: true,
        timedOut: true,
        statusMinor: 6,
      }),
    ).toEqual({
      kind: "busy",
      busySessionCount: 3,
      breakdown: BUSY_BREAKDOWN,
      statusMinor: 6,
    });
  });

  it("fresh data read before readiness dropped still stands", () => {
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: true,
        canAsk: false,
        freshData: { busy: false, busySessionCount: 0, busyBreakdown: null },
        freshError: false,
        timedOut: false,
        statusMinor: 6,
      }),
    ).toEqual({
      kind: "idle",
      busySessionCount: 0,
      breakdown: null,
      statusMinor: 6,
    });
  });

  it("fresh data with busy=false reads idle, carrying the same facts", () => {
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: true,
        canAsk: true,
        freshData: { busy: false, busySessionCount: 0, busyBreakdown: null },
        freshError: false,
        timedOut: false,
        statusMinor: 5,
      }),
    ).toEqual({
      kind: "idle",
      busySessionCount: 0,
      breakdown: null,
      statusMinor: 5,
    });
  });

  it("no fresh data and a fresh error reads unknown/unreachable", () => {
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: true,
        canAsk: true,
        freshData: null,
        freshError: true,
        timedOut: false,
        statusMinor: null,
      }),
    ).toEqual({ kind: "unknown", reason: "unreachable" });
  });

  it("no fresh data and the bound elapsed reads unknown/unreachable, never idle", () => {
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: true,
        canAsk: true,
        freshData: null,
        freshError: false,
        timedOut: true,
        statusMinor: null,
      }),
    ).toEqual({ kind: "unknown", reason: "unreachable" });
  });

  it("no fresh data, no error, not timed out yet - checking", () => {
    expect(
      decideVerdict({
        hasLocalEntry: true,
        dialable: true,
        canAsk: true,
        freshData: null,
        freshError: false,
        timedOut: false,
        statusMinor: null,
      }),
    ).toEqual({ kind: "checking" });
  });
});

// ---------------------------------------------------------------------------
// `useLocalHostQuitStatus` - hook integration
// ---------------------------------------------------------------------------

interface HostBindingFixture {
  readonly directory: {
    readonly getLocalEntry: () => HostDirectoryEntry | null;
  };
}

const hostBindingMock = vi.hoisted(
  (): { current: HostBindingFixture | null } => ({ current: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

interface DirectoryListMockState {
  readonly data: readonly HostDirectoryEntry[] | undefined;
}
const directoryListMock = vi.hoisted(
  (): { current: DirectoryListMockState } => ({
    current: { data: undefined },
  }),
);
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => directoryListMock.current,
}));

type HostClientResolver = (
  hostId: string | null,
) => HostClient<HostRpcRegistry> | null;
const clientForHostIdMock = vi.hoisted(
  (): {
    current: HostClientResolver;
    calls: Array<string | null>;
  } => ({
    current: () => null,
    calls: [],
  }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    clientForHostIdMock.calls.push(hostId);
    return clientForHostIdMock.current(hostId);
  },
}));

interface FakeStatusQueryData {
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly busyBreakdown: HostBusyBreakdownV2 | null;
}

interface FakeStatusQueryState {
  readonly data: FakeStatusQueryData | undefined;
  readonly dataUpdatedAt: number;
  readonly isError: boolean;
  readonly errorUpdatedAt: number;
}

interface RecordedHostQueryArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly method: string;
  readonly params: unknown;
  readonly options: Record<string, unknown>;
}

const statusQueryMock = vi.hoisted(
  (): {
    current: FakeStatusQueryState;
    refetch: Mock;
    lastArgs: RecordedHostQueryArgs | null;
  } => ({
    current: {
      data: undefined,
      dataUpdatedAt: 0,
      isError: false,
      errorUpdatedAt: 0,
    },
    refetch: vi.fn(),
    lastArgs: null,
  }),
);
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (
    args: RecordedHostQueryArgs,
  ): Pick<
    UseQueryResult<FakeStatusQueryData, HostRpcError>,
    "data" | "dataUpdatedAt" | "isError" | "errorUpdatedAt" | "refetch"
  > => {
    statusQueryMock.lastArgs = args;
    return {
      data: statusQueryMock.current.data,
      dataUpdatedAt: statusQueryMock.current.dataUpdatedAt,
      isError: statusQueryMock.current.isError,
      errorUpdatedAt: statusQueryMock.current.errorUpdatedAt,
      refetch: statusQueryMock.refetch,
    };
  },
}));

function localEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: "ws://127.0.0.1:0",
    version: "1.6.0",
    transportDialability: "dialable",
  };
}

function nonDialableLocalEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: null,
    version: "1.5.0",
    transportDialability: "not-dialable",
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  hostBindingMock.current = null;
  directoryListMock.current = { data: undefined };
  clientForHostIdMock.current = () => null;
  clientForHostIdMock.calls = [];
  statusQueryMock.current = {
    data: undefined,
    dataUpdatedAt: 0,
    isError: false,
    errorUpdatedAt: 0,
  };
  statusQueryMock.lastArgs = null;
  statusQueryMock.refetch.mockClear();
  resetNegotiatedManifests();
});

/**
 * A stub `HostClient` with no readiness signals at all - the client shape a
 * NOT-ready render sees (signed out, credentials refreshing). Only its
 * identity as "a non-null client" matters where readiness is not in play.
 */
function fakeClient(): HostClient<HostRpcRegistry> {
  return {} as HostClient<HostRpcRegistry>;
}

/**
 * A "ready" `HostClient`: it answers `useReactiveHostReadiness`'s three probes
 * the way a real production requester does, bound to `hostId` and the given
 * directory entry.
 */
function readyClient(
  hostId: string,
  entry: HostDirectoryEntry,
): HostClient<HostRpcRegistry> {
  return {
    getActiveHostId: () => hostId,
    getRequestContextUserId: () => "user-1",
    getActiveHost: () => entry,
  } as HostClient<HostRpcRegistry>;
}

describe("useLocalHostQuitStatus", () => {
  it("reads stale cached data (older than open time) as checking", () => {
    // dataUpdatedAt is captured BEFORE the hook mounts (and so before `since`
    // is set), which is exactly what makes it stale relative to `since`.
    statusQueryMock.current = {
      data: { busy: true, busySessionCount: 1, busyBreakdown: null },
      dataUpdatedAt: Date.now() - 10_000,
      isError: false,
      errorUpdatedAt: 0,
    };
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? readyClient(hostId, localEntry(hostId)) : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));

    expect(result.current.verdict).toEqual({ kind: "checking" });
  });

  it("fresh data busy=true reads busy with statusMinor from the negotiated version", () => {
    recordNegotiatedHostManifest("host-a", {
      "host.status": { major: 1, minor: 6 },
    });
    // Ahead of `since` (captured during render), so it always reads fresh.
    statusQueryMock.current = {
      data: { busy: true, busySessionCount: 2, busyBreakdown: BUSY_BREAKDOWN },
      dataUpdatedAt: Date.now() + 60_000,
      isError: false,
      errorUpdatedAt: 0,
    };
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? readyClient(hostId, localEntry(hostId)) : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));

    expect(result.current.verdict).toEqual({
      kind: "busy",
      busySessionCount: 2,
      breakdown: BUSY_BREAKDOWN,
      statusMinor: 6,
    });
  });

  it("fresh data busy=false reads idle with statusMinor", () => {
    recordNegotiatedHostManifest("host-a", {
      "host.status": { major: 1, minor: 5 },
    });
    statusQueryMock.current = {
      data: { busy: false, busySessionCount: 0, busyBreakdown: null },
      dataUpdatedAt: Date.now() + 60_000,
      isError: false,
      errorUpdatedAt: 0,
    };
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? readyClient(hostId, localEntry(hostId)) : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));

    expect(result.current.verdict).toEqual({
      kind: "idle",
      busySessionCount: 0,
      breakdown: null,
      statusMinor: 5,
    });
  });

  it("a fresh query error reads unknown/unreachable", () => {
    statusQueryMock.current = {
      data: undefined,
      dataUpdatedAt: 0,
      isError: true,
      errorUpdatedAt: Date.now() + 60_000,
    };
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? readyClient(hostId, localEntry(hostId)) : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));

    expect(result.current.verdict).toEqual({
      kind: "unknown",
      reason: "unreachable",
    });
  });

  it("advancing past the 3s bound while still pending reads unknown", () => {
    vi.useFakeTimers();
    statusQueryMock.current = {
      data: undefined,
      dataUpdatedAt: 0,
      isError: false,
      errorUpdatedAt: 0,
    };
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? readyClient(hostId, localEntry(hostId)) : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));
    expect(result.current.verdict).toEqual({ kind: "checking" });

    act(() => {
      vi.advanceTimersByTime(HOST_QUIT_STATUS_BOUND_MS);
    });

    expect(result.current.verdict).toEqual({
      kind: "unknown",
      reason: "unreachable",
    });
  });

  // Production `useHostClientForHostId` always returns SOME client for a
  // directory entry, so these drive a real client shape: the entry's
  // dialability and the client's readiness, not client nullness, are what
  // tell the hook it cannot ask.

  it("no live entry, a dead/booting directory row - reads not-running immediately and after the timeout bound", () => {
    vi.useFakeTimers();
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    directoryListMock.current = { data: [nonDialableLocalEntry("host-a")] };
    // production always returns a client for a directory entry; this one is
    // bound to the booting entry itself, so its `getActiveHost` naturally
    // reports the null websocketUrl a real requester would see.
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a"
        ? readyClient(hostId, nonDialableLocalEntry(hostId))
        : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));

    expect(result.current.verdict).toEqual({ kind: "not-running" });
    expect(result.current.localHostId).toBe("host-a");

    act(() => {
      vi.advanceTimersByTime(HOST_QUIT_STATUS_BOUND_MS);
    });

    expect(result.current.verdict).toEqual({ kind: "not-running" });
  });

  it("a dialable entry but a not-ready client (signed out / credentials refreshing) reads unknown/no-connection without waiting for the timeout", () => {
    vi.useFakeTimers();
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fakeClient() : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));

    expect(result.current.verdict).toEqual({
      kind: "unknown",
      reason: "no-connection",
    });

    act(() => {
      vi.advanceTimersByTime(HOST_QUIT_STATUS_BOUND_MS);
    });

    expect(result.current.verdict).toEqual({
      kind: "unknown",
      reason: "no-connection",
    });
  });

  it("no local host entry at all (live or directory) reads no-local-host", () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    directoryListMock.current = { data: [] };
    clientForHostIdMock.current = () => null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));

    expect(result.current.verdict).toEqual({ kind: "no-local-host" });
    expect(result.current.localHostId).toBeNull();
  });

  it("liveLocalHostIdNow reads the directory at CALL TIME, not from a stale render closure", () => {
    // The directory reads through this holder, so the live entry can change
    // under the SAME binding object without a re-render.
    let liveEntry = localEntry("host-a");
    hostBindingMock.current = {
      directory: { getLocalEntry: () => liveEntry },
    };
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fakeClient() : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));
    expect(result.current.liveLocalHostIdNow()).toBe("host-a");

    // Replace the host without re-rendering - exactly the "host replaced
    // under an open dialog" scenario the quit modal reads this at click time
    // to guard against.
    liveEntry = localEntry("host-b");

    expect(result.current.liveLocalHostIdNow()).toBe("host-b");
  });

  it("liveLocalHostIdNow reads null when there is no host runtime binding", () => {
    hostBindingMock.current = null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));

    expect(result.current.liveLocalHostIdNow()).toBeNull();
  });

  it("recheck() demotes the status back to checking while a refetch is in flight", () => {
    // Fake time so `since` (set from `Date.now()` at mount, and again inside
    // `recheck`) can be pinned to an EXACT instant relative to a fixed
    // `dataUpdatedAt` - real time moving a few ms during the test would
    // otherwise leave both reads on the same side of that boundary.
    vi.useFakeTimers();
    const mountTime = Date.now();
    // Fresh, settled busy data as of the mount instant.
    statusQueryMock.current = {
      data: { busy: true, busySessionCount: 1, busyBreakdown: null },
      dataUpdatedAt: mountTime,
      isError: false,
      errorUpdatedAt: 0,
    };
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? readyClient(hostId, localEntry(hostId)) : null;

    const { result } = renderHook(() => useLocalHostQuitStatus(true));
    expect(result.current.verdict.kind).toBe("busy");

    // Move real time forward past the cached answer's `dataUpdatedAt`, then
    // recheck - which reads a NEW `since` from `Date.now()`.
    vi.setSystemTime(mountTime + 1_000);
    act(() => {
      result.current.recheck();
    });

    // `recheck` advances `since` past the retained `dataUpdatedAt`, so the
    // same cached answer now reads as stale/checking until a fresh one
    // lands - and it asked for that fresh one.
    expect(result.current.verdict).toEqual({ kind: "checking" });
    expect(statusQueryMock.refetch).toHaveBeenCalledTimes(1);
  });

  describe("useHostQuery is called with this host's client, never the app-wide one", () => {
    it("a live local entry resolves the client for that host id, by identity", () => {
      const clientA = readyClient("host-a", localEntry("host-a"));
      const appWideClient = readyClient("app-wide", localEntry("app-wide"));
      hostBindingMock.current = {
        directory: { getLocalEntry: () => localEntry("host-a") },
      };
      clientForHostIdMock.current = (hostId) =>
        hostId === null ? appWideClient : clientA;

      renderHook(() => useLocalHostQuitStatus(true));

      expect(statusQueryMock.lastArgs?.client).toBe(clientA);
      expect(statusQueryMock.lastArgs?.method).toBe("host.status");
      expect(statusQueryMock.lastArgs?.params).toEqual({});
      expect(statusQueryMock.lastArgs?.options).toMatchObject({
        enabled: true,
        staleTime: 0,
        refetchOnMount: "always",
        poll: true,
      });
      expect(clientForHostIdMock.calls).toContain("host-a");
      expect(clientForHostIdMock.calls).not.toContain(null);
    });

    it("active:false disables the query even with a resolvable client", () => {
      const clientA = readyClient("host-a", localEntry("host-a"));
      hostBindingMock.current = {
        directory: { getLocalEntry: () => localEntry("host-a") },
      };
      clientForHostIdMock.current = () => clientA;

      renderHook(() => useLocalHostQuitStatus(false));

      expect(statusQueryMock.lastArgs?.options).toMatchObject({
        enabled: false,
      });
    });

    it("no local entry at all never falls back to the app-wide client", () => {
      const appWideClient = readyClient("app-wide", localEntry("app-wide"));
      hostBindingMock.current = { directory: { getLocalEntry: () => null } };
      directoryListMock.current = { data: [] };
      clientForHostIdMock.current = (hostId) =>
        hostId === null ? appWideClient : null;

      renderHook(() => useLocalHostQuitStatus(true));

      expect(statusQueryMock.lastArgs?.client).toBeNull();
      expect(statusQueryMock.lastArgs?.options).toMatchObject({
        enabled: false,
      });
    });
  });
});
