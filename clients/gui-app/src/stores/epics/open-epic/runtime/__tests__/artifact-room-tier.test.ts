/**
 * Behavioural coverage for `createArtifactRoomTier` — the hot/cold artifact
 * room lease registry.
 *
 * Pins, per the module doc and the invariants written down beside each
 * closure in `artifact-room-tier.ts`:
 *
 *  1. `isPinned`'s three independent arms (lease / local divergence / remote
 *     awareness peers), each verified via `demoteIdle()` against an otherwise
 *     identical unpinned control room that DOES demote.
 *  2. The cooldown timer demotes an unpinned room after
 *     `ARTIFACT_ROOM_LEASE_POLICY.cooldownMs`, driven by the injected
 *     `RuntimeEnvironment` scheduler rather than vitest fake timers, and
 *     releasing a lease re-arms it.
 *  3. `applySnapshot`'s three outcomes: `"filed-cold"` / `"seeded"` /
 *     `"merged"`.
 *  4. `materialize` (via `acquireSync`) returns nothing to `peek` for a
 *     never-seeded room — no fabricated empty doc, and the grant is
 *     `"awaiting-seed"` WITH a lease rather than a refusal.
 *  5. Cold awareness frames are bounded at `COLD_ROOM_AWARENESS_FRAMES` (32)
 *     and replayed on materialization.
 *
 * Real `Y.Doc` / `Awareness` objects throughout; fakes only at the
 * `RuntimeEnvironment` / `EpicSessionFacts` / transport boundary, matching
 * `open-epic/__tests__` convention.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type {
  LeaseGrant,
  LeaseHandle,
  RuntimeEnvironment,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  ARTIFACT_ROOM_LEASE_POLICY,
  createArtifactRoomTier,
  type ArtifactRoomReplicaEntry,
  type ArtifactRoomTier,
} from "../artifact-room-tier";
import { HOT_DOCS_MAX_MATERIALIZED } from "@/stores/replica-memory/budget-limits";
import type { EpicSessionFacts } from "../session-facts";
import { encodeDocStateVectorBase64 } from "../dirty-watermark";
import type { EpicOutboundRequest } from "../epic-runtime-events";

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * A controllable clock/scheduler with no real timers — the injected seam
 * used INSTEAD OF `vi.useFakeTimers`, mirroring
 * `replica-runtime-seam.test.ts`'s `createFakeEnvironment`.
 */
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
      // Fire in insertion order, snapshotting the due set first so a re-arm
      // scheduled BY a firing callback is not drained within this same
      // advance — matching a real scheduler's next tick, not an eager loop.
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

/** A mutable `EpicSessionFacts` fake, defaulting to a writable, fully-open session. */
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

interface TestHarness {
  readonly tier: ArtifactRoomTier;
  readonly environment: RuntimeEnvironment & {
    advanceClock(ms: number): void;
  };
  readonly session: EpicSessionFacts & { readonly state: FakeSessionState };
  readonly sent: EpicOutboundRequest[];
}

// No override parameter. It was an unused `overrides?: Partial<...>` - both an
// ESLint-banned optional parameter and dead surface, since no call site ever
// passed one. A test that needs a different source builds the tier directly;
// re-adding a spread-over-defaults hole would let a future override silently
// replace a source this harness is asserting through.
function createHarness(): TestHarness {
  const environment = createFakeEnvironment();
  const session = createFakeSession();
  const sent: EpicOutboundRequest[] = [];
  const tier = createArtifactRoomTier({
    environment,
    session,
    send: (request) => sent.push(request),
    onDivergenceChanged: () => undefined,
    isDisposed: () => false,
    budget: null,
  });
  return { tier, environment, session, sent };
}

/** Encodes a fresh `Y.Doc` containing `text` as a full snapshot, plus its base64 state vector. */
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

/** Fails loudly instead of silently narrowing — `peek()`'s null covers both
 * "cold" and "unknown", so a test that expects hot must say so explicitly. */
