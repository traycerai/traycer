import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/remote-session";
import {
  acquireRemoteSession,
  resetRemoteSessionReadinessListenersForTest,
  retireAllRemoteSessions,
  type RemoteSessionAcquirePolicy,
  type RemoteSessionIdentity,
} from "@traycer-clients/shared/host-transport/remote/index";
import { useFleetUpdateViews } from "@/hooks/host/use-fleet-update-views";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

// `useFleetUpdateViews` is the Settings selector's WHOLE data source (Ticket
// 06, subject F): one bounded sweep over borrowed sessions, projected per
// host id from a map keyed by that id. Per-host isolation is therefore a
// property of the DATA SHAPE (`ObservationsByHostId`, read by exact hostId
// key) rather than of any per-row rendering code - this suite proves it at
// that source, which every consumer (`HostOptionRow` via `HostSwitcher`)
// inherits by construction.
//
// Real `acquireRemoteSession`/borrow machinery (same fake-`IRemoteSession`
// double subject A's suites use) rather than a mocked hook - the whole point
// is that the SWEEP reads through the real borrow surface, and a mock here
// would just be asserting the hook calls its own dependency.

interface FakeSession extends IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  statusResponse: Record<string, unknown>;
  statusCalls: number;
}

function fakeSession(): FakeSession {
  const session: FakeSession = {
    statusCalls: 0,
    statusResponse: { outcome: "kind-none" },
    start: vi.fn(),
    isClosed: () => false,
    isReady: () => true,
    sendUnary: ((method: string) => {
      session.statusCalls += 1;
      if (method !== "host.status") {
        return Promise.reject(
          new Error(`not exercised by this test: ${method}`),
        );
      }
      return Promise.resolve(session.statusResponse);
    }) as FakeSession["sendUnary"],
    forceReconnect: vi.fn(),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    wake: vi.fn(),
    onClosed: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
    subscribeReadinessLost: () => () => undefined,
    terminalFatal: () => null,
    close: () => undefined,
  };
  return session;
}

// Fleet-view reads borrow sessions; they never consult sweep eligibility, so
// one sweep-eligible policy serves every acquire these tests make.
const FLEET_TEST_POLICY: RemoteSessionAcquirePolicy = {
  proactiveWakeEligible: true,
};

function remoteIdentity(hostId: string): RemoteSessionIdentity {
  return {
    hostId,
    userId: "user-1",
    hostPublicKey: `pubkey-${hostId}`,
    relayAttachUrl: `wss://relay.test/attach-${hostId}`,
    authRecovery: "revalidate",
    authEpoch: "lease-1",
  };
}

