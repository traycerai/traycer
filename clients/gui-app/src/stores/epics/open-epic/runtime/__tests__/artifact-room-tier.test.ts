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
  SendOutcome,
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
import type { HotDocBudgetSink } from "@/stores/replica-memory/hot-doc-budget";
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
  /**
   * The frames the transport ACCEPTED, which is a different set from `sent`
   * the moment a test installs a refusing answer - and the difference is the
   * whole subject of the outbound-queue pins. Asserting on `sent` would count
   * a refused frame as delivered, which is precisely the bug.
   */
  readonly delivered: EpicOutboundRequest[];
  /**
   * What the transport answers. Mutable because a body LANE refuses
   * independently of every epic-level fact `session` carries - no adapter yet,
   * or no `docGuid` because no snapshot has seeded it - and that refusal is
   * only observable through the outcome.
   */
  readonly transport: {
    answer: (request: EpicOutboundRequest) => SendOutcome;
  };
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
  const delivered: EpicOutboundRequest[] = [];
  const transport: {
    answer: (request: EpicOutboundRequest) => SendOutcome;
  } = { answer: () => ({ kind: "sent" }) };
  const tier = createArtifactRoomTier({
    environment,
    session,
    send: (request) => {
      // Recorded even when refused: "the transport was asked and said no" is a
      // different fact from "nothing was attempted", and a pin for the queue
      // has to be able to tell them apart.
      sent.push(request);
      const outcome = transport.answer(request);
      if (outcome.kind === "sent") delivered.push(request);
      return outcome;
    },
    onDivergenceChanged: () => undefined,
    isDisposed: () => false,
    budget: null,
  });
  return { tier, environment, session, sent, delivered, transport };
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

  it("the RELAYED main-thread identity does NOT keep the room hot", () => {
    // The twin of the arm above, and the one with a leak behind it.
    //
    // After the worker relocation the editor's presence arrives under a
    // main-side `clientID` that is not `entry.awareness.clientID`. Read
    // naively that is "a remote collaborator is present", which is a
    // materialisation PIN - so the room would never cool while an editor was
    // open, and would stay hot forever if the departure frame never arrived
    // (a teardown-order accident, permanent when it happens).
    //
    // `relayedLocalClientId` is what makes the predicate tell the two apart.
    // Ablate its exclusion in `isOwnAwarenessClient` and this goes red.
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    tier.applySnapshot({
      artifactRoomId: "room-relayed",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const leaseGrant = tier.acquireSync("room-relayed");
    requireHotEntry(tier, "room-relayed");
    leaseOf(leaseGrant).release(); // the relayed identity is the ONLY arm left

    tier.relayLocalAwareness("room-relayed", remoteAwarenessFrame(4242), 4242);
    const entry = requireHotEntry(tier, "room-relayed");
    // The state IS present - this is not a room where nothing was relayed.
    // Without that check the cooling below would pass vacuously.
    expect(entry.awareness.getStates().has(4242)).toBe(true);
    expect(entry.relayedLocalClientId).toBe(4242);

    tier.demoteIdle();

    // COOLED. This is the assertion the remote-peer arm inverts.
    expect(tier.peek("room-relayed")).toBeNull();
  });

  it("replaces a changed relayed identity and evicts the old one", () => {
    // A rematerialize builds a fresh main-side `Y.Doc`, so `Awareness` takes a
    // NEW clientID for the same room. The old id must be evicted, not merely
    // forgotten: once this field names the new id, nothing excludes the old
    // one any more - it becomes exactly the stranger that pins the room hot,
    // and no teardown will ever remove it.
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    tier.applySnapshot({
      artifactRoomId: "room-reidentified",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const leaseGrant = tier.acquireSync("room-reidentified");
    requireHotEntry(tier, "room-reidentified");
    leaseOf(leaseGrant).release();

    tier.relayLocalAwareness(
      "room-reidentified",
      remoteAwarenessFrame(1001),
      1001,
    );
    expect(
      requireHotEntry(tier, "room-reidentified")
        .awareness.getStates()
        .has(1001),
    ).toBe(true);

    tier.relayLocalAwareness(
      "room-reidentified",
      remoteAwarenessFrame(1002),
      1002,
    );
    const entry = requireHotEntry(tier, "room-reidentified");

    expect(entry.relayedLocalClientId).toBe(1002);
    // The old identity is GONE from the state map, not just unreferenced.
    expect(entry.awareness.getStates().has(1001)).toBe(false);
    expect(entry.awareness.getStates().has(1002)).toBe(true);

    // And the room still cools: the superseded id is not left behind as a
    // stranger pinning it hot, which is the whole failure this guards.
    tier.demoteIdle();
    expect(tier.peek("room-reidentified")).toBeNull();
  });

  it("does not replay the relayed identity back as a peer after a demote", () => {
    // The GHOST-CURSOR twin, and it has its own ablation: `encodePeerAwareness`
    // filters by the same helper, and reverting THAT call site alone (leaving
    // `hasRemotePeers` correct) reds only this test.
    //
    // The demote replay exists so a peer who was present before a room cooled
    // is still visible after it comes back. The relayed identity must be
    // excluded for the reason the exclusion was written for in the first
    // place: the editor sets its own state when it rebinds, so replaying a
    // stale copy fights that - here by rendering the user their own cursor as
    // a stranger sitting in the room.
    const { tier } = createHarness();
    trackTierDisposal(tier);
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");

    tier.applySnapshot({
      artifactRoomId: "room-replayed",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    const leaseGrant = tier.acquireSync("room-replayed");
    requireHotEntry(tier, "room-replayed");
    leaseOf(leaseGrant).release();

    tier.relayLocalAwareness("room-replayed", remoteAwarenessFrame(7777), 7777);
    expect(
      requireHotEntry(tier, "room-replayed").awareness.getStates().has(7777),
    ).toBe(true);

    // Cools (per the arm above), encoding its peer replay on the way out.
    tier.demoteIdle();
    expect(tier.peek("room-replayed")).toBeNull();

    // Back from cold: the replay runs here.
    const revived = tier.acquireSync("room-replayed");
    const entry = requireHotEntry(tier, "room-replayed");

    expect(entry.awareness.getStates().has(7777)).toBe(false);
    leaseOf(revived).release();
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
    // `toJSON()`, not `toString()`: yjs declares `toJSON(): string` on `Y.Text`
    // and does NOT declare `toString`, so the latter resolves to
    // `Object.prototype.toString` in the type system - it happens to work at
    // runtime, which is exactly what makes it worth not relying on.
    expect(entryBefore.doc.getText("body").toJSON()).toBe("alpha");

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
    const finalText = entryAfter.doc.getText("body").toJSON();
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

/**
 * The settle path REFUSES a pinned room — ruling (c).
 *
 * The hot doc's lifetime moved to the main thread, but two of the three pin
 * arms read TIER state (local divergence, remote presence). Rather than copy
 * the predicate across the bridge — where it would be a stale snapshot of an
 * output — the predicate stays with the state it reads and reaches main
 * through the refusal the demote contract already has. One predicate, one
 * owner.
 *
 * The divergence arm is the one with a data-loss cost, and it is still real
 * after the relocation: `flushPending` reads `replicas.get(artifactRoomId)`
 * and RETURNS when the entry is absent, so the reconnect reconcile ships only
 * from a LIVE replica. Settling a divergent room would move exactly those
 * bytes into cold state, where the reconcile never looks — the edits are not
 * dropped loudly, they are filed somewhere nothing reads.
 */
describe("settleColdState refuses a pinned room", () => {
  const GUID = "guid-settle";

  function seedRoomWithIdentity(
    tier: ArtifactRoomTier,
    artifactRoomId: string,
  ): void {
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");
    tier.applySnapshot({
      artifactRoomId,
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: GUID,
    });
  }

  it("ACCEPTS for an unpinned room, so the refusals below are not vacuous", () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);
    seedRoomWithIdentity(tier, "room-settle-clean");
    leaseOf(tier.acquireSync("room-settle-clean")).release();

    const settlement = tier.settleColdState(
      "room-settle-clean",
      makeSnapshotBytes("hello").bytes,
      GUID,
    );

    expect(settlement.accepted).toBe(true);
  });

  it("refuses with `pinned` while the room holds unacknowledged edits", () => {
    // THE data-loss pin. Ablate the `isPinnedByTierState` guard in
    // `settleColdState` and this goes red - and in production those edits go
    // cold where the reconcile cannot find them.
    const { tier, session } = createHarness();
    trackTierDisposal(tier);
    seedRoomWithIdentity(tier, "room-settle-dirty");
    const grant = tier.acquireSync("room-settle-dirty");
    const entry = requireHotEntry(tier, "room-settle-dirty");
    leaseOf(grant).release(); // divergence is the ONLY remaining arm

    session.state.permissionRole = "owner";
    entry.doc.getMap("body").set("local-edit", "1");
    expect(entry.dirtyWatermarkStateVectorBase64).not.toBeNull();

    const settlement = tier.settleColdState(
      "room-settle-dirty",
      makeSnapshotBytes("hello").bytes,
      GUID,
    );

    // Narrowed by a guard rather than by a ternary on `accepted`: the union's
    // refusal arm is the one that carries `reason`, and reading it through a
    // boolean comparison hides that from both the reader and the compiler.
    if (settlement.accepted) throw new Error("expected a refusal");
    expect(settlement.reason).toBe("pinned");
    // And the room is still live, which is what main relies on when it keeps
    // its own copy and re-arms.
    expect(tier.peek("room-settle-dirty")).not.toBeNull();
  });

  it("refuses with `pinned` while a remote collaborator is present", () => {
    const { tier } = createHarness();
    trackTierDisposal(tier);
    seedRoomWithIdentity(tier, "room-settle-peer");
    leaseOf(tier.acquireSync("room-settle-peer")).release();

    tier.applyAwareness("room-settle-peer", remoteAwarenessFrame(555));

    const settlement = tier.settleColdState(
      "room-settle-peer",
      makeSnapshotBytes("hello").bytes,
      GUID,
    );

    // Narrowed by a guard rather than by a ternary on `accepted`: the union's
    // refusal arm is the one that carries `reason`, and reading it through a
    // boolean comparison hides that from both the reader and the compiler.
    if (settlement.accepted) throw new Error("expected a refusal");
    expect(settlement.reason).toBe("pinned");
  });

  it("settles once the pin clears, so a refusal is a delay and not a wedge", () => {
    // The other half: a refusal that could never resolve would trade the leak
    // the linger fixed for a doc that is never reclaimed at all.
    const { tier } = createHarness();
    trackTierDisposal(tier);
    seedRoomWithIdentity(tier, "room-settle-clears");
    leaseOf(tier.acquireSync("room-settle-clears")).release();

    tier.applyAwareness("room-settle-clears", remoteAwarenessFrame(556));
    expect(
      tier.settleColdState(
        "room-settle-clears",
        makeSnapshotBytes("hello").bytes,
        GUID,
      ).accepted,
    ).toBe(false);

    // The peer leaves.
    const entry = requireHotEntry(tier, "room-settle-clears");
    entry.awareness.getStates().delete(556);

    expect(
      tier.settleColdState(
        "room-settle-clears",
        makeSnapshotBytes("hello").bytes,
        GUID,
      ).accepted,
    ).toBe(true);
  });
});

describe("outbound body updates — the transport's ANSWER decides whether bytes are retained", () => {
  /** A seeded, leased room, ready to take a local edit. */
  function readyRoom(
    harness: TestHarness,
    artifactRoomId: string,
  ): ArtifactRoomReplicaEntry {
    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");
    harness.tier.applySnapshot({
      artifactRoomId,
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    harness.tier.acquireSync(artifactRoomId);
    return requireHotEntry(harness.tier, artifactRoomId);
  }

  /** Every `room-update` payload the transport was handed, in order. */
  function shippedUpdates(harness: TestHarness): readonly Uint8Array[] {
    return harness.delivered
      .filter((request) => request.kind === "room-update")
      .map((request) => request.update);
  }

  /**
   * The keys a fresh doc ends up with after applying `updates` over the same
   * snapshot the room was seeded from.
   *
   * Asserting on CONVERGENCE rather than on frame counts, because that is the
   * property the queue exists to hold: an edit dropped in the middle of a
   * partial flush is not a reordering Yjs absorbs, it is a key that never
   * arrives.
   */
  function keysAfterApplying(updates: readonly Uint8Array[]): string[] {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, makeSnapshotBytes("hello").bytes);
    for (const update of updates) Y.applyUpdate(doc, update);
    const keys = Array.from(doc.getMap("body").keys()).sort();
    doc.destroy();
    return keys;
  }

  it("QUEUES an update the transport refused, even though the SESSION may write", () => {
    // The gap the lane arm opened. Every epic-level fact says "you may write",
    // and the body's own lane refuses anyway - it has no adapter yet, or no
    // `docGuid` because no snapshot has seeded it. `canSendBodyWrites()` cannot
    // see either, so the outcome is the only thing that can.
    const harness = createHarness();
    trackTierDisposal(harness.tier);
    const entry = readyRoom(harness, "room-refused");

    harness.transport.answer = () => ({
      kind: "queued",
      reason: "body-not-seeded",
    });
    entry.doc.getMap("body").set("local-edit", "1");

    // It was ATTEMPTED and REFUSED - this is a transport saying no, not an
    // epic-level gate that held before the call. The two are indistinguishable
    // from the queue's side unless the outcome is read, which is the finding.
    expect(harness.sent).toHaveLength(1);
    expect(shippedUpdates(harness)).toHaveLength(0);

    // THE REDDENING ASSERTION. A `queued` outcome is a statement to the caller
    // that IT must retain the bytes; before this the caller treated the
    // attempt as delivery and kept nothing, so the edit reached the host on no
    // path at all and the next flush had nothing to ship.
    harness.delivered.length = 0;
    harness.transport.answer = () => ({ kind: "sent" });
    harness.tier.flushPending("room-refused");
    expect(keysAfterApplying(shippedUpdates(harness))).toEqual(["local-edit"]);
  });

  it("still treats an ACCEPTED update as sent, so the queue is not a second copy", () => {
    // The control. A tier that queued unconditionally would re-ship every edit
    // on the next flush - worse than the bug, and invisible to the pin above.
    const harness = createHarness();
    trackTierDisposal(harness.tier);
    const entry = readyRoom(harness, "room-accepted");

    entry.doc.getMap("body").set("local-edit", "1");
    expect(shippedUpdates(harness)).toHaveLength(1);

    harness.delivered.length = 0;
    harness.tier.flushPending("room-accepted");
    expect(shippedUpdates(harness)).toHaveLength(0);
  });

  it("re-queues a PARTIALLY refused flush, losing no edit from the middle", () => {
    const harness = createHarness();
    trackTierDisposal(harness.tier);
    const entry = readyRoom(harness, "room-partial");

    // Three edits made while the lane is refusing, so all three are queued.
    harness.transport.answer = () => ({
      kind: "dropped",
      reason: "no-transport",
    });
    entry.doc.getMap("body").set("edit-1", "1");
    entry.doc.getMap("body").set("edit-2", "2");
    entry.doc.getMap("body").set("edit-3", "3");

    // The flush gets exactly one frame through and is refused on the next.
    let accepted = 0;
    harness.transport.answer = () => {
      accepted += 1;
      return accepted <= 1
        ? { kind: "sent" }
        : { kind: "queued", reason: "body-not-seeded" };
    };
    harness.delivered.length = 0;
    harness.tier.flushPending("room-partial");
    const firstPass = shippedUpdates(harness);

    // The lane recovers and the remainder ships.
    harness.transport.answer = () => ({ kind: "sent" });
    harness.delivered.length = 0;
    harness.tier.flushPending("room-partial");
    const secondPass = shippedUpdates(harness);

    // THE REDDENING ASSERTION: all three edits arrive across the two passes.
    // Under a flush that dropped what it could not send, the two refused
    // frames are gone and this reads `["edit-1"]`.
    expect(keysAfterApplying([...firstPass, ...secondPass])).toEqual([
      "edit-1",
      "edit-2",
      "edit-3",
    ]);
  });

  it("stashes a snapshot reconcile the transport refused instead of clearing the queue", () => {
    // The third member of the class, and the one nobody flagged: the merge arm
    // clears `pendingUpdates` on the strength of "the reconcile subsumes it",
    // which is only true once the reconcile has actually gone out.
    const harness = createHarness();
    trackTierDisposal(harness.tier);
    const entry = readyRoom(harness, "room-reconcile");

    harness.transport.answer = () => ({
      kind: "queued",
      reason: "body-not-seeded",
    });
    entry.doc.getMap("body").set("offline-edit", "1");

    // A fresh snapshot lands while the lane is still refusing. The merge arm
    // computes a reconcile that subsumes the queued edit and tries to ship it.
    const merged = makeSnapshotBytes("hello there");
    harness.tier.applySnapshot({
      artifactRoomId: "room-reconcile",
      snapshotBytes: merged.bytes,
      hostStateVectorBase64: merged.hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });

    harness.transport.answer = () => ({ kind: "sent" });
    harness.delivered.length = 0;
    harness.tier.flushPending("room-reconcile");
    expect(keysAfterApplying(shippedUpdates(harness))).toContain(
      "offline-edit",
    );
  });
});

describe("hot-growth accounting survives a transport that TRANSFERS the update", () => {
  it("measures the update before handing it over, not after", () => {
    // The runtime can live in a worker, and the outbound frame then crosses the
    // bridge by `postMessage` with a transfer list. `takeBytesForTransfer`
    // MOVES the backing `ArrayBuffer` rather than copying it whenever the view
    // owns all of it - which a Yjs update does - so the sender's view detaches
    // synchronously and reads `byteLength === 0` rather than throwing.
    //
    // Reproduced here with a real `structuredClone` transfer rather than a
    // stub that returns zero, so the pin fails for the reason production would.
    const charges: number[] = [];
    const budget: HotDocBudgetSink = {
      settle: () => undefined,
      settleCold: () => undefined,
      release: () => undefined,
      chargeProvisional: (_artifactRoomId, bytes) => {
        charges.push(bytes);
      },
    };
    let ownedItsWholeBuffer = false;
    const tier = createArtifactRoomTier({
      environment: createFakeEnvironment(),
      session: createFakeSession(),
      send: (request) => {
        if (request.kind === "room-update") {
          const { update } = request;
          const buffer = update.buffer;
          // The precondition the transfer path turns on. Recorded rather than
          // assumed: if a future Yjs hands back a VIEW into a larger buffer,
          // `takeBytesForTransfer` copies instead and this pin would go
          // vacuously green - so the assertion below fails loudly instead.
          ownedItsWholeBuffer =
            buffer instanceof ArrayBuffer &&
            update.byteOffset === 0 &&
            update.byteLength === buffer.byteLength;
          if (ownedItsWholeBuffer && buffer instanceof ArrayBuffer) {
            structuredClone(update, { transfer: [buffer] });
          }
        }
        return { kind: "sent" };
      },
      onDivergenceChanged: () => undefined,
      isDisposed: () => false,
      budget,
    });
    trackTierDisposal(tier);

    const { bytes, hostStateVectorBase64 } = makeSnapshotBytes("hello");
    tier.applySnapshot({
      artifactRoomId: "room-transfer",
      snapshotBytes: bytes,
      hostStateVectorBase64,
      seed: "full",
      docGuid: null,
    });
    tier.acquireSync("room-transfer");
    charges.length = 0;

    requireHotEntry(tier, "room-transfer")
      .doc.getMap("body")
      .set("local-edit", "1");

    expect(ownedItsWholeBuffer).toBe(true);
    // THE REDDENING ASSERTION. Measured after the send, this is 0: the room
    // records no growth at all, so an actively edited body can grow past the
    // hot budget without ever becoming an eviction candidate.
    expect(charges).toHaveLength(1);
    expect(charges[0]).toBeGreaterThan(0);
  });
});