function requireHotEntry(
  tier: ArtifactRoomTier,
  roomId: string,
): ArtifactRoomReplicaEntry {
  const entry = tier.peek(roomId);
  if (entry === null) {
    throw new Error(`expected artifact room "${roomId}" to be materialized`);
  }
  return entry;
}

/**
 * A single-client awareness update naming a distinct, deterministic remote
 * peer. `clientID` is set directly on the scratch doc (not left to Yjs's
 * random assignment) so 40 of these are guaranteed pairwise distinct — load
 * bearing for the frame-bound test, which counts distinct clients after
 * replay.
 */
function remoteAwarenessFrame(clientId: number): Uint8Array {
  const scratchDoc = new Y.Doc();
  scratchDoc.clientID = clientId;
  const scratchAwareness = new Awareness(scratchDoc);
  scratchAwareness.setLocalState({ peer: clientId });
  const frame = encodeAwarenessUpdate(scratchAwareness, [clientId]);
  scratchAwareness.destroy();
  scratchDoc.destroy();
  return frame;
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function trackTierDisposal(tier: ArtifactRoomTier): void {
  disposers.push(() => tier.dispose());
}

// ─── 1. isPinned's three arms ───────────────────────────────────────────────

/**
 * The lease out of a grant, refusing the one arm that has none.
 *
 * Narrowing rather than a cast, and it earns its place twice: the shared
 * contract's rule is "if you got a lease, you release it", so a test that
 * silently skipped the release would leak demand into the next assertion - and
 * `"unavailable"` reaching here at all would mean the tier refused to register
 * demand for a room it should have, which is precisely the defect the
 * `"awaiting-seed"` arm exists to prevent.
 */
function leaseOf(grant: LeaseGrant<ArtifactRoomReplicaEntry>): LeaseHandle {
  if (grant.kind === "unavailable") {
    throw new Error(
      `expected a lease-bearing grant, got "unavailable": ${grant.reason}`,
    );
  }
  return grant.lease;
}

describe("ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized", () => {
  it("is the budget-limits constant, not a second copy of 32", () => {
    expect(ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized).toBe(
      HOT_DOCS_MAX_MATERIALIZED,
    );
  });
});

describe("isPinned — three independent arms, verified via demoteIdle()", () => {
  it("an unpinned control room (no lease, no divergence, no remote peers) demotes", () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    expect(
      tier.applySnapshot({
        artifactRoomId: "room-control",
        snapshotBytes: bytes,
        hostStateVectorBase64,
        seed: "full",
        docGuid: null,
      }),
    ).toBe("filed-cold");
    const leaseGrant = tier.acquireSync("room-control");
    requireHotEntry(tier, "room-control"); // sanity: materialized
    leaseOf(leaseGrant).release();

    tier.demoteIdle();

    expect(tier.peek("room-control")).toBeNull();
    expect(tier.materializedIds()).not.toContain("room-control");
  });

  it("an active lease keeps the room hot through demoteIdle()", () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    tier.applySnapshot({
      artifactRoomId: "room-leased",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const leaseGrant = tier.acquireSync("room-leased");
    requireHotEntry(tier, "room-leased");

    tier.demoteIdle();

    expect(tier.peek("room-leased")).not.toBeNull();
    expect(tier.materializedIds()).toContain("room-leased");
    expect(tier.leaseCount("room-leased")).toBe(1);

    leaseOf(leaseGrant).release();
  });

  it("local divergence (a queued/dirty local edit) keeps the room hot through demoteIdle()", () => {
    const { tier, session } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    tier.applySnapshot({
      artifactRoomId: "room-dirty",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const leaseGrant = tier.acquireSync("room-dirty");
    const entry = requireHotEntry(tier, "room-dirty");
    leaseOf(leaseGrant).release(); // drop the lease pin so divergence is the ONLY remaining arm

    session.state.permissionRole = "owner"; // writable — required for the doc-update handler to mark dirty
    entry.doc.getMap("body").set("local-edit", "1");

    expect(entry.dirtyWatermarkStateVectorBase64).not.toBeNull();
    expect(tier.hasDivergence()).toBe(true);

    tier.demoteIdle();

    expect(tier.peek("room-dirty")).not.toBeNull();
    expect(tier.materializedIds()).toContain("room-dirty");
  });

  it("a remote awareness peer keeps the room hot through demoteIdle()", () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    tier.applySnapshot({
      artifactRoomId: "room-peered",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const leaseGrant = tier.acquireSync("room-peered");
    requireHotEntry(tier, "room-peered");
    leaseOf(leaseGrant).release(); // drop the lease pin so the remote peer is the ONLY remaining arm

    tier.applyAwareness("room-peered", remoteAwarenessFrame(999));
    const entry = requireHotEntry(tier, "room-peered");
    // `Awareness` seeds its OWN clientID into `getStates()` on construction
    // (with a null state), so the baseline is 1, not 0 - one remote peer
    // brings it to 2. `hasRemotePeers()` accounts for this by excluding
    // `entry.awareness.clientID` before deciding, which is exactly what this
    // arm is pinning.
    expect(entry.awareness.getStates().size).toBe(2);
    expect(entry.awareness.getStates().has(999)).toBe(true);
    expect(entry.awareness.getStates().has(entry.awareness.clientID)).toBe(
      true,
    );

    tier.demoteIdle();

    expect(tier.peek("room-peered")).not.toBeNull();
    expect(tier.materializedIds()).toContain("room-peered");
  });
});

// ─── 2. Cooldown timer + re-arm on release ─────────────────────────────────

describe("cooldown timer", () => {
  it("demotes an unpinned room after cooldownMs, and releasing a lease re-arms it for the next elapse", () => {
    const { tier, environment } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    tier.applySnapshot({
      artifactRoomId: "room-cooldown",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const leaseGrant = tier.acquireSync("room-cooldown");
    requireHotEntry(tier, "room-cooldown");

    // While leased, no cooldown is armed at all — advancing past cooldownMs
    // must not demote a pinned room.
    environment.advanceClock(ARTIFACT_ROOM_LEASE_POLICY.cooldownMs);
    expect(tier.peek("room-cooldown")).not.toBeNull();

    // Releasing the lease re-arms the linger timer.
    leaseOf(leaseGrant).release();
    environment.advanceClock(ARTIFACT_ROOM_LEASE_POLICY.cooldownMs - 1);
    expect(tier.peek("room-cooldown")).not.toBeNull(); // not yet — one ms short

    environment.advanceClock(1);
    expect(tier.peek("room-cooldown")).toBeNull(); // cooldownMs fully elapsed — demoted

    // Re-materialize (the demoted bytes are retained cold) and re-lease, to
    // prove release RE-ARMS rather than firing once and going inert.
    const secondLeaseGrant = tier.acquireSync("room-cooldown");
    requireHotEntry(tier, "room-cooldown");
    leaseOf(secondLeaseGrant).release();

    environment.advanceClock(ARTIFACT_ROOM_LEASE_POLICY.cooldownMs);
    expect(tier.peek("room-cooldown")).toBeNull();
  });
});

// ─── 3. applySnapshot outcomes ──────────────────────────────────────────────

describe("applySnapshot outcomes", () => {
  it('returns "filed-cold" for a room with no lease and no prior replica', () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    const outcome = tier.applySnapshot({
      artifactRoomId: "room-cold",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });

    expect(outcome).toBe("filed-cold");
    expect(tier.peek("room-cold")).toBeNull();
  });

  it('returns "seeded" when a lease was already taken on an unseeded room', () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);

    const leaseGrant = tier.acquireSync("room-seeded");
    expect(tier.peek("room-seeded")).toBeNull(); // materialize() found nothing to bring up

    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");
    const outcome = tier.applySnapshot({
      artifactRoomId: "room-seeded",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });

    expect(outcome).toBe("seeded");
    expect(tier.peek("room-seeded")).not.toBeNull();

    leaseOf(leaseGrant).release();
  });

  it('returns "merged" when a replica already existed from a prior applySnapshot on the same id', () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const leaseGrant = tier.acquireSync("room-merged");

    const first = makeSnapshotBytes("first");
    expect(
      tier.applySnapshot({
        artifactRoomId: "room-merged",
        snapshotBytes: first.bytes,
        hostStateVectorBase64: first.hostStateVectorBase64,
        seed: "full",
        docGuid: null,
      }),
    ).toBe("seeded");

    const second = makeSnapshotBytes("first-and-second");
    const outcome = tier.applySnapshot({
      artifactRoomId: "room-merged",
      snapshotBytes: second.bytes,
      hostStateVectorBase64: second.hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });

    expect(outcome).toBe("merged");
    leaseOf(leaseGrant).release();
  });
});

// ─── 4. materialize returns nothing for a never-seeded room ────────────────

describe("materialize (via acquire) on a never-seeded room", () => {
  it("does not fabricate an empty doc — peek() is null right after acquire()", () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);

    const leaseGrant = tier.acquireSync("room-unseeded");

    expect(tier.peek("room-unseeded")).toBeNull();

    // Confirmed by the applySnapshot outcome on the SAME id: "seeded", never
    // "merged" — proving no doc existed before this snapshot.
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");
    expect(
      tier.applySnapshot({
        artifactRoomId: "room-unseeded",
        snapshotBytes: bytes,
        hostStateVectorBase64,
        seed: "full",
        docGuid: null,
      }),
    ).toBe("seeded");

    leaseOf(leaseGrant).release();
  });
});

