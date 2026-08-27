import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostStatusUpdateOperation } from "@traycer/protocol/host/status/index";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/remote-session";
import {
  acquireRemoteSession,
  resetRemoteSessionReadinessListenersForTest,
  retireAllRemoteSessions,
  type RemoteSessionAcquirePolicy,
  type RemoteSessionIdentity,
} from "@traycer-clients/shared/host-transport/remote/index";
import type { HostRpcRegistry } from "@/lib/host";
import {
  observationFromStatus,
  readUpdateStatusOverBorrowedSession,
} from "@/lib/host/fleet-update/borrowed-status-read";
import {
  resetFleetReadGateForTest,
  runWithFleetReadSlot,
} from "@/lib/host/fleet-update/fleet-read-gate";
import { FLEET_MAX_CONCURRENT_READS } from "@/lib/host/fleet-update/fleet-poll-policy";

// G10(a): `observationFromStatus` builds a PROVISIONAL observation with a
// synthetic `freshUntilMs: Number.POSITIVE_INFINITY` so the projection it
// needs to compute the real deadline has something to project from — and the
// module's own comment says that value must never escape the function. A test
// that only checked one call site could miss a code path (a new early return,
// a future arm) that skips the deadline-overwrite spread.

const NOW_MS = 42_000;

function attemptOperation(
  overrides: Partial<Extract<HostStatusUpdateOperation, { kind: "attempt" }>>,
): HostStatusUpdateOperation {
  return {
    kind: "attempt",
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    targetVersion: "2.1.0",
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
    ...overrides,
  };
}

function status(
  operation: HostStatusUpdateOperation | null,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion: "1.5.0",
    protocolVersion: { major: 1, minor: 3 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: operation,
    updateTransaction:
      operation === null
        ? null
        : { recordSchemaVersion: 2, authority: "attempt" },
  };
}

describe("observationFromStatus — the synthetic placeholder never escapes", () => {
  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly operation: HostStatusUpdateOperation | null;
  }> = [
    { name: "null operation (pre-1.3 peer)", operation: null },
    { name: "{ kind: 'none' }", operation: { kind: "none" } },
    {
      name: "{ kind: 'unavailable' }",
      operation: { kind: "unavailable", reason: "corrupt", cause: null },
    },
    {
      name: "active attempt (downloading — the fast-poll lane)",
      operation: attemptOperation({
        phase: "downloading",
        execution: "active",
      }),
    },
    {
      name: "parked attempt (waiting-to-activate)",
      operation: attemptOperation({
        phase: "waiting-to-activate",
        execution: "parked",
      }),
    },
    {
      name: "terminal attempt (failed)",
      operation: attemptOperation({ phase: "failed", execution: "terminal" }),
    },
    {
      name: "interrupted liveness (projects failed via the liveness override)",
      operation: attemptOperation({ liveness: "interrupted" }),
    },
  ];

  it.each(CASES)("finite deadline for: $name", ({ operation }) => {
    const observation = observationFromStatus({
      hostId: "host-a",
      status: status(operation),
      nowMs: NOW_MS,
    });
    expect(Number.isFinite(observation.freshUntilMs)).toBe(true);
    expect(observation.freshUntilMs).not.toBe(Number.POSITIVE_INFINITY);
    expect(observation.freshUntilMs).not.toBe(Number.NEGATIVE_INFINITY);
  });

  it("defaults `source` to 'borrowed' when the caller does not name one", () => {
    const observation = observationFromStatus({
      hostId: "host-a",
      status: status(attemptOperation({})),
      nowMs: NOW_MS,
    });
    expect(observation.source).toBe("borrowed");
  });
});

// The wiring proof this module needs alongside `fleet-read-gate.test.ts`'s
// bound-in-isolation suite: `fleet-read-gate.test.ts` proves the SEMAPHORE
// works; nothing proved that `readUpdateStatusOverBorrowedSession` actually
// ENTERS it. Ten hosts all eventually resolving (the fleet-hook integration
// suite) is consistent with `runWithFleetReadSlot` being dead code — every
// read would still complete on its own, just without ever being bounded. This
// is the binary version of that claim: does the transport get touched before
// the gate says so, yes or no.
interface FakeSession extends IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  sendUnaryCalls: number;
}

