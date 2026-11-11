import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { silentAuthorityLog } from "../../host-selection/selection-authority-engine";
import { createInProcessSelectionAuthorityClient } from "../../host-selection/in-process-selection-authority";
import { SelectionEvidenceKernel } from "../../host-selection/selection-evidence-kernel";
import {
  createFakeAuthorityClock,
  createRecordingAuthorityLog,
  createTestAuthority,
  findLease,
  fleetHost,
  type RecordingAuthorityLog,
} from "../../host-selection/__tests__/selection-authority-harness";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import {
  FakeNativeWebSocket,
  NEVER_MS,
  settle,
} from "../../test-fixtures/dial-gate-harness";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import { createWhatwgStreamWebSocketFactory } from "../whatwg-stream-ws-factory";
import { hostDialGate } from "../ws-dial-gate";
import { WsStreamClient } from "../ws-stream-client";

const DIAL_TIMEOUT_MS = 10_000;
const SESSIONS_PER_STALL = 6;
const REDIAL_BACKOFF_MS = 50;
const DIAL_EVIDENCE_MESSAGE = "[selection-authority] dial evidence";

interface Rig {
  readonly log: RecordingAuthorityLog;
  readonly leaseStatus: (hostId: string) => string | undefined;
  readonly startStalledSessions: (
    hostId: string,
    count: number,
    redialBackoffMs: number,
  ) => void;
}

/**
 * The real selection engine behind a real evidence kernel, with the given
 * hosts in its fleet: a host outside the fleet has its reports dropped.
 */
async function startRig(
  cleanups: Array<() => void>,
  hostIds: readonly string[],
): Promise<Rig> {
  const log = createRecordingAuthorityLog();
  const authority = createTestAuthority({
    initialFleet: {
      identityGeneration: 0,
      localHostId: null,
      hosts: hostIds.map((hostId) => fleetHost(hostId, "remote")),
    },
    initialIdentityKey: "acct-1",
    clock: createFakeAuthorityClock(0),
    log,
  });
  const client = createInProcessSelectionAuthorityClient(
    authority.engine,
    silentAuthorityLog,
  );
  const kernel = new SelectionEvidenceKernel({
    client,
    now: () => 0,
    log: silentAuthorityLog,
  });
  cleanups.push(() => {
    kernel.dispose();
    client.dispose();
    authority.dispose();
  });
  await kernel.start();

  const ctx = createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: "token-abc",
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
  return {
    log,
    leaseStatus: (hostId) =>
      findLease(kernel.snapshot().leases, hostId)?.status,
    startStalledSessions: (hostId, count, redialBackoffMs) => {
      const streams = new WsStreamClient({
        clientIdentity: TEST_CLIENT_IDENTITY,
        registry: hostStreamRpcRegistry,
        endpoint: () => ({ ...mockLocalHostEntry, hostId }),
        hostId,
        bearer: () => ctx.credentials,
        userId: ctx.identity.userId,
        auth: null,
        clock: null,
        hostCredentialMint: null,
        onHostCredentialState: null,
        evidence: kernel,
        webSocketFactory: createWhatwgStreamWebSocketFactory(),
        dialTimeoutMs: DIAL_TIMEOUT_MS,
        openAckTimeoutMs: NEVER_MS,
        pingIntervalMs: NEVER_MS,
        pongTimeoutMs: NEVER_MS,
        initialBackoffMs: redialBackoffMs,
        maxBackoffMs: redialBackoffMs,
      });
      for (let index = 0; index < count; index += 1) {
        const session = streams.subscribe("epic.subscribe", {
          epicId: `epic-${hostId}-${index}`,
        });
        cleanups.push(() => {
          session.close();
        });
      }
    },
  };
}

interface DialDisposition {
  readonly disposition: unknown;
  readonly refusalStreak: unknown;
}

/** What the engine did with each dial report for one host, in arrival order. */
function dispositionsFor(
  log: RecordingAuthorityLog,
  hostId: string,
): DialDisposition[] {
  return log.records
    .filter(
      (record) =>
        record.message === DIAL_EVIDENCE_MESSAGE &&
        record.detail["hostId"] === hostId,
    )
    .map((record) => ({
      disposition: record.detail["disposition"],
      refusalStreak: record.detail["refusalStreak"],
    }));
}

function countedDispositions(dispositions: readonly DialDisposition[]): number {
  return dispositions.filter(
    (entry) =>
      entry.disposition === "counted" ||
      entry.disposition === "counted-reached-death",
  ).length;
}

describe("stream dial timeouts as reachability evidence", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    // A real socket reports its close after close() is called; the fake does
    // not, so every slot still held is handed back here.
    for (const native of FakeNativeWebSocket.instances) {
      native.fireClose(1006, "test-cleanup");
    }
    await settle();
    expect(hostDialGate.stats()).toMatchObject({ connecting: 0, queued: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("counts one stall once, however many streams it caught", async () => {
    const hostId = "host-one-stall";
    const rig = await startRig(cleanups, [hostId]);
    rig.startStalledSessions(hostId, SESSIONS_PER_STALL, NEVER_MS);
    await settle();
    expect(FakeNativeWebSocket.instances).toHaveLength(SESSIONS_PER_STALL);

    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS);

    const dispositions = dispositionsFor(rig.log, hostId);
    expect(dispositions).toHaveLength(SESSIONS_PER_STALL);
    expect(countedDispositions(dispositions)).toBe(1);
    expect(
      dispositions.filter(
        (entry) => entry.disposition === "inert-indeterminate",
      ),
    ).toHaveLength(SESSIONS_PER_STALL - 1);
    expect(rig.leaseStatus(hostId)).toBe("connecting");
  });

  it("still calls a host that never answers dead, one counted timeout per round", async () => {
    const hostId = "host-never-answers";
    const rig = await startRig(cleanups, [hostId]);
    rig.startStalledSessions(hostId, SESSIONS_PER_STALL, REDIAL_BACKOFF_MS);
    await settle();

    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS);
    expect(countedDispositions(dispositionsFor(rig.log, hostId))).toBe(1);
    expect(rig.leaseStatus(hostId)).toBe("connecting");

    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS + REDIAL_BACKOFF_MS);
    expect(countedDispositions(dispositionsFor(rig.log, hostId))).toBe(2);
    expect(rig.leaseStatus(hostId)).toBe("connecting");

    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS + REDIAL_BACKOFF_MS);
    expect(countedDispositions(dispositionsFor(rig.log, hostId))).toBe(3);
    expect(rig.leaseStatus(hostId)).toBe("dead");
  });

  it("keeps rounds per host, so a second host stalling behind the first still counts", async () => {
    const hostA = "host-round-a";
    const hostB = "host-round-b";
    const rig = await startRig(cleanups, [hostA, hostB]);
    rig.startStalledSessions(hostA, 1, NEVER_MS);
    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS / 2);
    // Dialed before host A times out and timing out after it: a round shared
    // between hosts would take this as already counted.
    rig.startStalledSessions(hostB, 1, NEVER_MS);
    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS / 2);
    expect(dispositionsFor(rig.log, hostA)).toEqual([
      { disposition: "counted", refusalStreak: 1 },
    ]);
    expect(dispositionsFor(rig.log, hostB)).toEqual([]);

    await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS / 2);

    expect(dispositionsFor(rig.log, hostB)).toEqual([
      { disposition: "counted", refusalStreak: 1 },
    ]);
    expect(rig.leaseStatus(hostA)).toBe("connecting");
    expect(rig.leaseStatus(hostB)).toBe("connecting");
  });
});