// ─── 5. Cold awareness frames are bounded and replayed ─────────────────────

describe("cold awareness frames", () => {
  it("retains only the most recent 32 frames and replays them on materialization", () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    // File the room cold first — recordColdAwareness only extends a room the
    // host has already snapshotted.
    expect(
      tier.applySnapshot({
        artifactRoomId: "room-frames",
        snapshotBytes: bytes,
        hostStateVectorBase64,
        seed: "full",
        docGuid: null,
      }),
    ).toBe("filed-cold");

    // 40 distinct-clientID frames while the room stays cold (no lease taken
    // yet), exceeding COLD_ROOM_AWARENESS_FRAMES (32).
    for (let clientId = 1; clientId <= 40; clientId += 1) {
      tier.applyAwareness("room-frames", remoteAwarenessFrame(clientId));
    }
    expect(tier.peek("room-frames")).toBeNull(); // still cold — no lease taken

    const leaseGrant = tier.acquireSync("room-frames");
    const entry = requireHotEntry(tier, "room-frames");

    // Only the last-32-window's worth of distinct remote clients survived -
    // clientIDs 9..40, not all 40. Plus the room's own baseline entry (see
    // the remote-peer pin test above for why `Awareness` always seeds its
    // own clientID into `getStates()`).
    expect(entry.awareness.getStates().size).toBe(33);
    expect(entry.awareness.getStates().has(1)).toBe(false); // pushed out
    expect(entry.awareness.getStates().has(8)).toBe(false); // pushed out
    expect(entry.awareness.getStates().has(9)).toBe(true); // start of retained window
    expect(entry.awareness.getStates().has(40)).toBe(true); // most recent
    expect(entry.awareness.getStates().has(entry.awareness.clientID)).toBe(
      true,
    );

    leaseOf(leaseGrant).release();
  });
});