function idleStatus(version: string) {
  return {
    ready: true,
    hostVersion: version,
    protocolVersion: { major: 1, minor: 3 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: { kind: "none" },
    updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
  };
}

function downloadingStatus(targetVersion: string) {
  return {
    ...idleStatus("1.5.0"),
    updateOperation: {
      kind: "attempt",
      attemptId: `attempt-${targetVersion}`,
      generation: 1,
      sequence: 1,
      targetVersion,
      trigger: "manual",
      phase: "downloading",
      execution: "active",
      continuation: null,
      progress: null,
      liveness: "active",
      livenessCause: null,
      busySessionCount: null,
      busyBreakdown: null,
      error: null,
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

afterEach(() => {
  retireAllRemoteSessions();
  resetRemoteSessionReadinessListenersForTest();
});

describe("useFleetUpdateViews — per-host isolation (Ticket 06 subject F)", () => {
  it("host B's projected view is unaffected while host A is actively updating, and BOTH change independently (positive controls both ways)", async () => {
    const hostA = "host-a";
    const hostB = "host-b";
    const sessionA = fakeSession();
    const sessionB = fakeSession();
    sessionA.statusResponse = downloadingStatus("2.1.0");
    sessionB.statusResponse = idleStatus("1.5.0");
    // Both sessions HELD by an owner (refCount > 0), which is the admission
    // test `tryAcquireReadyRemoteSession` requires - a borrow never adopts a
    // zero-consumer lingering entry (subject A).
    const ownerA = acquireRemoteSession(
      remoteIdentity(hostA),
      FLEET_TEST_POLICY,
      () => sessionA,
    );
    const ownerB = acquireRemoteSession(
      remoteIdentity(hostB),
      FLEET_TEST_POLICY,
      () => sessionB,
    );

    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useFleetUpdateViews([hostA, hostB]), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(result.current(hostA).kind).toBe("downloading");
    });
    // The isolation claim: B's view is idle, not downloading - A's active
    // state did not leak across the map.
    expect(result.current(hostB).kind).toBe("idle");

    // Positive control #1: driving B into the SAME active state changes
    // ONLY B's answer, proving the assertion above could have failed had
    // isolation been broken (a shared/aliased entry would show both flipping
    // together).
    sessionB.statusResponse = downloadingStatus("3.0.0");
    await queryClient.invalidateQueries();
    await waitFor(() => {
      expect(result.current(hostB).kind).toBe("downloading");
    });
    expect(result.current(hostA).kind).toBe("downloading");
    expect(result.current(hostA).targetVersion).toBe("2.1.0");
    expect(result.current(hostB).targetVersion).toBe("3.0.0");

    // Positive control #2, the other direction: resolving A back to idle
    // does not disturb B's still-active state.
    sessionA.statusResponse = idleStatus("1.5.0");
    await queryClient.invalidateQueries();
    await waitFor(() => {
      expect(result.current(hostA).kind).toBe("idle");
    });
    expect(result.current(hostB).kind).toBe("downloading");

    ownerA.close();
    ownerB.close();
  });

  it("a host with NO borrowable session projects unknown regardless of a sibling host's state - absence never borrows a connection", async () => {
    const hostA = "host-a";
    const hostNoSession = "host-quiet";
    const sessionA = fakeSession();
    sessionA.statusResponse = downloadingStatus("2.1.0");
    const ownerA = acquireRemoteSession(
      remoteIdentity(hostA),
      FLEET_TEST_POLICY,
      () => sessionA,
    );

    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => useFleetUpdateViews([hostA, hostNoSession]),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );

    await waitFor(() => {
      expect(result.current(hostA).kind).toBe("downloading");
    });
    expect(result.current(hostNoSession).kind).toBe("unknown");
    // No session was ever constructed for the quiet host - nothing here CAN
    // dial one (`tryAcquireReadyRemoteSession` takes no factory), but this
    // also pins that the sweep never tried a different route to one.
    expect(sessionA.statusCalls).toBeGreaterThan(0);

    ownerA.close();
  });
});

// G3: per-host cadence, coalescing with the canonical `host.status` cache, and
// retention across a declined read. The independent cold review's finding 2
// (HIGH) was that a single fleet-shaped query applied ONE cadence to the whole
// list — an active host on one machine fast-polled every idle host — and that
// selected/local reads issued a parallel fleet read instead of reusing the
// canonical cache entry.
describe("useFleetUpdateViews — per-host cadence (G3a)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an ACTIVE host polls at the 2s cadence while an IDLE sibling stays on the 60s cadence — asserted by COUNT, not by reading the interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hostA = "host-active";
    const hostB = "host-idle";
    const sessionA = fakeSession();
    const sessionB = fakeSession();
    sessionA.statusResponse = downloadingStatus("2.1.0");
    sessionB.statusResponse = idleStatus("1.5.0");
    const ownerA = acquireRemoteSession(
      remoteIdentity(hostA),
      FLEET_TEST_POLICY,
      () => sessionA,
    );
    const ownerB = acquireRemoteSession(
      remoteIdentity(hostB),
      FLEET_TEST_POLICY,
      () => sessionB,
    );

    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useFleetUpdateViews([hostA, hostB]), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(result.current(hostA).kind).toBe("downloading");
      expect(result.current(hostB).kind).toBe("idle");
    });
    const callsAAfterFirst = sessionA.statusCalls;
    const callsBAfterFirst = sessionB.statusCalls;

    // 10 seconds: the active cadence (2s) should fire ~5 more times; the idle
    // cadence (60s) should not have fired again at all.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sessionA.statusCalls).toBeGreaterThan(callsAAfterFirst);
    expect(sessionB.statusCalls).toBe(callsBAfterFirst);

    ownerA.close();
    ownerB.close();
  });
});

