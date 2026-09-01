/**
 * HIGH-2 / MEDIUM-4 / MEDIUM-7: a REAL artifact-room tier with a non-null
 * budget sink. Bytes govern below the count cap of 32; pinned rooms report
 * `leased` and are never demoted; evictionEffectiveness is read through
 * collectReplicaMemoryTelemetry against a real eviction.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import * as Y from "yjs";
import type {
  EvictionOutcome,
  LeaseGrant,
  LeaseHandle,
  MemoryAccountant,
  RuntimeEnvironment,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  createMemoryAccountant,
  createMonotonicSequence,
} from "@traycer-clients/shared/replica-runtime";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  ARTIFACT_ROOM_LEASE_POLICY,
  createArtifactRoomTier,
  type ArtifactRoomTier,
} from "@/stores/epics/open-epic/runtime/artifact-room-tier";
import type { EpicSessionFacts } from "@/stores/epics/open-epic/runtime/session-facts";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import type { EpicOutboundRequest } from "@/stores/epics/open-epic/runtime/epic-runtime-events";
import { HOT_DOCS_MAX_MATERIALIZED } from "@/stores/replica-memory/budget-limits";
import {
  createHotDocBudgetBook,
  hotDocHolderId,
  type HotDocBudgetSink,
} from "@/stores/replica-memory/hot-doc-budget";
import { createChatWindowBudgetBook } from "@/stores/replica-memory/chat-window-budget";
import { createEpicReplicaBudgetBook } from "@/stores/replica-memory/epic-replica-budget";
import {
  collectReplicaMemoryTelemetry,
  type ReplicaMemoryTelemetry,
} from "@/stores/replica-memory/memory-telemetry";
import type { ProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";

function createFakeEnvironment(): RuntimeEnvironment & {
  advanceClock(ms: number): void;
} {
  let nowMs = 0;
  const pendingTimers: {
    fireAt: number;
    callback: () => void;
    cancelled: boolean;
  }[] = [];
  return {
    clock: {
      now(): number {
        return nowMs;
      },
    },
    scheduler: {
      schedule(delayMs: number, callback: () => void): RuntimeTimer {
        const entry = { fireAt: nowMs + delayMs, callback, cancelled: false };
        pendingTimers.push(entry);
        return {
          cancel(): void {
            entry.cancelled = true;
          },
        };
      },
      scheduleMicrotask(callback: () => void): void {
        callback();
      },
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    advanceClock(ms: number): void {
      nowMs += ms;
      const due = pendingTimers.filter(
        (entry) => !entry.cancelled && entry.fireAt <= nowMs,
      );
      for (const entry of due) {
        if (entry.cancelled) continue;
        entry.cancelled = true;
        entry.callback();
      }
    },
  };
}

interface FakeSessionState {
  transportStatus: StreamConnectionStatus;
  permissionRole: PermissionRole | null;
  hasFreshRootSnapshotForOpenCycle: boolean;
  canSendBodyWrites: boolean;
}

function createFakeSession(): EpicSessionFacts & {
  readonly state: FakeSessionState;
} {
  const state: FakeSessionState = {
    transportStatus: "open",
    permissionRole: "owner",
    hasFreshRootSnapshotForOpenCycle: true,
    canSendBodyWrites: true,
  };
  return {
    state,
    transportStatus: () => state.transportStatus,
    permissionRole: () => state.permissionRole,
    writeGateRole: () => state.permissionRole,
    isWritableRole: () =>
      state.permissionRole !== "viewer" && state.permissionRole !== null,
    hasFreshRootSnapshotForOpenCycle: () =>
      state.hasFreshRootSnapshotForOpenCycle,
    canSendBodyWrites: () => state.canSendBodyWrites,
    degradedReason: () => null,
  };
}

function makeSnapshotBytes(text: string): {
  bytes: Uint8Array;
  hostStateVectorBase64: string;
} {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc);
  const hostStateVectorBase64 = encodeDocStateVectorBase64(doc);
  doc.destroy();
  return { bytes, hostStateVectorBase64 };
}

function leaseOf(grant: LeaseGrant<unknown>): LeaseHandle {
  if (grant.kind === "unavailable") {
    throw new Error(
      `expected a lease-bearing grant, got "unavailable": ${grant.reason}`,
    );
  }
  return grant.lease;
}

interface BudgetedHarness {
  readonly tier: ArtifactRoomTier;
  readonly accountant: MemoryAccountant;
  readonly demote: Mock<(overBytes: number) => EvictionOutcome>;
  readonly settle: Mock<(id: string, bytes: number) => void>;
  readonly chargeProvisional: Mock<(id: string, bytes: number) => void>;
  readonly demoteOutcomes: EvictionOutcome[];
  readonly runtime: ProcessMemoryRuntime;
  readonly hostId: string;
  readonly epicId: string;
  readonly runtimeToken: string;
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function createBudgetedHarness(softLimitBytes: number): BudgetedHarness {
  const environment = createFakeEnvironment();
  const session = createFakeSession();
  const accountant = createMemoryAccountant({
    environment,
    observedCeilingBytes: 10_000_000,
  });
  const hotDocs = createHotDocBudgetBook();
  const chatWindows = createChatWindowBudgetBook();
  const epicReplicas = createEpicReplicaBudgetBook();
  accountant.register({
    planeId: BUDGET_PLANE_IDS.hotDocs,
    softLimitBytes,
    nearThresholdRatio: 0.8,
    evict: (overBytes) => hotDocs.evict(overBytes),
  });
  accountant.register({
    planeId: BUDGET_PLANE_IDS.chatWindows,
    softLimitBytes: 10_000_000,
    nearThresholdRatio: 0.8,
    evict: () => ({ reclaimedBytes: 0, protectedBytesByKind: [] }),
  });
  accountant.register({
    planeId: BUDGET_PLANE_IDS.epicReplicas,
    softLimitBytes: 10_000_000,
    nearThresholdRatio: 0.8,
    evict: () => ({ reclaimedBytes: 0, protectedBytesByKind: [] }),
  });

  const hostId = "host-a";
  const epicId = "epic-1";
  const runtimeToken = "rt-1";
  const settle = vi.fn((artifactRoomId: string, bytes: number): void => {
    hotDocs.settle(
      accountant,
      hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
      bytes,
    );
    accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);
  });
  const chargeProvisional = vi.fn(
    (artifactRoomId: string, bytes: number): void => {
      hotDocs.chargeProvisional(
        accountant,
        hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
        bytes,
      );
    },
  );
  const sink: HotDocBudgetSink = {
    settle,
    settleCold() {},
    chargeProvisional,
    release(artifactRoomId) {
      hotDocs.release(
        accountant,
        hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
      );
    },
  };
  const sent: EpicOutboundRequest[] = [];
  const tier = createArtifactRoomTier({
    environment,
    session,
    send: (request) => {
      sent.push(request);
      return { kind: "sent" };
    },
    onDivergenceChanged: () => undefined,
    isDisposed: () => false,
    budget: sink,
  });
  disposers.push(() => tier.dispose());
  const demoteOutcomes: EvictionOutcome[] = [];
  const demote = vi.fn((overBytes: number): EvictionOutcome => {
    const outcome = tier.demoteColdestUnpinned(overBytes);
    demoteOutcomes.push(outcome);
    return outcome;
  });
  hotDocs.attach({
    key: `${hostId}:${epicId}:${runtimeToken}`,
    materializedIds: () => tier.materializedIds(),
    demoteColdestUnpinned: demote,
  });
  const recency = createMonotonicSequence();
  const tokens = createMonotonicSequence();
  const runtime: ProcessMemoryRuntime = {
    accountant,
    chatWindows,
    hotDocs,
    epicReplicas,
    observedCeilingBytes: 10_000_000,
    recency,
    nextRuntimeToken(): string {
      return String(tokens.next());
    },
    stampChatRecency(): number {
      return recency.next();
    },
  };
  return {
    tier,
    accountant,
    demote,
    settle,
    chargeProvisional,
    demoteOutcomes,
    runtime,
    hostId,
    epicId,
    runtimeToken,
  };
}

function seedUnpinned(
  tier: ArtifactRoomTier,
  roomId: string,
  text: string,
): void {
  const snapshot = makeSnapshotBytes(text);
  expect(
    tier.applySnapshot({
      artifactRoomId: roomId,
      snapshotBytes: snapshot.bytes,
      hostStateVectorBase64: snapshot.hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    }),
  ).toBe("filed-cold");
  const grant = tier.acquireSync(roomId);
  expect(tier.peek(roomId)).not.toBeNull();
  leaseOf(grant).release();
}

describe("hot-doc holder identity", () => {
  it("scopes holders by host and runtime token", () => {
    expect(hotDocHolderId("h1", "e", "t1", "room")).not.toBe(
      hotDocHolderId("h2", "e", "t1", "room"),
    );
    expect(hotDocHolderId("h1", "e", "t1", "room")).not.toBe(
      hotDocHolderId("h1", "e", "t2", "room"),
    );
  });

  it("is injective - a `:` inside one segment must not fold two distinct tuples onto the same holder id", () => {
    // THE REDDENING ONE.
    expect(hotDocHolderId("host:a", "b", "t", "room")).not.toBe(
      hotDocHolderId("host", "a:b", "t", "room"),
    );
  });

  it("the loser of a replaceMounted-shaped re-point does not release the winner", () => {
    const environment = createFakeEnvironment();
    const accountant = createMemoryAccountant({
      environment,
      observedCeilingBytes: 10_000,
    });
    const book = createHotDocBudgetBook();
    accountant.register({
      planeId: BUDGET_PLANE_IDS.hotDocs,
      softLimitBytes: 10_000,
      nearThresholdRatio: 0.8,
      evict: (overBytes) => book.evict(overBytes),
    });
    book.attach({
      key: "host-a:epic-1:token-a",
      materializedIds: () => ["room"],
      demoteColdestUnpinned: () => ({
        reclaimedBytes: 0,
        protectedBytesByKind: [],
      }),
    });
    book.settle(
      accountant,
      hotDocHolderId("host-a", "epic-1", "token-a", "room"),
      100,
    );
    book.attach({
      key: "host-b:epic-1:token-b",
      materializedIds: () => ["room"],
      demoteColdestUnpinned: () => ({
        reclaimedBytes: 0,
        protectedBytesByKind: [],
      }),
    });
    book.settle(
      accountant,
      hotDocHolderId("host-b", "epic-1", "token-b", "room"),
      200,
    );
    book.detach("host-a:epic-1:token-a");
    book.release(
      accountant,
      hotDocHolderId("host-a", "epic-1", "token-a", "room"),
    );
    const usage = accountant
      .snapshot()
      .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.hotDocs);
    expect(usage?.settledBytes).toBe(200);
    expect(usage?.holderCount).toBe(1);
    expect(book.docsResident()).toBe(1);
  });
});

describe("hot-doc byte budget with a real tier", () => {
  it("demotes unpinned rooms below the count cap when bytes are over", () => {
    const snapshot = makeSnapshotBytes("x".repeat(200));
    const harness = createBudgetedHarness(
      Math.max(1, Math.floor(snapshot.bytes.byteLength / 2)),
    );
    seedUnpinned(harness.tier, "room-0", "x".repeat(200));
    seedUnpinned(harness.tier, "room-1", "x".repeat(200));
    seedUnpinned(harness.tier, "room-2", "x".repeat(200));
    seedUnpinned(harness.tier, "room-3", "x".repeat(200));

    expect(harness.demote).toHaveBeenCalled();
    expect(harness.tier.materializedIds().length).toBeLessThan(4);
    expect(harness.tier.materializedIds().length).toBeLessThan(
      HOT_DOCS_MAX_MATERIALIZED,
    );
    expect(harness.tier.materializedIds().length).toBeLessThan(
      ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized,
    );

    const telemetry: ReplicaMemoryTelemetry = collectReplicaMemoryTelemetry(
      harness.runtime,
    );
    expect(telemetry.evictionEffectiveness.evictionsRequested).toBeGreaterThan(
      0,
    );
    expect(telemetry.evictionEffectiveness.bytesReclaimed).toBeGreaterThan(0);
    expect(telemetry.docsResident).toBe(harness.tier.materializedIds().length);
  });

  it("reports pinned rooms as leased and never demotes them", () => {
    const snapshot = makeSnapshotBytes("x".repeat(200));
    const harness = createBudgetedHarness(
      Math.max(1, Math.floor(snapshot.bytes.byteLength / 2)),
    );
    const pinned = makeSnapshotBytes("pinned body");
    expect(
      harness.tier.applySnapshot({
        artifactRoomId: "room-pinned",
        snapshotBytes: pinned.bytes,
        hostStateVectorBase64: pinned.hostStateVectorBase64,
        seed: "full",
        docGuid: null,
      }),
    ).toBe("filed-cold");
    const pinnedGrant = harness.tier.acquireSync("room-pinned");
    seedUnpinned(harness.tier, "room-cold-a", "x".repeat(200));
    seedUnpinned(harness.tier, "room-cold-b", "x".repeat(200));

    expect(harness.tier.peek("room-pinned")).not.toBeNull();
    expect(harness.demote).toHaveBeenCalled();
    // Asserted rather than guarded: the index type is not nullable, so the old
    // `=== undefined` branch was unreachable and proved nothing. This says the
    // same thing where it can actually fail.
    expect(harness.demoteOutcomes.length).toBeGreaterThan(0);
    const outcome = harness.demoteOutcomes[harness.demoteOutcomes.length - 1];
    expect(
      outcome.protectedBytesByKind.some((entry) => entry.kind === "leased"),
    ).toBe(true);
    expect(harness.tier.materializedIds()).toContain("room-pinned");
    leaseOf(pinnedGrant).release();
  });

  it("the count cap still fires at 32 independently of the byte budget", () => {
    const harness = createBudgetedHarness(10_000_000);
    for (let index = 0; index < HOT_DOCS_MAX_MATERIALIZED + 1; index += 1) {
      seedUnpinned(harness.tier, `room-${index}`, `body ${index}`);
    }
    expect(harness.tier.materializedIds().length).toBe(
      HOT_DOCS_MAX_MATERIALIZED,
    );
  });

  it("re-settles hot growth at a bounded cadence, not per update", () => {
    const harness = createBudgetedHarness(10_000_000);
    seedUnpinned(harness.tier, "room-grow", "seed");
    harness.settle.mockClear();
    harness.chargeProvisional.mockClear();

    const small = makeSnapshotBytes("y".repeat(40));
    const entry = harness.tier.peek("room-grow");
    if (entry === null) {
      throw new Error("expected room-grow to stay hot after seed");
    }
    harness.tier.applyUpdate(
      "room-grow",
      small.bytes,
      small.hostStateVectorBase64,
    );
    expect(harness.chargeProvisional).toHaveBeenCalled();
    expect(harness.settle).not.toHaveBeenCalled();

    let rounds = 0;
    while (harness.settle.mock.calls.length === 0 && rounds < 20) {
      const chunk = makeSnapshotBytes(`chunk ${rounds} `.repeat(4_000));
      harness.tier.applyUpdate(
        "room-grow",
        chunk.bytes,
        chunk.hostStateVectorBase64,
      );
      rounds += 1;
    }
    expect(harness.settle).toHaveBeenCalled();
    expect(rounds).toBeGreaterThan(1);
  });

  it("demote of a quiet room reports the settled charge", () => {
    const harness = createBudgetedHarness(10_000_000);
    seedUnpinned(harness.tier, "room-quiet", "seed");
    const chargedAtHot =
      harness.accountant
        .snapshot()
        .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.hotDocs)
        ?.settledBytes ?? 0;
    expect(chargedAtHot).toBeGreaterThan(0);
    const outcome = harness.tier.demoteColdestUnpinned(1_000_000);
    expect(outcome.reclaimedBytes).toBe(chargedAtHot);
  });

  it("demote reports settled plus provisional when the room has grown", () => {
    const harness = createBudgetedHarness(10_000_000);
    seedUnpinned(harness.tier, "room-stale", "seed");
    const extra = makeSnapshotBytes("y".repeat(80));
    harness.tier.applyUpdate(
      "room-stale",
      extra.bytes,
      extra.hostStateVectorBase64,
    );
    const usage = harness.accountant
      .snapshot()
      .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.hotDocs);
    if (usage === undefined) {
      throw new Error("expected hot-docs plane");
    }
    expect(usage.provisionalBytes).toBeGreaterThan(0);
    const outcome = harness.tier.demoteColdestUnpinned(1_000_000);
    expect(outcome.reclaimedBytes).toBe(
      usage.settledBytes + usage.provisionalBytes,
    );
    expect(
      harness.accountant
        .snapshot()
        .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.hotDocs)
        ?.holderCount ?? -1,
    ).toBe(0);
  });

  it("a reconnect snapshot on a leased room charges the merge growth", () => {
    const harness = createBudgetedHarness(10_000_000);
    const seed = makeSnapshotBytes("seed");
    expect(
      harness.tier.applySnapshot({
        artifactRoomId: "room-leased",
        snapshotBytes: seed.bytes,
        hostStateVectorBase64: seed.hostStateVectorBase64,
        seed: "full",
        docGuid: null,
      }),
    ).toBe("filed-cold");
    const grant = harness.tier.acquireSync("room-leased");
    expect(harness.tier.peek("room-leased")).not.toBeNull();
    harness.settle.mockClear();
    harness.chargeProvisional.mockClear();
    const before = harness.accountant.snapshot().totalChargedBytes;

    const reconnect = makeSnapshotBytes("x".repeat(80_000));
    expect(
      harness.tier.applySnapshot({
        artifactRoomId: "room-leased",
        snapshotBytes: reconnect.bytes,
        hostStateVectorBase64: reconnect.hostStateVectorBase64,
        seed: "full",
        docGuid: null,
      }),
    ).toBe("merged");
    expect(
      harness.settle.mock.calls.length +
        harness.chargeProvisional.mock.calls.length,
    ).toBeGreaterThan(0);
    expect(harness.accountant.snapshot().totalChargedBytes).toBeGreaterThan(
      before,
    );
    leaseOf(grant).release();
  });
});