// ─── 6. dispose() is terminal for DEMAND, not just for resources ────────────

describe("dispose() — the registry's terminal contract", () => {
  it("releases every outstanding lease, clears demand, and refuses later acquisition", () => {
    const { tier } = createHarness();

    // Both lease-bearing arms, because the contract is about every HELD lease
    // and the two arms reach it by different routes: one has a live resource,
    // one is demand on a room with no bytes yet.
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("seeded body");
    const seededGrant = tier.acquireSync("room-granted");
    tier.applySnapshot({
      artifactRoomId: "room-granted",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const grantedAgain = tier.acquireSync("room-granted");
    expect(grantedAgain.kind).toBe("granted");
    const awaitingGrant = tier.acquireSync("room-awaiting");
    expect(awaitingGrant.kind).toBe("awaiting-seed");

    expect(leaseOf(seededGrant).isReleased()).toBe(false);
    expect(leaseOf(awaitingGrant).isReleased()).toBe(false);
    expect(tier.leaseCount("room-granted")).toBe(2);
    expect(tier.leaseCount("room-awaiting")).toBe(1);

    tier.dispose();

    // Every held lease reads as released IMMEDIATELY - no polling, no
    // re-acquire, no walk of a handle list that could have missed one.
    expect(leaseOf(seededGrant).isReleased()).toBe(true);
    expect(leaseOf(grantedAgain).isReleased()).toBe(true);
    expect(leaseOf(awaitingGrant).isReleased()).toBe(true);

    // Demand is gone. A disposed registry still reporting a holder is what a
    // memory accountant and a worker lifecycle would both read as live.
    expect(tier.leaseCount("room-granted")).toBe(0);
    expect(tier.leaseCount("room-awaiting")).toBe(0);
    expect(tier.materializedIds()).toEqual([]);

    // Releasing after dispose is a no-op, not a decrement: the map was cleared
    // wholesale, so a decrement would re-enter a key for a dead registry.
    leaseOf(seededGrant).release();
    leaseOf(awaitingGrant).release();
    expect(tier.leaseCount("room-granted")).toBe(0);

    // And nothing new may be acquired - the one arm that registers no demand.
    expect(tier.acquireSync("room-granted").kind).toBe("unavailable");
    expect(tier.acquireSync("room-fresh").kind).toBe("unavailable");
  });
});

// ─── 7. applySnapshot's doc identity (seed/docGuid) and null-vector handling ─

describe("applySnapshot — doc identity (seed/docGuid) and null-vector watermark handling", () => {
  it('"full" with a CHANGED guid REPLACES the held doc, never splices histories', () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);

    // Seed the room under "guid-a", holding a lease so it materialises.
    const leaseGrant = tier.acquireSync("room-replace");
    const alpha = makeSnapshotBytes("alpha");
    const seedOutcome = tier.applySnapshot({
      artifactRoomId: "room-replace",
      snapshotBytes: alpha.bytes,
      hostStateVectorBase64: alpha.hostStateVectorBase64,
      seed: "full",
      docGuid: "guid-a",
    });
    expect(seedOutcome).toBe("seeded");
    const entryBefore = requireHotEntry(tier, "room-replace");
    expect(entryBefore.doc.getText("body").toString()).toBe("alpha");

    // A deleted-and-recreated artifact: same room id, new guid, unrelated
    // content.
    const beta = makeSnapshotBytes("beta");
    const replaceOutcome = tier.applySnapshot({
      artifactRoomId: "room-replace",
      snapshotBytes: beta.bytes,
      hostStateVectorBase64: beta.hostStateVectorBase64,
      seed: "full",
      docGuid: "guid-b",
    });

    // "seeded", not "merged" - the room was torn down and rebuilt, so
    // anything bound to `entryBefore` by reference is now stale and must
    // rebind.
    expect(replaceOutcome).toBe("seeded");
    const entryAfter = requireHotEntry(tier, "room-replace");
    expect(entryAfter).not.toBe(entryBefore);

    // A splice would leave BOTH texts in the doc (interleaved or
    // concatenated). Assert the new content is present AND the old content
    // is explicitly absent - not just that "beta" appears somewhere, which a
    // splice would also satisfy.
    const finalText = entryAfter.doc.getText("body").toString();
    expect(finalText).toBe("beta");
    expect(finalText).not.toContain("alpha");

    leaseOf(leaseGrant).release();
  });

  it('"full" with an UNCHANGED guid still merges - local content survives', () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);

    const leaseGrant = tier.acquireSync("room-merge-same-guid");
    const seed = makeSnapshotBytes("seed-content");
    const seedOutcome = tier.applySnapshot({
      artifactRoomId: "room-merge-same-guid",
      snapshotBytes: seed.bytes,
      hostStateVectorBase64: seed.hostStateVectorBase64,
      seed: "full",
      docGuid: "guid-c",
    });
    expect(seedOutcome).toBe("seeded");
    const entry = requireHotEntry(tier, "room-merge-same-guid");

    // Local content added BETWEEN the two snapshots.
    entry.doc.getMap("local-marker").set("kept", "yes");

    const second = makeSnapshotBytes("more-content");
    const outcome = tier.applySnapshot({
      artifactRoomId: "room-merge-same-guid",
      snapshotBytes: second.bytes,
      hostStateVectorBase64: second.hostStateVectorBase64,
      seed: "full",
      docGuid: "guid-c",
    });

    // "merged", not "seeded" - the SAME guid never tears the room down. This
    // is the pin that stops a "fix" for the replace case above from just
    // replacing on every snapshot: that would also produce a new entry
    // object and wipe the local edit below.
    expect(outcome).toBe("merged");
    expect(tier.peek("room-merge-same-guid")).toBe(entry);
    expect(entry.doc.getMap("local-marker").get("kept")).toBe("yes");

    leaseOf(leaseGrant).release();
  });

  it('a null docGuid never replaces - two "full" snapshots with no stated identity both merge', () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);

    // The legacy `@1` arm's exact call shape: docGuid is null on every call.
    const leaseGrant = tier.acquireSync("room-null-guid");
    const first = makeSnapshotBytes("first-null-guid");
    const seedOutcome = tier.applySnapshot({
      artifactRoomId: "room-null-guid",
      snapshotBytes: first.bytes,
      hostStateVectorBase64: first.hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    expect(seedOutcome).toBe("seeded");
    const entry = requireHotEntry(tier, "room-null-guid");

    entry.doc.getMap("local-marker").set("kept", "yes");

    const second = makeSnapshotBytes("second-null-guid");
    const outcome = tier.applySnapshot({
      artifactRoomId: "room-null-guid",
      snapshotBytes: second.bytes,
      hostStateVectorBase64: second.hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });

    // "merged", the SAME entry survives, and the local edit is intact - the
    // guarantee that the `@1` arm (which never states an identity) is
    // unchanged by the guid-replace rule.
    expect(outcome).toBe("merged");
    expect(tier.peek("room-null-guid")).toBe(entry);
    expect(entry.doc.getMap("local-marker").get("kept")).toBe("yes");

    leaseOf(leaseGrant).release();
  });

  it("hostStateVectorBase64: null does not clear the dirty watermark; a covering vector does", () => {
    const { tier, session } = createHarness();
    trackTierDisposal(tier);

    const seed = makeSnapshotBytes("dirty-seed");
    const leaseGrant = tier.acquireSync("room-null-vector-dirty");
    tier.applySnapshot({
      artifactRoomId: "room-null-vector-dirty",
      snapshotBytes: seed.bytes,
      hostStateVectorBase64: seed.hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const entry = requireHotEntry(tier, "room-null-vector-dirty");

    // Local edit while the room cannot send - the same writable-role gate as
    // the local-divergence pin above, plus `canSendBodyWrites: false` so the
    // edit is queued rather than drained immediately.
    session.state.permissionRole = "owner";
    session.state.canSendBodyWrites = false;
    entry.doc.getMap("dirty-marker").set("edit", "1");

    expect(entry.dirtyWatermarkStateVectorBase64).not.toBeNull();
    expect(tier.hasDivergence()).toBe(true);

    // A snapshot with no watermark proves nothing about what the host has
    // durably seen - it must NOT clear the dirty mark.
    const noVectorResend = makeSnapshotBytes("host-resend-no-vector");
    tier.applySnapshot({
      artifactRoomId: "room-null-vector-dirty",
      snapshotBytes: noVectorResend.bytes,
      hostStateVectorBase64: null,
      seed: "full",
      docGuid: null,
    });

    expect(entry.dirtyWatermarkStateVectorBase64).not.toBeNull();
    expect(tier.hasDivergence()).toBe(true);

    // A snapshot carrying a vector that actually covers the watermark clears
    // it - proving the assertions above are not just a tier that never
    // clears the watermark at all. The covering vector and bytes are the
    // replica's own current full state taken at the same instant, so the
    // diff against them is trivial by construction and the coverage check
    // is unambiguous.
    const coveringVector = encodeDocStateVectorBase64(entry.doc);
    const coveringBytes = Y.encodeStateAsUpdate(entry.doc);
    tier.applySnapshot({
      artifactRoomId: "room-null-vector-dirty",
      snapshotBytes: coveringBytes,
      hostStateVectorBase64: coveringVector,
      seed: "full",
      docGuid: null,
    });

    expect(entry.dirtyWatermarkStateVectorBase64).toBeNull();
    expect(tier.hasDivergence()).toBe(false);

    leaseOf(leaseGrant).release();
  });
});