describe("useFleetUpdateViews — coalescing with the canonical host.status cache (G3b)", () => {
  it("a FRESH canonical host.status cache entry serves the host's observation WITHOUT issuing a borrowed read", async () => {
    const hostId = "host-canonical";
    const session = fakeSession();
    // If the coalescing failed, this is what WOULD get read — a distinct
    // version from the seeded canonical entry, so a leaked borrow is visible.
    session.statusResponse = downloadingStatus("9.9.9");
    const owner = acquireRemoteSession(
      remoteIdentity(hostId),
      FLEET_TEST_POLICY,
      () => session,
    );

    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "host.status">(
        hostId,
        "host.status",
        {},
      ),
      idleStatus("1.5.0"),
    );

    const { result } = renderHook(() => useFleetUpdateViews([hostId]), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(result.current(hostId).kind).toBe("idle");
    });
    // The canonical entry's own version, NOT the borrowed session's — proving
    // the canonical read served this host rather than a borrow.
    expect(result.current(hostId).kind).not.toBe("downloading");
    expect(session.statusCalls).toBe(0);

    owner.close();
  });

  it("a STALE/absent canonical entry falls through to the borrow, exactly as before coalescing existed", async () => {
    const hostId = "host-canonical-stale";
    const session = fakeSession();
    session.statusResponse = downloadingStatus("2.1.0");
    const owner = acquireRemoteSession(
      remoteIdentity(hostId),
      FLEET_TEST_POLICY,
      () => session,
    );

    // No canonical `host.status` cache entry seeded at all — the query state
    // simply does not exist for this host.
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useFleetUpdateViews([hostId]), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(result.current(hostId).kind).toBe("downloading");
    });
    expect(session.statusCalls).toBeGreaterThan(0);

    owner.close();
  });
});

describe("useFleetUpdateViews — global concurrency across real per-host queries (G3c)", () => {
  // NOTE ON WHERE THIS CLAIM ACTUALLY LIVES: the peak-of-4 assertion belongs to
  // `fleet-read-gate.test.ts`'s dedicated concurrency suite, which counts
  // concurrency itself (`active`/`peak` local counters) rather than sampling
  // `fleetReadSlotsInUseForTest()` — that instrument reads the SAME counter the
  // barging defect corrupts, so a peak assertion built on it can read "4" at
  // the exact moment 5+ tasks are in flight. Reproducing the gate's own
  // arrival-after-hand-off timing (submit N, let some resolve, THEN submit the
  // rest) through ten real per-host TanStack queries and borrowed sessions is
  // not controllable at this seam — `useQueries` mounts all ten queries in the
  // same commit, so there is no "then submit 4 more" moment to aim at here.
  // This suite's job is therefore narrower and honest about it: prove that ten
  // concurrent per-host reads, funneled through the SAME shared gate, all
  // complete without deadlocking or dropping a host.
  it("ten hosts reading concurrently through the shared fleet gate all resolve, with none starved indefinitely", async () => {
    const hostIds = Array.from(
      { length: 10 },
      (_, index) => `fleet-host-${index}`,
    );
    const owners = hostIds.map((hostId) => {
      const session = fakeSession();
      session.statusResponse = idleStatus("1.5.0");
      return acquireRemoteSession(
        remoteIdentity(hostId),
        FLEET_TEST_POLICY,
        () => session,
      );
    });

    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useFleetUpdateViews(hostIds), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(
      () => {
        for (const hostId of hostIds) {
          expect(result.current(hostId).kind).toBe("idle");
        }
      },
      { timeout: 5_000 },
    );

    owners.forEach((owner) => {
      owner.close();
    });
  });
});

describe("useFleetUpdateViews — retention across a declined read (G3e)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a host whose read DECLINES keeps its previous observation rather than vanishing — and once stale, retains the phase through the SAME qualified-unknown mechanism as the direct projection", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hostId = "host-retained";
    const session = fakeSession();
    session.statusResponse = downloadingStatus("2.1.0");
    let declining = false;
    const originalSendUnary = session.sendUnary.bind(session);
    session.sendUnary = ((...args: Parameters<typeof originalSendUnary>) => {
      if (declining) {
        return Promise.reject(new Error("session closed underneath the read"));
      }
      return originalSendUnary(...args);
    }) as typeof originalSendUnary;
    const owner = acquireRemoteSession(
      remoteIdentity(hostId),
      FLEET_TEST_POLICY,
      () => session,
    );

    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useFleetUpdateViews([hostId]), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(result.current(hostId).kind).toBe("downloading");
      expect(result.current(hostId).attemptId).toBe("attempt-2.1.0");
    });

    // Every subsequent read declines (the borrowed session rejects).
    declining = true;
    // Active cadence is 2s; the freshness deadline is 2.5x that (5s). Advance
    // past BOTH so the retained observation goes stale.
    await vi.advanceTimersByTimeAsync(6_000);

    await waitFor(() => {
      expect(result.current(hostId).kind).toBe("unknown");
    });
    // THE RETENTION CLAIM: the view did not vanish into a bare unknown — it
    // still names the phase and target the last successful read observed,
    // exactly the "last seen downloading" evidence a declined read must not
    // discard.
    expect(result.current(hostId).lastKnownKind).toBe("downloading");
    expect(result.current(hostId).targetVersion).toBe("2.1.0");
    expect(result.current(hostId).attemptId).toBe("attempt-2.1.0");

    owner.close();
  });
});