function readySession(): FakeSession {
  const session: FakeSession = {
    sendUnaryCalls: 0,
    start: vi.fn(),
    isClosed: () => false,
    isReady: () => true,
    sendUnary: ((method: string) => {
      session.sendUnaryCalls += 1;
      if (method !== "host.status") {
        return Promise.reject(new Error(`not exercised: ${method}`));
      }
      return Promise.resolve(status(null));
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

// The borrowed read never consults sweep eligibility; one sweep-eligible
// policy serves both acquires this suite makes.
const BORROW_READ_POLICY: RemoteSessionAcquirePolicy = {
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  retireAllRemoteSessions();
  resetRemoteSessionReadinessListenersForTest();
  resetFleetReadGateForTest();
});

describe("readUpdateStatusOverBorrowedSession — actually enters the fleet read gate", () => {
  it("with every gate slot held, a borrowed read for a READY session does NOT dispatch until a slot frees", async () => {
    // Fill the gate to capacity with tasks whose completion is under our
    // control.
    const holders = Array.from({ length: FLEET_MAX_CONCURRENT_READS }, () =>
      deferred<void>(),
    );
    const holderRuns = holders.map((gate) =>
      runWithFleetReadSlot(() => gate.promise),
    );
    await Promise.resolve();
    await Promise.resolve();

    // A genuinely BORROWABLE session — required so a `sendUnary` count of
    // zero later means "queued behind the gate", not "nothing to call". The
    // borrow is taken before the gate is entered (module doc), so an
    // unborrowable host would decline for an unrelated reason and this
    // assertion would pass vacuously.
    const hostId = "host-gated";
    const session = readySession();
    const owner = acquireRemoteSession(
      remoteIdentity(hostId),
      BORROW_READ_POLICY,
      () => session,
    );

    const readPromise = readUpdateStatusOverBorrowedSession({
      hostId,
      now: () => Date.now(),
      abortSignal: null,
    });

    // Let every microtask this call could possibly need to reach `sendUnary`
    // run, with no slot yet free.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.sendUnaryCalls).toBe(0);

    // Free exactly one slot — the read is queued behind the gate, so it
    // should now be free to dispatch and resolve normally.
    holders[0].resolve();
    const observation = await readPromise;
    expect(session.sendUnaryCalls).toBe(1);
    expect(observation).not.toBeNull();
    expect(observation?.hostId).toBe(hostId);

    holders.slice(1).forEach((gate) => {
      gate.resolve();
    });
    await Promise.all(holderRuns);
    owner.close();
  });

  it("stamps observedAtMs AFTER the queue wait, not at call time", async () => {
    // The defect this pins: with more borrowable hosts than gate slots, a
    // later read waits behind whole round trips and then stamped a timestamp
    // taken before the wait. `freshUntilMs` derives from that same instant, so
    // an actively-updating host on the ~2s cadence could receive a deadline
    // that had already expired by the time its read returned.
    //
    // The clock only advances while the read is QUEUED, so a call-time stamp
    // and a post-read stamp are distinguishable by construction.
    const holders = Array.from({ length: FLEET_MAX_CONCURRENT_READS }, () =>
      deferred<void>(),
    );
    const holderRuns = holders.map((gate) =>
      runWithFleetReadSlot(() => gate.promise),
    );
    await Promise.resolve();
    await Promise.resolve();

    const hostId = "host-stamp-after-queue";
    const session = readySession();
    const owner = acquireRemoteSession(
      remoteIdentity(hostId),
      BORROW_READ_POLICY,
      () => session,
    );

    const CALL_TIME_MS = 1_000_000;
    const QUEUE_WAIT_MS = 5_000;
    let clock = CALL_TIME_MS;
    const readPromise = readUpdateStatusOverBorrowedSession({
      hostId,
      now: () => clock,
      abortSignal: null,
    });

    await Promise.resolve();
    await Promise.resolve();
    // Time passes WHILE the read is stuck behind the gate.
    clock = CALL_TIME_MS + QUEUE_WAIT_MS;
    holders[0].resolve();
    const observation = await readPromise;

    expect(observation?.observedAtMs).toBe(CALL_TIME_MS + QUEUE_WAIT_MS);
    // Stated as the inequality the defect violates, so this still fails if the
    // stamp drifts back upstream by some other route.
    expect(observation?.observedAtMs).toBeGreaterThan(CALL_TIME_MS);

    holders.slice(1).forEach((gate) => {
      gate.resolve();
    });
    await Promise.all(holderRuns);
    owner.close();
  });
});