// ─── 8. applyCoverage retires local divergence on the body lane ───────────

describe("applyCoverage — the body lane's own retirement path for local divergence", () => {
  it("clears divergence only when the coverage vector actually covers the local edit, not merely on any call", () => {
    const { tier, session } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("seed content");

    const leaseGrant = tier.acquireSync("room-coverage");
    tier.applySnapshot({
      artifactRoomId: "room-coverage",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const entry = requireHotEntry(tier, "room-coverage");

    // Captured BEFORE the local edit below, for the non-covering half at the
    // end of this test — it names a point in the doc's history that does not
    // yet include the edit's own clock advance.
    const preEditVector = encodeDocStateVectorBase64(entry.doc);

    // The same writable-role gate the file's other local-divergence pin uses
    // ("local divergence ... keeps the room hot" above): "owner" is required
    // for the doc-update handler to mark the replica dirty. `canSendBodyWrites`
    // is left at the harness's default `true` (NOT the `false` the null-vector
    // pin uses) so the edit is SENT rather than queued: `applyCoverage` only
    // ever retires the dirty WATERMARK, never a queued `pendingUpdates` entry
    // (that queue drains solely on a reconnect reconcile, via `applySnapshot` -
    // see `clearPendingRoomUpdates`). A queued edit would make this pin
    // unwritable, since `hasDivergence()` would then stay `true` regardless of
    // what vector `applyCoverage` was given.
    session.state.permissionRole = "owner";
    entry.doc.getMap("body").set("local-edit", "1");

    expect(entry.dirtyWatermarkStateVectorBase64).not.toBeNull();
    expect(tier.hasDivergence()).toBe(true);

    // A vector captured BEFORE the edit does not cover it — divergence must
    // survive. This half runs FIRST, while the watermark is still set: once
    // divergence is retired there is nothing left to test a non-covering
    // vector against (an absent watermark reads as trivially "covered"), so
    // running this after the covering half below would make it vacuous — a
    // tier that clears the watermark unconditionally on any `applyCoverage`
    // call would still pass.
    tier.applyCoverage("room-coverage", preEditVector);
    expect(tier.hasDivergence()).toBe(true);
    expect(entry.dirtyWatermarkStateVectorBase64).not.toBeNull();

    // The doc's own CURRENT state vector covers everything written so far,
    // including the local edit — the body lane's `room-coverage` event is the
    // authority stating how much of what this client pushed it now holds.
    // Taken from the replica's own current full state, so the comparison is
    // trivially exact by construction, matching the covering-vector pattern
    // the null-vector pin above already uses for the `@1` `room-update` path.
    const coveringVector = encodeDocStateVectorBase64(entry.doc);
    tier.applyCoverage("room-coverage", coveringVector);

    expect(entry.dirtyWatermarkStateVectorBase64).toBeNull();
    expect(tier.hasDivergence()).toBe(false);

    leaseOf(leaseGrant).release();
  });
});
