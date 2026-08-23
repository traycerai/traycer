import { describe, expect, it } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type AuthorityIdentitySource,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type LocalHostEnsurePort,
  type LocalHostOutageSignal,
  type SelectionAttachRequest,
  type SelectionChange,
  type SelectionEvidenceReport,
  type SelectionIncompatibility,
} from "../selection-authority-contract";
import {
  ATTACH_HANDOVER_CEILING_MS,
  COLD_START_LOCAL_RESTART_HOLD_CEILING_MS,
  CONFIRMED_DEATH_REFUSAL_STREAK,
  EFFECTIVE_HOST_POST_SESSION_CEILING_MS,
  SESSION_ORDINAL_WINDOW,
  FAILOVER_CANDIDATE_STABILITY_MS,
  LOCAL_ENSURE_RETRY_COOLDOWN_MS,
  LOCAL_EXPECTED_OUTAGE_CEILING_MS,
  RESTART_INTENT_EPISODE_MS,
  RETURN_TO_TARGET_STABILITY_MS,
  SelectionAuthorityEngineImpl,
  createIncrementingIncarnationIds,
  isUsableForSelection,
  silentAuthorityLog,
  type PreferredHostSaveResult,
  type PreferredHostStore,
} from "../selection-authority-engine";
import {
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  inertLocalHostOutageSignal,
  unavailableLocalHostEnsurePort,
} from "../in-process-selection-authority";
import {
  createFakeAuthorityClock,
  createRecordingAuthorityLog,
  createTestAuthority,
  fleetHost,
  findLease,
  recordEngineEvents,
  type FakeAuthorityClock,
  type RecordedAuthorityLog,
  type RecordedEngineEvent,
  type RecordingAuthorityLog,
} from "./selection-authority-harness";

// ---------------------------------------------------------------- builders

function attachRequest(
  seq: number,
  liveSessions: readonly LiveSessionAnnouncement[],
): SelectionAttachRequest {
  return {
    attachSeq: seq,
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions,
  };
}

function liveSession(
  hostId: string,
  sessionId: string,
): LiveSessionAnnouncement {
  return { hostId, sessionId, transportKind: "remote-relay" };
}

function dialOutcome(
  hostId: string,
  attemptId: string,
  outcome: "success" | "timeout" | "indeterminate",
  at: number,
): SelectionEvidenceReport {
  return {
    kind: "dial",
    hostId,
    attemptId,
    outcome,
    transportKind: "remote-relay",
    at,
  };
}

function dialRefusal(
  hostId: string,
  attemptId: string,
  refusalDetail: "plan-restricted" | null,
  at: number,
): SelectionEvidenceReport {
  return {
    kind: "dial",
    hostId,
    attemptId,
    outcome: "confirmed-refusal",
    refusalDetail,
    transportKind: "remote-relay",
    at,
  };
}

function sessionEvidence(
  hostId: string,
  sessionId: string,
  transition: "established" | "lost",
  at: number,
): SelectionEvidenceReport {
  return {
    kind: "session",
    hostId,
    sessionId,
    transition,
    transportKind: "remote-relay",
    at,
  };
}

function compatCompatible(
  hostId: string,
  probedOnSessionId: string | null,
): SelectionEvidenceReport {
  return {
    kind: "compat",
    hostId,
    probedOnSessionId,
    hostVersion: null,
    verdict: "compatible",
    incompatibility: null,
    at: 0,
  };
}

function compatIncompatible(
  hostId: string,
  probedOnSessionId: string | null,
  detail: SelectionIncompatibility,
): SelectionEvidenceReport {
  return {
    kind: "compat",
    hostId,
    probedOnSessionId,
    hostVersion: null,
    verdict: "incompatible",
    incompatibility: detail,
    at: 0,
  };
}

function restartIntent(
  hostId: string,
  tombstoneId: string,
  expiresAt: number | null,
  at: number,
): SelectionEvidenceReport {
  return { kind: "restart-intent", hostId, tombstoneId, expiresAt, at };
}

const INCOMPAT_DETAIL: SelectionIncompatibility = {
  code: "protocol-major-behind",
  hostVersion: "1.0.0",
  minSupportedVersion: "2.0.0",
  clientCompatibility: null,
};

const EMPTY_FLEET_SEED = {
  identityGeneration: 0,
  localHostId: null,
  hosts: [],
};

/**
 * A local `ensure` port that answers "ready" immediately.
 *
 * The suite's default is {@link unavailableLocalHostEnsurePort}, which models a
 * machine whose host CANNOT be provisioned - and since the F3(b)/(c) rulings
 * such a host honestly reads `dead` as soon as the engine's ensure comes back
 * unavailable (registry §5's ∅ definition, made real; the perpetual
 * `connecting` it replaced was the lie that blocked ∅ on exactly the platforms
 * that needed it).
 *
 * So every scenario whose SUBJECT is the local host serving - as a fallback, as
 * a precedence loser that is nonetheless usable, as the host a deliberate
 * restart cycles - has to say that the host is provisionable. Leaving the
 * unavailable port in place would make those tests assert the old lie.
 */
function readyLocalHostEnsurePort(): LocalHostEnsurePort {
  return { ensureReady: () => Promise.resolve({ ok: true }) };
}

/**
 * A local `ensure` port whose promise NEVER settles - a hung provisioning
 * lane (the same shape the B2 suite drives via `createDeferredEnsure()` with
 * its `resolve` never called, made a named one-liner here because the P1 fix
 * pins need it at the point a host FIRST becomes effective, not only at its
 * own B2 ceiling).
 *
 * This is the exact mechanism behind the P1 regression: `deriveLease`'s
 * in-flight-ensure arm reports the local host `connecting` - usable - for as
 * long as this promise is outstanding, which is proof of NOTHING (no dial,
 * no session, no announcement has ever reached the host). Only the engine's
 * own {@link LOCAL_EXPECTED_OUTAGE_CEILING_MS}-equal B2 ceiling ever moves a
 * lease held by a port like this one; the port itself never will.
 */
function neverResolvingLocalHostEnsurePort(): LocalHostEnsurePort {
  return { ensureReady: () => new Promise(() => undefined) };
}

// -------------------------------------------------------------------- tests

describe("SelectionAuthorityEngineImpl - attach fence", () => {
  it("allocateAttachSeq advances the supersession fence: an earlier issued seq is superseded and state-neutral", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seq1 = engine.allocateAttachSeq("R1");
    const seq2 = engine.allocateAttachSeq("R1");
    const revisionBefore = engine.snapshot().revision;

    const staleResult = engine.attach("R1", attachRequest(seq1, []));
    expect(staleResult).toEqual({ ok: false, kind: "superseded" });
    expect(engine.snapshot().revision).toBe(revisionBefore);

    const freshResult = engine.attach("R1", attachRequest(seq2, []));
    expect(freshResult.ok).toBe(true);

    authority.dispose();
  });

  it("attach-once: a second attach with the same seq is superseded", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seq = engine.allocateAttachSeq("R1");
    const first = engine.attach("R1", attachRequest(seq, []));
    expect(first.ok).toBe(true);

    const second = engine.attach("R1", attachRequest(seq, []));
    expect(second).toEqual({ ok: false, kind: "superseded" });

    authority.dispose();
  });

  it("version mismatch retires the previous attachment and consumes the seq; a replay of the same seq is superseded", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seq1 = engine.allocateAttachSeq("R1");
    const attach1 = engine.attach(
      "R1",
      attachRequest(seq1, [liveSession("H", "s1")]),
    );
    expect(attach1.ok).toBe(true);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    const seq2 = engine.allocateAttachSeq("R1");
    const mismatch = engine.attach("R1", {
      attachSeq: seq2,
      callerContractVersion: 99,
      liveSessions: [],
    });
    expect(mismatch).toEqual({
      ok: false,
      kind: "version-mismatch",
      authorityVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
      callerVersion: 99,
    });
    // The previous attachment (seq1's live session) is retired atomically.
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    const replay = engine.attach("R1", attachRequest(seq2, []));
    expect(replay).toEqual({ ok: false, kind: "superseded" });

    authority.dispose();
  });

  it("refuseMalformedAttach claims the latest-unconsumed seq and retires the previous attachment; a stale or already-consumed seq is state-neutral", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seq1 = engine.allocateAttachSeq("R1");
    const attach1 = engine.attach(
      "R1",
      attachRequest(seq1, [liveSession("H", "s1")]),
    );
    expect(attach1.ok).toBe(true);

    const seq2 = engine.allocateAttachSeq("R1");
    const revisionBefore = engine.snapshot().revision;

    // seq1 is stale now: state-neutral.
    const staleClaim = engine.refuseMalformedAttach("R1", seq1);
    expect(staleClaim).toBe(false);
    expect(engine.snapshot().revision).toBe(revisionBefore);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // seq2 is the latest unconsumed issuance: claims and retires the live attachment.
    const freshClaim = engine.refuseMalformedAttach("R1", seq2);
    expect(freshClaim).toBe(true);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    // seq2 is now consumed: a replay is state-neutral.
    const revisionAfterClaim = engine.snapshot().revision;
    const replayClaim = engine.refuseMalformedAttach("R1", seq2);
    expect(replayClaim).toBe(false);
    expect(engine.snapshot().revision).toBe(revisionAfterClaim);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - SEAM: late attach and handover races", () => {
  it("a late-attaching window receives the full current snapshot, including a host that already died", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach A to succeed");
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", `attempt-${i}`, null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach("B", attachRequest(seqB, []));
    if (!attachB.ok) throw new Error("expected attach B to succeed");
    expect(findLease(attachB.snapshot.leases, "H")?.status).toBe("dead");
    const maxEventRevision = Math.max(...events.map((event) => event.revision));
    expect(attachB.snapshot.revision).toBe(maxEventRevision);

    authority.dispose();
  });

  it("a stale attach retried after replacement is superseded while the surviving instance's session stays counted", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA1 = engine.allocateAttachSeq("A");
    const attachA1 = engine.attach(
      "A",
      attachRequest(seqA1, [liveSession("H", "sA")]),
    );
    expect(attachA1.ok).toBe(true);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // A new load allocates but nobody has attached with it yet.
    engine.allocateAttachSeq("A");

    // The OLD instance retries its now-superseded seq.
    const retry = engine.attach("A", attachRequest(seqA1, []));
    expect(retry).toEqual({ ok: false, kind: "superseded" });
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    authority.dispose();
  });

  it("attach with surviving sockets never opens an empty-session window that concurrent refusals could count against", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events } = authority;

    const seqA = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA, [liveSession("H", "sA")]));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // A new load re-attaches announcing the same live session.
    const seqA2 = engine.allocateAttachSeq("A");
    const attachA2 = engine.attach(
      "A",
      attachRequest(seqA2, [liveSession("H", "sA")]),
    );
    if (!attachA2.ok) throw new Error("expected re-attach to succeed");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    for (let i = 0; i < 3; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA2.incarnationId,
        dialRefusal("H", `refusal-${i}`, null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // No emitted leases event ever showed H as anything but ready.
    for (const event of events) {
      if (event.kind !== "leases") continue;
      const lease = findLease(event.leases, "H");
      if (lease === undefined) continue;
      expect(lease.status).toBe("ready");
    }

    authority.dispose();
  });

  it("an issued generation that NEVER claims retires the held attachment at the handover ceiling - its stale inventory stops suppressing death", () => {
    // Codex #1243 (engine): a reload's preload allocates, then the renderer's
    // bootstrap fails while the process stays alive - no render-process-gone,
    // no window destruction, no claim. Before this bound, window A's retired
    // document kept H `ready` in every window for as long as the app lived.
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA, [liveSession("H", "sA")]));
    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach("B", attachRequest(seqB, []));
    if (!attachB.ok) throw new Error("expected attach B to succeed");

    // A reloads: a new generation is issued, and nobody ever claims it.
    engine.allocateAttachSeq("A");

    // Inside the ceiling the handover is still open: A's held session keeps
    // suppressing B's refusals (the no-empty-session-window guarantee).
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "B",
        attachB.incarnationId,
        dialRefusal("H", `early-${i}`, null, i),
      );
    }
    clock.advance(ATTACH_HANDOVER_CEILING_MS - 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    // At the ceiling the held attachment is retired as a detach would be.
    clock.advance(1);
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "B",
        attachB.incarnationId,
        dialRefusal("H", `late-${i}`, null, 100 + i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });

  it("a claim landing inside the ceiling cancels it: the NEW inventory is not retired when the timer would have fired", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA, [liveSession("H", "sA")]));
    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach("B", attachRequest(seqB, []));
    if (!attachB.ok) throw new Error("expected attach B to succeed");

    // The ordinary reload: issued, then claimed well inside the ceiling with
    // the surviving session re-announced.
    const seqA2 = engine.allocateAttachSeq("A");
    clock.advance(1_000);
    const attachA2 = engine.attach(
      "A",
      attachRequest(seqA2, [liveSession("H", "sA")]),
    );
    expect(attachA2.ok).toBe(true);
    expect(clock.pendingTimerCount()).toBe(0);

    // Past where the ceiling would have fired, A2's inventory still counts.
    clock.advance(ATTACH_HANDOVER_CEILING_MS);
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "B",
        attachB.incarnationId,
        dialRefusal("H", `refusal-${i}`, null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    authority.dispose();
  });

  it("a hard detach during the handover ends the HANDOVER ceiling with it, and arms the CORPSE ceiling for the sessions it dropped", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA, [liveSession("H", "sA")]));
    engine.allocateAttachSeq("A");
    expect(clock.pendingTimerCount()).toBe(1);
    expect(engine.snapshot().effectiveHostId).toBe("H");

    // The hard detach: `render-process-gone`, no `sessionLost` ever sent. The
    // handover ceiling dies with the attachment (its whole reason to exist is
    // gone). The ONE timer left is the corpse ceiling for H, armed because the
    // effective host just lost its only session without anyone saying so -
    // the authority-owned exit that used to exist only on the `lost`
    // transition, leaving H at a usable `connecting` for ever after a hard
    // detach unless the redial lane happened to accumulate refusals.
    engine.reporterDetached("A");
    expect(clock.pendingTimerCount()).toBe(1);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");
    clock.advance(EFFECTIVE_HOST_POST_SESSION_CEILING_MS);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - death aggregation", () => {
  it("SEAM: two windows contributing one refusal each is the same evidence as one window contributing two", () => {
    const clock = createFakeAuthorityClock(0);
    const twoWindow = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const seqA = twoWindow.engine.allocateAttachSeq("A");
    const attachA = twoWindow.engine.attach("A", attachRequest(seqA, []));
    const seqB = twoWindow.engine.allocateAttachSeq("B");
    const attachB = twoWindow.engine.attach("B", attachRequest(seqB, []));
    if (!attachA.ok || !attachB.ok)
      throw new Error("expected both attaches to succeed");

    twoWindow.engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H", "a1", null, 0),
    );
    twoWindow.engine.ingestEvidence(
      "B",
      attachB.incarnationId,
      dialRefusal("H", "b1", null, 0),
    );
    expect(findLease(twoWindow.engine.snapshot().leases, "H")?.status).not.toBe(
      "dead",
    );

    twoWindow.engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H", "a2", null, 0),
    );
    expect(findLease(twoWindow.engine.snapshot().leases, "H")?.status).toBe(
      "dead",
    );
    twoWindow.dispose();

    const oneWindow = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock: createFakeAuthorityClock(0),
    });
    const seqC = oneWindow.engine.allocateAttachSeq("C");
    const attachC = oneWindow.engine.attach("C", attachRequest(seqC, []));
    if (!attachC.ok) throw new Error("expected attach to succeed");
    oneWindow.engine.ingestEvidence(
      "C",
      attachC.incarnationId,
      dialRefusal("H", "c1", null, 0),
    );
    expect(findLease(oneWindow.engine.snapshot().leases, "H")?.status).not.toBe(
      "dead",
    );
    oneWindow.engine.ingestEvidence(
      "C",
      attachC.incarnationId,
      dialRefusal("H", "c2", null, 0),
    );
    expect(findLease(oneWindow.engine.snapshot().leases, "H")?.status).not.toBe(
      "dead",
    );
    oneWindow.engine.ingestEvidence(
      "C",
      attachC.incarnationId,
      dialRefusal("H", "c3", null, 0),
    );
    expect(findLease(oneWindow.engine.snapshot().leases, "H")?.status).toBe(
      "dead",
    );
    oneWindow.dispose();
  });

  it("dial dedup counts the same attemptId once per incarnation, and again from a different incarnation", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    for (let i = 0; i < 5; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", "dup", null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    const seqA2 = engine.allocateAttachSeq("A");
    const attachA2 = engine.attach("A", attachRequest(seqA2, []));
    if (!attachA2.ok) throw new Error("expected re-attach to succeed");
    engine.ingestEvidence(
      "A",
      attachA2.incarnationId,
      dialRefusal("H", "dup", null, 0),
    );
    engine.ingestEvidence(
      "A",
      attachA2.incarnationId,
      dialRefusal("H", "other", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });

  it("success clears the refusal streak; indeterminate never advances it", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H", "r1", null, 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H", "r2", null, 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialOutcome("H", "success-1", "success", 0),
    );

    for (let i = 0; i < 10; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialOutcome("H", `indeterminate-${i}`, "indeterminate", 0),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    authority.dispose();
  });

  it("a live session suppresses refusal accumulation; the streak reaches death normally once the session is lost", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach(
      "A",
      attachRequest(seqA, [liveSession("H", "s1")]),
    );
    if (!attachA.ok) throw new Error("expected attach to succeed");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    for (let i = 0; i < 5; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", `suppressed-${i}`, null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "lost", 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H", "fresh-1", null, 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H", "fresh-2", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H", "fresh-3", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });

  it("plan-restricted provenance: only comes from a confirmed refusal carrying it; null-detail is offline; last-counted refusal wins", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [
          fleetHost("H1", "remote"),
          fleetHost("H2", "remote"),
          fleetHost("H3", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H1", `plan-${i}`, "plan-restricted", i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H1")?.dead).toEqual({
      reason: "plan-restricted",
    });

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H2", `off-${i}`, null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H2")?.dead).toEqual({
      reason: "offline",
    });

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H3", "mix-1", "plan-restricted", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H3", "mix-2", "plan-restricted", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      dialRefusal("H3", "mix-3", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "H3")?.dead).toEqual({
      reason: "offline",
    });

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - session pairing", () => {
  it("session transitions are idempotent: duplicate established/lost are no-ops, lost-before-established tombstones, a stale incarnation is dropped", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "established", 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "lost", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "lost", 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    // lost before established: the id is tombstoned, the later established never lands.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s2", "lost", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s2", "established", 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    // a transition stamped with a stale incarnation is dropped.
    const seqA2 = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA2, []));
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s3", "established", 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - SEAM: cloud-DTO flip has no channel to a lease", () => {
  it("republishing an identical fleet membership never changes a lease, connecting and dead arms", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events, fleet } = authority;

    const revisionBefore = engine.snapshot().revision;
    const leaseEventsBefore = events.filter(
      (event) => event.kind === "leases",
    ).length;
    fleet.publish(0, null, [fleetHost("H", "remote")]);
    expect(engine.snapshot().revision).toBe(revisionBefore);
    expect(events.filter((event) => event.kind === "leases").length).toBe(
      leaseEventsBefore,
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", `d-${i}`, null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    const revisionAfterDeath = engine.snapshot().revision;
    fleet.publish(0, null, [fleetHost("H", "remote")]);
    expect(engine.snapshot().revision).toBe(revisionAfterDeath);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - compat freshness", () => {
  it("compat freshness is anchored to session observation order: a later session's verdict recovers the lease, and a delayed verdict re-anchored to the older session is dropped", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    // s1's ordinal is assigned now, on first observation.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", "s1", INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.dead?.reason).toBe(
      "incompatible",
    );

    // s1 is lost; s2 is observed for the first time now, so its ordinal is
    // strictly later than s1's - a legitimate downgrade / same-version
    // restart case, not a version-string comparison.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "lost", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s2", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatCompatible("H", "s2"),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    // A delayed verdict still anchored to s1 arrives after: its rank is
    // strictly below s2's, so it is dropped - the lease stays usable.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", "s1", INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });

  it("a null-anchored verdict never displaces a session-anchored one; null-vs-null latest wins", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H1", "remote"), fleetHost("H2", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H1", "s1", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H1", "s1", "lost", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H1", "s1", INCOMPAT_DETAIL),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatCompatible("H1", null),
    );
    expect(findLease(engine.snapshot().leases, "H1")?.dead?.reason).toBe(
      "incompatible",
    );

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H2", null, INCOMPAT_DETAIL),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatCompatible("H2", null),
    );
    expect(findLease(engine.snapshot().leases, "H2")?.status).not.toBe("dead");

    authority.dispose();
  });

  it("compat evidence for a host clears on fleet removal", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", null, INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.dead?.reason).toBe(
      "incompatible",
    );

    fleet.publish(0, null, []);
    expect(findLease(engine.snapshot().leases, "H")).toBeUndefined();

    fleet.publish(0, null, [fleetHost("H", "remote")]);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    authority.dispose();
  });

  it("an incompatible verdict outranks a live session", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach(
      "A",
      attachRequest(seqA, [liveSession("H", "s1")]),
    );
    if (!attachA.ok) throw new Error("expected attach to succeed");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", null, INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.dead?.reason).toBe(
      "incompatible",
    );

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - bounded per-incarnation state", () => {
  it("evicting session ordinals never promotes a stale verdict: an anchor for a session the reporter no longer holds ranks at the floor, not as the newest", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    // An ancient session, long since gone, that carried an incompatible
    // verdict at the time.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "ancient", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "ancient", "lost", 0),
    );

    // Push its ordinal out of the window.
    for (let i = 0; i < SESSION_ORDINAL_WINDOW + 1; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        sessionEvidence("H", `churn-${i}`, "established", 0),
      );
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        sessionEvidence("H", `churn-${i}`, "lost", 0),
      );
    }

    // The live session, and a compatible verdict probed on it.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "current", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatCompatible("H", "current"),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    // The delayed incompatible verdict for the EVICTED session must not win.
    // Before the floor rule, an unknown anchor was minted as the newest
    // ordinal, so eviction alone would have flipped this lease to dead.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", "ancient", INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });

  it("dial dedup still collapses duplicates inside the retained window", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    // One attempt, delivered many times: still one count, so the streak
    // cannot reach the threshold.
    for (let i = 0; i < 10; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", "duplicated", null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - restart-intent episodes", () => {
  it("a tombstone opens a restarting-expected hold that refusals cannot escape, and lapses on the engine's own deadline", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      restartIntent("H", "tomb-1", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe(
      "restarting-expected",
    );

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", `during-${i}`, null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe(
      "restarting-expected",
    );

    clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe(
      "restarting-expected",
    );
    // The streak crossed the threshold while held; the deadline firing with no
    // new evidence is what surfaces it.
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });

  it("SEAM: a tombstone replay after the episode has lapsed opens no new episode", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      restartIntent("H", "tomb-1", null, 0),
    );
    clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe(
      "restarting-expected",
    );

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      restartIntent("H", "tomb-1", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe(
      "restarting-expected",
    );

    authority.dispose();
  });

  it("a duplicate tombstone from another window mid-episode does not extend it", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach("B", attachRequest(seqB, []));
    if (!attachA.ok || !attachB.ok)
      throw new Error("expected both attaches to succeed");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      restartIntent("H", "tomb-1", null, 0),
    );
    clock.advance(RESTART_INTENT_EPISODE_MS / 2);
    engine.ingestEvidence(
      "B",
      attachB.incarnationId,
      restartIntent("H", "tomb-1", null, 0),
    );
    clock.advance(RESTART_INTENT_EPISODE_MS / 2 + 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe(
      "restarting-expected",
    );

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - expected-outage budgets are bounded", () => {
  // EVERY OTHER TEST OF THESE HOLDS SCALES WITH THEM. They advance the clock
  // relative to the constant (`RESTART_INTENT_EPISODE_MS + 1`, `/2`), which is
  // right for asserting the BEHAVIOUR - the episode lapses, the lease degrades
  // - and leaves the DURATION unpinned in both directions: multiplying either
  // budget by ten thousand keeps the whole suite green while shipping a
  // year-long `restarting-expected` hold. Pinned here because an expected
  // outage is a BOUNDED LIE: for its whole length the authority reports a host
  // it cannot reach as merely cycling, suppressing the death evidence that
  // would otherwise fail the window over.
  //
  // Bands rather than equalities. Both numbers are tunable within the range
  // connection registry §3 argues for, and an `===` here would be a
  // change-detector that fires on a legitimate tune while still not saying
  // what the value has to be TRUE of.
  it("the restart-intent episode covers a restart cycle without becoming a long-lived lie", () => {
    // Lower: a restart/apply cycle has to fit, or the exemption never does its
    // job and a deliberate restart still reads as death. Upper: a host that
    // never comes back must reach `dead` promptly - the user is waiting on ∅
    // or a failover, and neither can happen while this holds.
    expect(RESTART_INTENT_EPISODE_MS).toBeGreaterThanOrEqual(10_000);
    expect(RESTART_INTENT_EPISODE_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it("the local mutation-lane ceiling sits between the quiet and max host budgets", () => {
    // Anchored to registry §3's own numbers: never shorter than the 60s quiet
    // window (a lane that IS making progress must not be cut off), never
    // longer than the 15min update budget (the ceiling exists precisely so a
    // lane that never reports completion cannot pin a lease forever).
    //
    // THE UPPER BOUND IS DELIBERATELY TIGHT - it IS §3's documented max budget,
    // so any increase fails here. That is the intent, not an oversight: this
    // band pins the documented contract rather than a comfortable range, and a
    // legitimate upward tune means amending §3 first. If this assertion is in
    // your way, widen the REGISTRY, not the band.
    expect(LOCAL_EXPECTED_OUTAGE_CEILING_MS).toBeGreaterThanOrEqual(60_000);
    expect(LOCAL_EXPECTED_OUTAGE_CEILING_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe("SelectionAuthorityEngineImpl - local outage signal", () => {
  it("holds the local host's lease in restarting-expected while the signal is true, and the ceiling caps it", async () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: "local-1",
      hosts: [fleetHost("local-1", "local")],
    });
    const identity = {
      current: () => ({ identityKey: "acct-1", generation: 0 }),
      onChanged: () => ({ dispose: () => undefined }),
    };
    let outageState = false;
    const outageListeners = new Set<(inExpectedOutage: boolean) => void>();
    const outage: LocalHostOutageSignal = {
      inExpectedOutage: () => outageState,
      onChanged: (listener) => {
        outageListeners.add(listener);
        return { dispose: () => outageListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      // PROVISIONABLE, and settled BEFORE the outage edges below. The subject
      // here is a deliberate restart of a host that is up - which is the only
      // shape a user restart can have - so the construction-time ensure D14
      // draws for a never-dialed local host must have answered first. Left
      // in flight, its lease arm (which deliberately outranks this signal, so
      // provisioning never shows ∅) would answer every assertion below and the
      // outage hold would never be reached at all. That arm's own coverage is
      // the next test.
      localHostEnsure: readyLocalHostEnsurePort(),
      localOutage: outage,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: new InMemoryPreferredHostStore(),
      log: silentAuthorityLog,
    });
    await Promise.resolve();
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe(
      "connecting",
    );

    outageState = true;
    for (const listener of Array.from(outageListeners)) listener(true);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe(
      "restarting-expected",
    );

    outageState = false;
    for (const listener of Array.from(outageListeners)) listener(false);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).not.toBe(
      "restarting-expected",
    );

    outageState = true;
    for (const listener of Array.from(outageListeners)) listener(true);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe(
      "restarting-expected",
    );

    clock.advance(LOCAL_EXPECTED_OUTAGE_CEILING_MS + 1);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).not.toBe(
      "restarting-expected",
    );

    engine.dispose();
  });

  it("COMPOSITION: an ensure the ENGINE started outranks the outage signal it busies - the local lease stays connecting and ∅ never shows while provisioning", async () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: "local-1",
      hosts: [fleetHost("local-1", "local")],
    });
    const identity = {
      current: () => ({ identityKey: "acct-1", generation: 0 }),
      onChanged: () => ({ dispose: () => undefined }),
    };
    let outageState = false;
    const outageListeners = new Set<(inExpectedOutage: boolean) => void>();
    const outage: LocalHostOutageSignal = {
      inExpectedOutage: () => outageState,
      onChanged: (listener) => {
        outageListeners.add(listener);
        return { dispose: () => outageListeners.delete(listener) };
      },
    };
    const ensure = createDeferredEnsure();
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: ensure.port,
      localOutage: outage,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: new InMemoryPreferredHostStore(),
      log: silentAuthorityLog,
    });
    // Derivation wants the local host and it has never been dialed, so D14's
    // one sanctioned process action fires and stays outstanding.
    expect(ensure.calls.count).toBe(1);

    // THE EDGE THIS PINS. `LocalHostEnsurePort` is wired to
    // `HostController.convergeReady`, which busies the very mutation lane
    // `LocalHostOutageSignal` reports - so the engine's own provisioning
    // request raises this signal, and the raised signal is INDISTINGUISHABLE
    // from a user restart landing in the same window (F3(c): "the engine's own
    // ensure busies the lane at request, so 'the outage began after my
    // request' is true of ourselves"; one boolean cannot carry provenance).
    //
    // The arm order resolves it in the direction that cannot hurt: while the
    // engine is waiting on its own answer the local lease reads `connecting`,
    // which is usable, so a user whose host is being started FOR them is never
    // shown the ∅ modal. Ranking the outage arm first instead passes every
    // other test in this file - measured, not assumed - and would ship exactly
    // that regression. The mis-attributed user restart is the accepted
    // residual, bounded by the request: it self-heals below.
    outageState = true;
    for (const listener of Array.from(outageListeners)) listener(true);
    const held = findLease(engine.snapshot().leases, "local-1");
    if (held === undefined) throw new Error("expected a lease for local-1");
    expect(held.status).toBe("connecting");
    expect(isUsableForSelection(held)).toBe(true);
    expect(engine.snapshot().effectiveHostId).toBe("local-1");
    expect(ensure.calls.count).toBe(1);

    // Self-healing: once the request the engine was waiting on answers, the
    // arm is gone and the lane's own signal governs the lease again. The
    // window keeps pointing at the cycling host (the D5/M6 HOLD), which is the
    // whole reason `restarting-expected` is a hold rather than eligibility.
    await ensure.resolve(true);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("local-1");

    engine.dispose();
  });

  it("COMPOSITION: a live session outranks the engine's own in-flight ensure - the warm host reads ready, not connecting, for the whole converge", async () => {
    // The launch-time ensure fires on every cold boot (never-dialed is
    // trivially true at t=0), and on a machine whose host is ALREADY UP it is
    // a 30-45s CLI converge that proves nothing about the host's ability to
    // serve. This pins the arm's live-session branch: the moment a session
    // establishes, the lease answers `ready` with the ensure still
    // unresolved - which is what lets the window narrator clear over a
    // working app instead of holding "Setting up Traycer" for the converge's
    // whole duration (the measured 30-60s startup regression).
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;
    // Construction derives, sees a never-dialed wanted local host, and mints
    // the launch ensure.
    expect(ensure.calls.count).toBe(1);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");

    const incarnation = attachReporter(engine, "A");
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("L", "s1", "established", 1),
    );
    // The ensure has NOT resolved - the session alone flips the lease.
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("ready");
    expect(engine.snapshot().effectiveHostId).toBe("L");
    expect(ensure.calls.count).toBe(1);

    // When the converge later stops the host for a swap, the session drops
    // and the arm's non-committal answer resumes - connecting, never dead,
    // and never `restarting-expected` (the ensure arm still preempts the
    // outage arm in both branches; that is the original COMPOSITION pin).
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("L", "s1", "lost", 1),
    );
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    await ensure.resolve(true);
    authority.dispose();
  });

  it("a DEFERRED ensure paces the next request without deadening the lease", async () => {
    // Deferral means the lifecycle lane or its CLI lock was busy - another
    // launch actor mid-work - so NOTHING ran and nothing was learned about
    // the host. Before the split this armed the same 30s cooldown a genuine
    // provisioning failure arms, which derives `dead: offline` and put the
    // "No host is available" modal over a healthy machine whose lock the
    // desktop's own launch reconcile happened to hold.
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;
    expect(ensure.calls.count).toBe(1);

    await ensure.resolveDeferred();

    // Not dead, and the host stays selectable: the lease keeps the
    // non-committal answer a never-dialed host has always had.
    const after = findLease(engine.snapshot().leases, "L");
    expect(after?.status).toBe("connecting");
    expect(after?.dead).toBeNull();
    expect(engine.snapshot().effectiveHostId).toBe("L");
    // ...but the request IS paced: the commit that followed completion did
    // not immediately re-mint against the still-busy lane.
    expect(ensure.calls.count).toBe(1);

    // The hold lapses on the engine's own deadline timer, and the retry runs.
    clock.advance(LOCAL_ENSURE_RETRY_COOLDOWN_MS);
    expect(ensure.calls.count).toBe(2);

    await ensure.resolve(true);
    authority.dispose();
  });
});

describe("isUsableForSelection", () => {
  it("is false for every dead reason and restarting-expected, true for ready/degraded/connecting", () => {
    const usable: HostLeaseSnapshot = {
      hostId: "h",
      status: "connecting",
      dead: null,
    };
    const ready: HostLeaseSnapshot = {
      hostId: "h",
      status: "ready",
      dead: null,
    };
    const degraded: HostLeaseSnapshot = {
      hostId: "h",
      status: "degraded",
      dead: null,
    };
    const restarting: HostLeaseSnapshot = {
      hostId: "h",
      status: "restarting-expected",
      dead: null,
    };
    const deadOffline: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "offline" },
    };
    const deadPlanRestricted: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "plan-restricted" },
    };
    const deadRemoved: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "removed" },
    };
    const deadIncompatible: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "incompatible", detail: INCOMPAT_DETAIL },
    };

    expect(isUsableForSelection(usable)).toBe(true);
    expect(isUsableForSelection(ready)).toBe(true);
    expect(isUsableForSelection(degraded)).toBe(true);
    expect(isUsableForSelection(restarting)).toBe(false);
    expect(isUsableForSelection(deadOffline)).toBe(false);
    expect(isUsableForSelection(deadPlanRestricted)).toBe(false);
    expect(isUsableForSelection(deadRemoved)).toBe(false);
    expect(isUsableForSelection(deadIncompatible)).toBe(false);
  });
});

describe("SelectionAuthorityEngineImpl - identity transitions", () => {
  it("SEAM: account A to sign-out to account B wipes evidence, voids every incarnation, orders reattachRequired after the commit, and rejects a late same-generation fleet completion", async () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [fleetHost("H", "remote"), fleetHost("H2", "remote")],
    });
    let identityState = { identityKey: "acct-A", generation: 0 };
    const identityListeners = new Set<
      (identity: { identityKey: string | null; generation: number }) => void
    >();
    const identity: AuthorityIdentitySource = {
      current: () => identityState,
      onChanged: (listener) => {
        identityListeners.add(listener);
        return { dispose: () => identityListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: new InMemoryPreferredHostStore(),
      log: silentAuthorityLog,
    });
    const { events } = recordEngineEvents(engine);

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach(
      "A",
      attachRequest(seqA, [liveSession("H", "s1")]),
    );
    if (!attachA.ok) throw new Error("expected attach to succeed");
    const oldIncarnation = attachA.incarnationId;

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        oldIncarnation,
        dialRefusal("H2", `dead-${i}`, null, i),
      );
    }
    expect(findLease(engine.snapshot().leases, "H2")?.status).toBe("dead");
    engine.ingestEvidence(
      "A",
      oldIncarnation,
      restartIntent("H2", "tomb-x", null, 0),
    );

    // The new-generation fleet is already available by the time the identity
    // transition runs, so it is adopted as part of the SAME transaction.
    fleet.publish(1, null, [
      fleetHost("H", "remote"),
      fleetHost("H2", "remote"),
    ]);

    const eventsBeforeTransition = events.length;
    identityState = { identityKey: "acct-B", generation: 1 };
    for (const listener of Array.from(identityListeners))
      listener(identityState);

    const transitionEvents = events.slice(eventsBeforeTransition);
    expect(transitionEvents.length).toBeGreaterThan(0);
    const reattachEvent = transitionEvents[transitionEvents.length - 1];
    expect(reattachEvent.kind).toBe("reattach");
    for (const event of transitionEvents.slice(0, -1)) {
      expect(event.revision).toBeLessThan(reattachEvent.revision);
    }

    // (a) evidence is gone: H2, which was dead, comes back as ordinary connecting.
    expect(findLease(engine.snapshot().leases, "H2")?.status).toBe(
      "connecting",
    );

    // (c) every incarnation is void.
    engine.ingestEvidence(
      "A",
      oldIncarnation,
      dialRefusal("H", "post-transition", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");
    expect(await engine.activate("A", oldIncarnation, "H")).toEqual({
      ok: false,
      reason: "not-attached",
    });

    // (d) a late fleet completion stamped with the OLD generation is rejected.
    const revisionBeforeLateFleet = engine.snapshot().revision;
    fleet.publish(0, null, [
      fleetHost("H", "remote"),
      fleetHost("H2", "remote"),
    ]);
    expect(engine.snapshot().revision).toBe(revisionBeforeLateFleet);

    // (e) the generation-1 snapshot published before the transition is in effect.
    expect(findLease(engine.snapshot().leases, "H")).toBeDefined();
    expect(findLease(engine.snapshot().leases, "H2")).toBeDefined();

    engine.dispose();
  });

  it("identity callbacks are accepted monotonically: a callback whose generation is not greater than current is ignored", () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [fleetHost("H", "remote")],
    });
    let identityState = { identityKey: "acct-A", generation: 0 };
    const identityListeners = new Set<
      (identity: { identityKey: string | null; generation: number }) => void
    >();
    const identity: AuthorityIdentitySource = {
      current: () => identityState,
      onChanged: (listener) => {
        identityListeners.add(listener);
        return { dispose: () => identityListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: new InMemoryPreferredHostStore(),
      log: silentAuthorityLog,
    });
    const { events } = recordEngineEvents(engine);

    identityState = { identityKey: "acct-B", generation: 1 };
    for (const listener of Array.from(identityListeners))
      listener(identityState);
    expect(events.filter((event) => event.kind === "reattach").length).toBe(1);
    const revisionAfterTransition = engine.snapshot().revision;

    // Same generation replayed (coalesced callback): ignored.
    for (const listener of Array.from(identityListeners)) {
      listener({ identityKey: "acct-B", generation: 1 });
    }
    expect(engine.snapshot().revision).toBe(revisionAfterTransition);
    expect(events.filter((event) => event.kind === "reattach").length).toBe(1);

    // An older generation replayed: also ignored.
    for (const listener of Array.from(identityListeners)) {
      listener({ identityKey: "acct-A", generation: 0 });
    }
    expect(engine.snapshot().revision).toBe(revisionAfterTransition);
    expect(events.filter((event) => event.kind === "reattach").length).toBe(1);

    engine.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - revision discipline", () => {
  it("revisions across a scenario driving every event kind are strictly increasing, unique, and consecutive within one transaction", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events, fleet, identity } = authority;

    // A fleet-shift that moves both the selection (target appears) and the
    // leases (a host appears) in one transaction: consecutive revisions.
    fleet.publish(0, "L", [fleetHost("L", "local")]);
    const afterFleetShift = events.length;
    expect(events[afterFleetShift - 2].kind).toBe("selection");
    expect(events[afterFleetShift - 1].kind).toBe("leases");
    expect(events[afterFleetShift - 1].revision).toBe(
      events[afterFleetShift - 2].revision + 1,
    );

    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach(
      "A",
      attachRequest(seqA, [liveSession("L", "s1")]),
    );
    if (!attachA.ok) throw new Error("expected attach to succeed");
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("L", "s1", "lost", 0),
    );
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("L", `d-${i}`, null, i),
      );
    }
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      restartIntent("L", "tomb-1", null, 0),
    );
    identity.set("acct-2");

    const revisions = events.map((event) => event.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    for (let i = 1; i < revisions.length; i += 1) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
    }

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - realistic redial cadence", () => {
  it("SEAM: confirms death within the target window using a realistic redial cadence", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach(
      "A",
      attachRequest(seqA, [liveSession("H", "s1")]),
    );
    if (!attachA.ok) throw new Error("expected attach to succeed");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "lost", clock.now()),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    const cadenceMs = [1000, 2000, 4000];
    let elapsed = 0;
    for (const delay of cadenceMs) {
      clock.advance(delay);
      elapsed += delay;
      engine.ingestEvidence(
        "A",
        attachA.incarnationId,
        dialRefusal("H", `redial-${elapsed}`, null, clock.now()),
      );
    }

    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");
    expect(elapsed).toBeLessThanOrEqual(10_000);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - reporter detach", () => {
  it("drops the reporter's sessions but keeps the supersession fence", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    engine.attach("A", attachRequest(seqA, [liveSession("H", "s1")]));
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("ready");

    engine.reporterDetached("A");
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("ready");

    const replay = engine.attach("A", attachRequest(seqA, []));
    expect(replay).toEqual({ ok: false, kind: "superseded" });

    const seqA2 = engine.allocateAttachSeq("A");
    const fresh = engine.attach("A", attachRequest(seqA2, []));
    expect(fresh.ok).toBe(true);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - activate (P1.2)", () => {
  it("refuses a stale incarnation and an unknown host, and accepts a fleet host by writing preferred + emitting cause activate", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events, preferredStore } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    expect(await engine.activate("A", "some-other-incarnation", "H")).toEqual({
      ok: false,
      reason: "not-attached",
    });
    // F14: a directory-validated write refuses an id the fleet does not hold,
    // so no path can re-assert a deregistered host.
    expect(await engine.activate("A", attachA.incarnationId, "ghost")).toEqual({
      ok: false,
      reason: "unknown-host",
    });

    expect(await engine.activate("A", attachA.incarnationId, "H")).toEqual({
      ok: true,
    });
    expect(engine.snapshot().preferredHostId).toBe("H");
    // Persisted under the signed-in identity, and re-derivation has already
    // been emitted by the time `ok: true` resolves.
    expect(preferredStore.load("acct-1")).toBe("H");
    const selectionEvents = events.filter(
      (event) => event.kind === "selection",
    );
    const last = selectionEvents[selectionEvents.length - 1];
    if (last === undefined || last.kind !== "selection") {
      throw new Error("expected a selection event");
    }
    expect(last.change.cause).toBe("activate");
    expect(last.change.preferredHostId).toBe("H");
    expect(last.change.effectiveHostId).toBe("H");

    authority.dispose();
  });

  it("refuses a host whose current compat verdict is incompatible (D13)", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", null, INCOMPAT_DETAIL),
    );

    expect(await engine.activate("A", attachA.incarnationId, "H")).toEqual({
      ok: false,
      reason: "incompatible",
    });
    expect(engine.snapshot().preferredHostId).toBeNull();

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - fleet shift", () => {
  it("a fleet snapshot whose localHostId appears emits selectionChanged with cause fleet-shift, targeting the local host", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { events, fleet } = authority;

    fleet.publish(0, "L", [fleetHost("L", "local")]);

    const selectionEvents = events.filter(
      (event) => event.kind === "selection",
    );
    const last = selectionEvents[selectionEvents.length - 1];
    if (last.kind !== "selection")
      throw new Error("expected a selection event");
    expect(last.change.cause).toBe("fleet-shift");
    expect(last.change.targetHostId).toBe("L");
    // Derivation is real from P1.2: with no preference, the usable local host
    // is both the target (M5) and the effective host.
    expect(last.change.effectiveHostId).toBe("L");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - listener isolation", () => {
  it("a listener that throws does not stop delivery to other listeners", () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [],
    });
    const identity = {
      current: () => ({ identityKey: "acct-1", generation: 0 }),
      onChanged: () => ({ dispose: () => undefined }),
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: new InMemoryPreferredHostStore(),
      log: silentAuthorityLog,
    });

    let secondCalled = 0;
    engine.onSelectionChanged(() => {
      throw new Error("boom");
    });
    engine.onSelectionChanged(() => {
      secondCalled += 1;
    });

    fleet.publish(0, "L", [fleetHost("L", "local")]);
    expect(secondCalled).toBe(1);

    engine.dispose();
  });
});

// --------------------------------------------------- P1.1 fixup round (cold
// review blockers A1-A5) - see the module header's "re-entrancy" and
// "compat-rank" sections for the mechanisms these pin.

describe("SelectionAuthorityEngineImpl - A1: re-entrancy during attach", () => {
  it("seals attach's result BEFORE draining, so a listener-driven identity transition mints its reattachRequired at a revision ABOVE the sealed snapshot", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, identity, events } = authority;

    let leaseCallbackCount = 0;
    engine.onLeasesChanged(() => {
      leaseCallbackCount += 1;
      if (leaseCallbackCount === 1) {
        // A nested transaction, driven from inside the attach's own delivery:
        // an identity transition mid-drain.
        identity.set("acct-2");
      }
    });

    const seqA = engine.allocateAttachSeq("A");
    // The live session moves the leases slice too (H flips to ready), so the
    // attach's own transaction actually reaches the lease listener above.
    const result = engine.attach(
      "A",
      attachRequest(seqA, [liveSession("H", "s1")]),
    );
    if (!result.ok) throw new Error("expected attach to succeed");

    const reattachEvent = events.find((event) => event.kind === "reattach");
    if (reattachEvent === undefined) {
      throw new Error(
        "expected the nested identity transition to mint a reattachRequired",
      );
    }
    expect(reattachEvent.revision).toBeGreaterThan(result.snapshot.revision);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - A2: nested commit does not split a sibling pair", () => {
  it("a nested transaction triggered mid-delivery appends after the parent's selection/leases pair instead of splitting it", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: EMPTY_FLEET_SEED,
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet, events } = authority;

    let selectionCallbackCount = 0;
    engine.onSelectionChanged(() => {
      selectionCallbackCount += 1;
      if (selectionCallbackCount === 1) {
        // A nested fleet-shift, driven from inside the parent's own delivery.
        fleet.publish(0, "L", [
          fleetHost("L", "local"),
          fleetHost("H2", "remote"),
        ]);
      }
    });

    const beforeCount = events.length;
    // Moves BOTH slices: the target appears (selection) and a host appears
    // (leases) - the parent's consecutive sibling pair.
    fleet.publish(0, "L", [fleetHost("L", "local")]);

    const transactionEvents = events.slice(beforeCount);
    expect(transactionEvents.length).toBeGreaterThanOrEqual(3);
    const [selectionEvent, leasesEvent, ...rest] = transactionEvents;
    expect(selectionEvent.kind).toBe("selection");
    expect(leasesEvent.kind).toBe("leases");
    // Consecutive: nothing from the nested transaction interleaved between them.
    expect(leasesEvent.revision).toBe(selectionEvent.revision + 1);
    for (const event of rest) {
      expect(event.revision).toBeGreaterThan(leasesEvent.revision);
    }

    // The full recorded sequence is strictly increasing with no duplicates.
    const revisions = events.map((event) => event.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    for (let i = 1; i < revisions.length; i += 1) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
    }

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - A3: compat ranks are incarnation-scoped", () => {
  it('two windows that both call their session "s1" rank by the authority\'s own observation order, not a shared ordinal', () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected A to attach");
    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach("B", attachRequest(seqB, []));
    if (!attachB.ok) throw new Error("expected B to attach");

    // A establishes its "s1" first; B's "s1" is observed later, so B's ordinal
    // is strictly newer even though the session ids collide.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      sessionEvidence("H", "s1", "established", 0),
    );
    engine.ingestEvidence(
      "B",
      attachB.incarnationId,
      sessionEvidence("H", "s1", "established", 0),
    );

    engine.ingestEvidence(
      "B",
      attachB.incarnationId,
      compatCompatible("H", "s1"),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    // A's older session reports incompatible on ITS "s1". If ranks were
    // shared by session id, this would tie (latest-received wins) and flip
    // B's live host to dead.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      compatIncompatible("H", "s1", INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - A4: identity transition keeps an active local outage", () => {
  it("a deliberate local restart spanning a sign-out is not blindly cleared, and the ceiling still counts from the ORIGINAL start", async () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: "local-1",
      hosts: [fleetHost("local-1", "local")],
    });
    let identityState = { identityKey: "acct-A", generation: 0 };
    const identityListeners = new Set<
      (identity: { identityKey: string | null; generation: number }) => void
    >();
    const identity: AuthorityIdentitySource = {
      current: () => identityState,
      onChanged: (listener) => {
        identityListeners.add(listener);
        return { dispose: () => identityListeners.delete(listener) };
      },
    };
    let outageState = false;
    const outageListeners = new Set<(inExpectedOutage: boolean) => void>();
    const outage: LocalHostOutageSignal = {
      inExpectedOutage: () => outageState,
      onChanged: (listener) => {
        outageListeners.add(listener);
        return { dispose: () => outageListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      // Provisionable, and settled before the restart - see the D5 suite's
      // note: a host a user restarts is a host that was up.
      localHostEnsure: readyLocalHostEnsurePort(),
      fleet,
      identity,
      localOutage: outage,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: new InMemoryPreferredHostStore(),
      log: silentAuthorityLog,
    });
    await Promise.resolve();

    outageState = true;
    for (const listener of Array.from(outageListeners)) listener(true);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe(
      "restarting-expected",
    );

    clock.advance(1000);

    // The new-generation fleet is already available by the time the identity
    // transition runs, so the local host is still a member afterwards. No new
    // outage edge fires.
    fleet.publish(1, "local-1", [fleetHost("local-1", "local")]);
    identityState = { identityKey: "acct-B", generation: 1 };
    for (const listener of Array.from(identityListeners))
      listener(identityState);

    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe(
      "restarting-expected",
    );

    // The ceiling counts from the ORIGINAL start (t=0), not from the
    // transition (t=1000): 1000ms elapsed already, so only CEILING - 1000
    // more is needed to lapse it.
    clock.advance(LOCAL_EXPECTED_OUTAGE_CEILING_MS - 1000 - 1);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).toBe(
      "restarting-expected",
    );

    clock.advance(2);
    expect(findLease(engine.snapshot().leases, "local-1")?.status).not.toBe(
      "restarting-expected",
    );

    engine.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - closure round: drain guard orders delivery across listeners", () => {
  it("every listener receives revision N before ANY listener receives revision N+1, even when listener 1 re-enters synchronously", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H1", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;

    const delivered: Array<{ listenerIndex: number; revision: number }> = [];
    let reentered = false;
    // Listener 1 re-enters the engine mid-delivery by publishing a fleet
    // snapshot, which stages a second leasesChanged event. The drain guard
    // (`if (this.draining) return;`) is what stops that nested transaction
    // from being delivered inline, ahead of listener 2 seeing the first one.
    engine.onLeasesChanged((event) => {
      delivered.push({ listenerIndex: 0, revision: event.revision });
      if (!reentered) {
        reentered = true;
        fleet.publish(0, null, [
          fleetHost("H1", "remote"),
          fleetHost("H2", "remote"),
          fleetHost("H3", "remote"),
        ]);
      }
    });
    engine.onLeasesChanged((event) => {
      delivered.push({ listenerIndex: 1, revision: event.revision });
    });

    fleet.publish(0, null, [
      fleetHost("H1", "remote"),
      fleetHost("H2", "remote"),
    ]);

    expect(delivered.length).toBe(4);
    const firstRevision = delivered[0].revision;
    const secondRevision = delivered[2].revision;
    expect(secondRevision).toBeGreaterThan(firstRevision);
    expect(delivered).toEqual([
      { listenerIndex: 0, revision: firstRevision },
      { listenerIndex: 1, revision: firstRevision },
      { listenerIndex: 0, revision: secondRevision },
      { listenerIndex: 1, revision: secondRevision },
    ]);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - A5: tombstone seen-ids are pruned on fleet removal", () => {
  it("a replayed tombstoneId opens a NEW episode once the host has left and rejoined the fleet", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      restartIntent("H", "tomb-1", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe(
      "restarting-expected",
    );

    clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe(
      "restarting-expected",
    );

    fleet.publish(0, null, []);
    expect(findLease(engine.snapshot().leases, "H")).toBeUndefined();

    fleet.publish(0, null, [fleetHost("H", "remote")]);
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("connecting");

    // Same tombstoneId, replayed after the host rejoined: without pruning the
    // seen-id set on removal, this would be a no-op forever.
    engine.ingestEvidence(
      "A",
      attachA.incarnationId,
      restartIntent("H", "tomb-1", null, clock.now()),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe(
      "restarting-expected",
    );

    authority.dispose();
  });
});

// ------------------------------------------------------- :803 owed pins
// `pruneEvidenceOutsideFleet` clears a deregistered host's evidence, but an
// in-flight compat probe / restart notification / dial report landing
// afterwards recreates it through `hostEvidence`. The next snapshot does not
// repair this - if the same durable host id re-registers, the prune finds it
// a member and deletes nothing, so it inherits its pre-removal state.
// `dropsAsOutsideFleet` closes the gap; session evidence is deliberately
// exempt (invariant 5), and it composes with `pruneEvidenceOutsideFleet`
// rather than narrowing C4's live-session suppression inside `ingestDial`.

describe("SelectionAuthorityEngineImpl - dropsAsOutsideFleet gates late evidence for a removed host (:803 fix)", () => {
  it("R2a-control: prune genuinely clears a verdict when no late report arrives", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("X", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("X", null, INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe("dead");

    // X leaves the fleet: the prune clears its evidence outright.
    fleet.publish(0, "L", [fleetHost("L", "local")]);
    expect(findLease(engine.snapshot().leases, "X")).toBeUndefined();

    // X rejoins with NO late report in between. This is the positive control
    // the harm arms below lean on: it proves the prune really cleared, so a
    // `dead` verdict below is attributable to the late report and nothing
    // else.
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("X", "remote")]);
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe("connecting");

    authority.dispose();
  });

  it("R2a: a late compat verdict survives deregistration and is inherited on re-registration", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("X", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    fleet.publish(0, "L", [fleetHost("L", "local")]);
    expect(findLease(engine.snapshot().leases, "X")).toBeUndefined();

    // The probe that was in flight when X was deregistered lands now. Without
    // the gate, `hostEvidence` recreates the entry the prune just deleted.
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("X", null, INCOMPAT_DETAIL),
    );

    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("X", "remote")]);
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe("connecting");

    authority.dispose();
  });

  it("R2b: a late restart-intent re-anchors an episode on a re-registered host", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("X", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      restartIntent("X", "tomb-1", null, 0),
    );
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe(
      "restarting-expected",
    );

    fleet.publish(0, "L", [fleetHost("L", "local")]);
    // Replay of the SAME tombstone: ordinarily an ignored duplicate
    // (mechanism 7), but without the gate the prune erased the memory of
    // having seen it, so the replay anchors a fresh episode.
    engine.ingestEvidence(
      "A",
      incarnation,
      restartIntent("X", "tomb-1", null, 0),
    );
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("X", "remote")]);
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe("connecting");

    authority.dispose();
  });

  it("R2c: late dial refusals rebuild a death streak on a host outside the fleet", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("X", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    fleet.publish(0, "L", [fleetHost("L", "local")]);
    killHostWithRefusals(engine, "A", incarnation, "X");
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("X", "remote")]);
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe("connecting");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - hasFleetAnswer distinguishes an answered [] from no answer yet (:803 fix)", () => {
  it("R2d: evidence arriving BEFORE the registry's first answer is kept", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    expect(engine.snapshot().leases).toHaveLength(0);
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("X", null, INCOMPAT_DETAIL),
    );

    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("X", "remote")]);
    const lease = findLease(engine.snapshot().leases, "X");
    expect(lease?.status).toBe("dead");
    expect(lease?.dead?.reason).toBe("incompatible");

    authority.dispose();
  });

  it("a cold start whose first answer is an empty fleet drops a late verdict", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: { identityGeneration: 0, localHostId: null, hosts: [] },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    // The registry ANSWERS, and the answer is "this account has no hosts".
    // Nothing about the fleet's CONTENT changed here - only that it is now
    // KNOWN, which is the discriminator R2d's empty seed cannot draw: a
    // PUBLISHED snapshot is always an answer, even an empty one.
    fleet.publish(0, null, []);

    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("X", null, INCOMPAT_DETAIL),
    );

    fleet.publish(0, null, [fleetHost("X", "remote")]);
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe("connecting");

    authority.dispose();
  });

  it("construction seeded with a non-empty fleet counts as answered; an empty seed does not", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    // The seed already names a host, so - unlike R2d's empty seed - this
    // counts as answered from CONSTRUCTION: a late report for a host outside
    // it is dropped immediately, with no publish needed to arm the gate.
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("X", null, INCOMPAT_DETAIL),
    );

    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("X", "remote")]);
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe("connecting");

    authority.dispose();
  });

  it("an identity transition resets the answer flag: a fresh window accepts evidence again", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("X", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, identity, fleet } = authority;

    // PREMISE: account A's seed already names X, so A has answered - X is a
    // member and derives an ordinary lease.
    expect(findLease(engine.snapshot().leases, "X")?.status).toBe("connecting");

    // Switch accounts. B's fleet has not arrived, so B has answered nothing -
    // the transition must put the flag back rather than carry A's forward.
    identity.set("acct-2");
    expect(engine.snapshot().leases).toHaveLength(0);

    const incarnation = attachReporter(engine, "A");
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("Y", null, INCOMPAT_DETAIL),
    );

    // B's first answer names Y: the verdict ingested during B's unknown
    // window must have been kept, which is only visible once it is credited
    // into a real lease on the far side.
    fleet.publish(1, null, [fleetHost("Y", "remote")]);
    const lease = findLease(engine.snapshot().leases, "Y");
    expect(lease?.status).toBe("dead");
    expect(lease?.dead?.reason).toBe("incompatible");

    authority.dispose();
  });
});

// ------------------------------------------------------- P1.2 owed pins
// (host-lifecycle redesign, ticket P1.2 test brief - each pins a real engine
// behavior that had no test that would catch a regression).

describe("SelectionAuthorityEngineImpl - derivation precedence (P1.2)", () => {
  it("a usable preferred host outranks a usable local host: effective is the preferred host", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      // A PROVISIONABLE local host, which is what makes this a precedence test
      // at all. The suite default cannot start L, so L reaches `dead` the
      // moment the construction-time ensure answers (registry §5) - and a test
      // whose whole point is "both candidates are usable, the preferred one
      // wins" would then be proving only that the loser was unusable.
      localHostEnsure: readyLocalHostEnsurePort(),
    });
    const { engine } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    // L is usable by `isUsableForSelection` (only `dead` and
    // `restarting-expected` are excluded). Both P and L are therefore usable
    // at the moment of activation, which is what makes this a precedence test
    // rather than a "no other candidate" test.
    const localLease = findLease(engine.snapshot().leases, "L");
    if (localLease === undefined) throw new Error("expected a lease for L");
    expect(isUsableForSelection(localLease)).toBe(true);

    expect(await engine.activate("A", attachA.incarnationId, "P")).toEqual({
      ok: true,
    });

    expect(engine.snapshot().preferredHostId).toBe("P");
    expect(engine.snapshot().targetHostId).toBe("P");
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // Still true after the activation - L was never made unusable, so this
    // pins ORDER (the preferred arm runs before the local arm), not merely
    // "local was unusable so preferred won by default".
    const localLeaseAfter = findLease(engine.snapshot().leases, "L");
    if (localLeaseAfter === undefined)
      throw new Error("expected a lease for L");
    expect(isUsableForSelection(localLeaseAfter)).toBe(true);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - F14 deregister-clear (P1.2)", () => {
  it("a non-empty fleet that omits the preferred host clears preferred and emits cause deregister-clear; an empty fleet does not clear", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events, fleet, preferredStore } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    expect(await engine.activate("A", attachA.incarnationId, "H")).toEqual({
      ok: true,
    });
    expect(engine.snapshot().preferredHostId).toBe("H");

    // An EMPTY fleet must NOT clear the preference (module header: "no hosts"
    // is what this port publishes before its first genuine registry answer,
    // and while an identity transition is in flight).
    fleet.publish(0, null, []);
    expect(engine.snapshot().preferredHostId).toBe("H");
    expect(preferredStore.load("acct-1")).toBe("H");
    const selectionEvents = events.filter(
      (event) => event.kind === "selection",
    );
    const afterEmptyFleet = selectionEvents[selectionEvents.length - 1];
    if (afterEmptyFleet === undefined || afterEmptyFleet.kind !== "selection") {
      throw new Error("expected a selection event");
    }
    expect(afterEmptyFleet.change.cause).not.toBe("deregister-clear");

    // A NON-EMPTY fleet that omits the preferred host clears it and stamps
    // the cause deregister-clear.
    fleet.publish(0, null, [fleetHost("OTHER", "remote")]);
    expect(engine.snapshot().preferredHostId).toBeNull();
    expect(preferredStore.load("acct-1")).toBeNull();
    const afterDeregister = events
      .filter((event) => event.kind === "selection")
      .at(-1);
    if (afterDeregister === undefined || afterDeregister.kind !== "selection") {
      throw new Error("expected a selection event");
    }
    expect(afterDeregister.change.cause).toBe("deregister-clear");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - identity wipe (P1.2, G1)", () => {
  it("activating under identity A then transitioning to B empties A's preferred bucket and B inherits nothing", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-A",
      clock,
    });
    const { engine, identity, preferredStore } = authority;
    const seqA = engine.allocateAttachSeq("A");
    const attachA = engine.attach("A", attachRequest(seqA, []));
    if (!attachA.ok) throw new Error("expected attach to succeed");

    expect(await engine.activate("A", attachA.incarnationId, "H")).toEqual({
      ok: true,
    });
    expect(preferredStore.load("acct-A")).toBe("H");

    identity.set("acct-B");

    // A's bucket is wiped, not merely left behind - a shared machine must not
    // be able to read A's choice back out of the store later.
    expect(preferredStore.load("acct-A")).toBeNull();
    // B inherits nothing: no bucket was ever written for acct-B, and the
    // engine's own preferred is null immediately after the transition.
    expect(preferredStore.load("acct-B")).toBeNull();
    expect(engine.snapshot().preferredHostId).toBeNull();

    authority.dispose();
  });
});

// ------------------------------------------------------- P1.3 owed pins
// (host-lifecycle redesign, ticket P1.3 test brief).

function attachReporter(
  engine: SelectionAuthorityEngineImpl,
  reporterId: string,
): string {
  const seq = engine.allocateAttachSeq(reporterId);
  const attach = engine.attach(reporterId, attachRequest(seq, []));
  if (!attach.ok) throw new Error(`expected attach ${reporterId} to succeed`);
  return attach.incarnationId;
}

function killHostWithRefusals(
  engine: SelectionAuthorityEngineImpl,
  reporterId: string,
  incarnationId: string,
  hostId: string,
): void {
  for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
    engine.ingestEvidence(
      reporterId,
      incarnationId,
      dialRefusal(hostId, `${hostId}-kill-${i}`, null, i),
    );
  }
}

function lastSelectionChange(
  events: readonly { kind: string; change?: SelectionChange }[],
): SelectionChange {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "selection" && event.change !== undefined) {
      return event.change;
    }
  }
  throw new Error("expected a selection event");
}

interface DeferredEnsure {
  readonly port: LocalHostEnsurePort;
  readonly calls: { count: number };
  resolve(ok: boolean): Promise<void>;
  /** Resolves the pending ensure as a DEFERRAL - the lane was busy, nothing ran. */
  resolveDeferred(): Promise<void>;
}

function createDeferredEnsure(): DeferredEnsure {
  const calls = { count: 0 };
  const pending: Array<
    (
      value: { ok: true } | { ok: false; reason: string; deferred: boolean },
    ) => void
  > = [];
  return {
    port: {
      ensureReady: () => {
        calls.count += 1;
        return new Promise((resolve) => {
          pending.push(resolve);
        });
      },
    },
    calls,
    resolve: async (ok: boolean) => {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("no pending ensure");
      resolve(
        ok
          ? { ok: true }
          : { ok: false, reason: "ensure-failed", deferred: false },
      );
      await Promise.resolve();
    },
    resolveDeferred: async () => {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("no pending ensure");
      resolve({ ok: false, reason: "lifecycle-lane-busy", deferred: true });
      await Promise.resolve();
    },
  };
}

function assertEmptyIff(input: {
  readonly effectiveHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  readonly ensureUnavailableOrFailed: boolean;
}): void {
  const anyUsable = input.leases.some(isUsableForSelection);
  const isEmpty = input.effectiveHostId === null;
  const shouldBeEmpty = !anyUsable && input.ensureUnavailableOrFailed;
  expect(isEmpty).toBe(shouldBeEmpty);
  expect(shouldBeEmpty).toBe(isEmpty);
}

class ScriptedPreferredHostStore implements PreferredHostStore {
  private readonly byIdentity = new Map<string, string>();
  private failNextWrite = false;
  writeCount = 0;

  failNext(): void {
    this.failNextWrite = true;
  }

  load(identityKey: string | null): string | null {
    if (identityKey === null) return null;
    return this.byIdentity.get(identityKey) ?? null;
  }

  save(
    identityKey: string | null,
    hostId: string | null,
  ): PreferredHostSaveResult {
    this.writeCount += 1;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return { ok: false, reason: "disk-full" };
    }
    if (identityKey === null) return { ok: true };
    if (hostId === null) {
      this.byIdentity.delete(identityKey);
      return { ok: true };
    }
    this.byIdentity.set(identityKey, hostId);
    return { ok: true };
  }
}

describe("SelectionAuthorityEngineImpl - P1.3 failover scenarios", () => {
  it("A1: preferred remote dies → fallback immediately, no stability window", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      // L IS THE FALLBACK, so this machine's host has to be startable. With
      // the suite's unavailable port L reads `dead` once the engine's ensure
      // answers, and the assertion below would be measuring ∅ - a real and
      // correct outcome (registry §5), but a different scenario.
      localHostEnsure: readyLocalHostEnsurePort(),
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("P");

    killHostWithRefusals(engine, "A", incarnation, "P");
    clock.advance(0);
    expect(findLease(engine.snapshot().leases, "P")?.status).toBe("dead");
    expect(engine.snapshot().effectiveHostId).toBe("L");
    expect(lastSelectionChange(authority.events).cause).toBe("failover");

    authority.dispose();
  });

  it("A2: preferred returns → home only after the 20s stability window, cause recovery", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      // L is the fallback the window serves from until P earns its way back.
      localHostEnsure: readyLocalHostEnsurePort(),
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    engine.ingestEvidence(
      "A",
      incarnation,
      dialOutcome("P", "revive", "success", clock.now()),
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");

    clock.advance(RETURN_TO_TARGET_STABILITY_MS - 1);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    clock.advance(1);
    expect(engine.snapshot().effectiveHostId).toBe("P");
    expect(lastSelectionChange(authority.events).cause).toBe("recovery");

    authority.dispose();
  });

  it("A3: fallback restart while FailedOver → no third-host hop (M6)", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [
          fleetHost("L", "local"),
          fleetHost("P", "remote"),
          fleetHost("C", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
      // L is the fallback the failover lands on; C is the third host M6 must
      // keep the window from hopping to. Both need L to be startable, or the
      // failover would land on C in the first place and there would be no
      // second hop to forbid.
      localHostEnsure: readyLocalHostEnsurePort(),
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(engine.snapshot().effectiveHostId).toBe("L");
    expect(findLease(engine.snapshot().leases, "C")?.status).toBe("connecting");

    engine.ingestEvidence(
      "A",
      incarnation,
      restartIntent("L", "tomb-fallback", null, clock.now()),
    );
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // Advance past BOTH stability windows (failover-candidate and
    // return-to-target) while the restart episode (60s) is still open. Once
    // damping alone would admit a hop, the HOLD rule is the only thing that
    // can still keep the window on L instead of jumping to the third usable
    // host C.
    expect(
      Math.max(FAILOVER_CANDIDATE_STABILITY_MS, RETURN_TO_TARGET_STABILITY_MS) +
        5_000,
    ).toBeLessThan(RESTART_INTENT_EPISODE_MS);
    clock.advance(
      Math.max(FAILOVER_CANDIDATE_STABILITY_MS, RETURN_TO_TARGET_STABILITY_MS) +
        5_000,
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");

    const afterRestart = authority.events.filter(
      (event) => event.kind === "selection",
    );
    for (const event of afterRestart) {
      if (event.kind !== "selection") continue;
      expect(event.change.effectiveHostId).not.toBe("C");
    }
    expect(engine.snapshot().effectiveHostId).toBe("L");

    authority.dispose();
  });

  it("A4: Activate mid-FailedOver → immediately OnTarget, cause activate, damping bypassed", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [
          fleetHost("L", "local"),
          fleetHost("P", "remote"),
          fleetHost("C", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
      // L is the fallback the window is sitting on when the Activate lands -
      // the FailedOver phase this bypasses damping from.
      localHostEnsure: readyLocalHostEnsurePort(),
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    expect(await engine.activate("A", incarnation, "C")).toEqual({ ok: true });
    clock.advance(0);
    expect(engine.snapshot().preferredHostId).toBe("C");
    expect(engine.snapshot().targetHostId).toBe("C");
    expect(engine.snapshot().effectiveHostId).toBe("C");
    expect(lastSelectionChange(authority.events).cause).toBe("activate");

    authority.dispose();
  });

  it("A5: deregister preferred → preferred null, target local, cause deregister-clear", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });

    fleet.publish(0, "L", [fleetHost("L", "local")]);
    expect(engine.snapshot().preferredHostId).toBeNull();
    expect(engine.snapshot().targetHostId).toBe("L");
    expect(lastSelectionChange(authority.events).cause).toBe(
      "deregister-clear",
    );

    authority.dispose();
  });

  it("A6: a healthy remote preferred still ensures a DOWN local host (target-independent lifecycle), and stays on the remote while it boots", async () => {
    // Decision 2026-08-19: the local host's lifecycle does not depend on which
    // host a window is pointed at. This test used to pin the opposite ("does
    // not ensure local; killing the remote requests ensure once").
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
      seedPreferred: "P",
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(engine.snapshot().preferredHostId).toBe("P");
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // Cold boot: L is never-dialed, so the ensure fires at once - exactly as
    // it would with L preferred - and the window keeps serving P meanwhile.
    expect(ensure.calls.count).toBe(1);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // The converge answers: proof of life for L. Nothing moves - P is the
    // preferred host and it is serving.
    await ensure.resolve(true);
    expect(engine.snapshot().effectiveHostId).toBe("P");
    expect(ensure.calls.count).toBe(1);

    // L dies later (something pinned to it dialed it and was refused). The
    // engine brings it back although P is healthy and effective: down means
    // ensure, whichever host is the target.
    killHostWithRefusals(engine, "A", incarnation, "L");
    expect(ensure.calls.count).toBe(2);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // And when P dies too, L - already booting - is the fallback, with no
    // second request stacked on the one in flight.
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(ensure.calls.count).toBe(2);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    authority.dispose();
  });

  it("does not hold a return-to-target behind an incumbent that has itself died", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      // L is the fallback the return-to-target hold sits on; it has to be
      // startable, or the failover in step 2 lands on ∅ instead of L and
      // there is no incumbent for step 4 to kill.
      localHostEnsure: readyLocalHostEnsurePort(),
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    // 1. Activate P -> effective P, target P.
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // 2. Kill P -> failover to L. Target stays P (A2's shape): this is the
    // premise for a return-to-target hold to have anything to hold later.
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(engine.snapshot().targetHostId).toBe("P");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // 3. P proves alive -> the return-to-target window opens and the engine
    // keeps serving L. Premise that the hold is REAL: a few seconds into the
    // window, still L - without this check the arm under test could pass
    // vacuously because the hold never engaged in the first place.
    engine.ingestEvidence(
      "A",
      incarnation,
      dialOutcome("P", "revive", "success", clock.now()),
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");
    clock.advance(3_000);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // 4. Now L - the INCUMBENT the hold is protecting - dies too, the same
    // three-refusal recipe used against P in step 2. The engine's ensure fires
    // in that same pass (down means bring it back, whichever host is the
    // target), so the PUBLISHED lease is the in-flight arm's `connecting`,
    // not `dead` - L is being started, not written off.
    killHostWithRefusals(engine, "A", incarnation, "L");
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");

    // 5. The engine must not keep serving a host it has itself called dead
    // (and is now merely booting) for the remaining ~17s of the 20s window
    // (clock is at 3_000ms, well inside RETURN_TO_TARGET_STABILITY_MS). Under
    // the old code - the bypass arm asks only about the destination, never
    // the origin - this read L until t=20_000; and an incumbent held usable
    // only by the engine's own in-flight ensure is no more able to serve than
    // a dead one, so that hold does not keep the window either.
    expect(engine.snapshot().effectiveHostId).toBe("P");
    expect(lastSelectionChange(authority.events).cause).toBe("recovery");

    authority.dispose();
  });

  it("returns to a revived target at once when the incumbent is a local host held usable only by the engine's own in-flight ensure", async () => {
    // The consequence of the incumbent rule stated for the decided lifecycle:
    // a booting local host is a CANDIDATE (∅ never shows for it) but not
    // something to keep serving a window from once the target can. Before,
    // the return window would sit on it for up to 20s.
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    // The cold-boot ensure for the never-dialed L is in flight from attach.
    expect(ensure.calls.count).toBe(1);

    // 1. Activate P -> effective P.
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // 2. Kill P -> failover to L, whose only claim to usability is the ensure
    // still in flight (no dial, no session).
    killHostWithRefusals(engine, "A", incarnation, "P");
    expect(engine.snapshot().effectiveHostId).toBe("L");
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");

    // 3. P proves alive. No 20s hold on a host that is not serving anyone:
    // the window goes home now.
    engine.ingestEvidence(
      "A",
      incarnation,
      dialOutcome("P", "revive", "success", clock.now()),
    );
    expect(engine.snapshot().effectiveHostId).toBe("P");
    expect(lastSelectionChange(authority.events).cause).toBe("recovery");

    // 4. And a live session on L is what WOULD have kept the window - the
    // in-flight arm reads `ready` for it, which is service. Prove the guard
    // is about service, not about the token: with a session, the same revive
    // is damped for the full window.
    //
    // The first authority is disposed HERE, not at the end: the control below
    // shares this `clock`, so an engine left armed would also take timer
    // callbacks from the `advance` that drives the control's return window.
    // Nothing above is asserted again, so those callbacks could not change a
    // verdict - but a second engine reacting to the first one's deadlines is
    // not a fixture anyone should have to reason about.
    authority.dispose();
    const authority2 = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: createDeferredEnsure().port,
    });
    const incarnation2 = attachReporter(authority2.engine, "A");
    expect(await authority2.engine.activate("A", incarnation2, "P")).toEqual({
      ok: true,
    });
    killHostWithRefusals(authority2.engine, "A", incarnation2, "P");
    expect(authority2.engine.snapshot().effectiveHostId).toBe("L");
    authority2.engine.ingestEvidence(
      "A",
      incarnation2,
      sessionEvidence("L", "s-local", "established", clock.now()),
    );
    expect(findLease(authority2.engine.snapshot().leases, "L")?.status).toBe(
      "ready",
    );
    authority2.engine.ingestEvidence(
      "A",
      incarnation2,
      dialOutcome("P", "revive", "success", clock.now()),
    );
    expect(authority2.engine.snapshot().effectiveHostId).toBe("L");
    clock.advance(RETURN_TO_TARGET_STABILITY_MS);
    expect(authority2.engine.snapshot().effectiveHostId).toBe("P");

    authority2.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - P1.3 empty-set unification", () => {
  it("no local host + all remotes dead → ∅ (ensure unavailable)", () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("R1", "remote"), fleetHost("R2", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "R1");
    killHostWithRefusals(authority.engine, "A", incarnation, "R2");

    const snapshot = authority.engine.snapshot();
    expect(snapshot.effectiveHostId).toBeNull();
    expect(ensure.calls.count).toBe(0);
    assertEmptyIff({
      effectiveHostId: snapshot.effectiveHostId,
      leases: snapshot.leases,
      ensureUnavailableOrFailed: true,
    });

    authority.dispose();
  });

  it("local dead + ensure in flight → NOT ∅ (local lease is connecting)", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "L");

    expect(ensure.calls.count).toBe(1);
    const snapshot = authority.engine.snapshot();
    expect(findLease(snapshot.leases, "L")?.status).toBe("connecting");
    expect(snapshot.effectiveHostId).toBe("L");
    assertEmptyIff({
      effectiveHostId: snapshot.effectiveHostId,
      leases: snapshot.leases,
      ensureUnavailableOrFailed: false,
    });

    authority.dispose();
  });

  it("local dead + ensure failed inside cooldown + remotes dead → ∅", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("R", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "R");
    killHostWithRefusals(authority.engine, "A", incarnation, "L");
    await ensure.resolve(false);

    const snapshot = authority.engine.snapshot();
    expect(findLease(snapshot.leases, "L")?.status).toBe("dead");
    expect(snapshot.effectiveHostId).toBeNull();
    assertEmptyIff({
      effectiveHostId: snapshot.effectiveHostId,
      leases: snapshot.leases,
      ensureUnavailableOrFailed: true,
    });

    authority.dispose();
  });

  it("after ensure cooldown lapses, ensure is retried", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "L");
    await ensure.resolve(false);
    expect(ensure.calls.count).toBe(1);
    expect(authority.engine.snapshot().effectiveHostId).toBeNull();

    clock.advance(LOCAL_ENSURE_RETRY_COOLDOWN_MS);
    expect(ensure.calls.count).toBe(2);

    authority.dispose();
  });

  it("ensure succeeds → local becomes usable and is adopted", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const incarnation = attachReporter(authority.engine, "A");
    killHostWithRefusals(authority.engine, "A", incarnation, "L");
    expect(ensure.calls.count).toBe(1);
    await ensure.resolve(true);

    // Pin the streak-clear as the ONLY explanation for usability: without
    // it, `stage()` would see local still `dead` after the commit and
    // re-request ensure, making the lease read `connecting` (also usable)
    // via a second in-flight call rather than via a proven-alive local.
    // A re-request here would defeat this assertion, not merely add noise.
    expect(ensure.calls.count).toBe(1);

    const snapshot = authority.engine.snapshot();
    const local = findLease(snapshot.leases, "L");
    if (local === undefined) throw new Error("expected local lease");
    expect(isUsableForSelection(local)).toBe(true);
    expect(snapshot.effectiveHostId).toBe("L");
    assertEmptyIff({
      effectiveHostId: snapshot.effectiveHostId,
      leases: snapshot.leases,
      ensureUnavailableOrFailed: false,
    });

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - P1.3 same-effective Activate (C1 engine)", () => {
  it("Activate a third dead host while FailedOver emits selectionChanged with unchanged effective", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [
          fleetHost("A", "remote"),
          fleetHost("B", "remote"),
          fleetHost("C", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine, events } = authority;
    const incarnation = attachReporter(engine, "W");
    expect(await engine.activate("W", incarnation, "A")).toEqual({ ok: true });
    killHostWithRefusals(engine, "W", incarnation, "C");
    killHostWithRefusals(engine, "W", incarnation, "A");
    expect(engine.snapshot().effectiveHostId).toBe("B");
    expect(engine.snapshot().targetHostId).toBe("A");

    const previousEffective = engine.snapshot().effectiveHostId;
    const before = events.filter((event) => event.kind === "selection").length;
    expect(await engine.activate("W", incarnation, "C")).toEqual({ ok: true });
    const after = events.filter((event) => event.kind === "selection");
    expect(after.length).toBe(before + 1);
    const change = lastSelectionChange(after);
    expect(change.preferredHostId).toBe("C");
    expect(change.targetHostId).toBe("C");
    expect(change.effectiveHostId).toBe(previousEffective);
    expect(change.previousEffectiveHostId).toBe(previousEffective);
    expect(change.cause).toBe("activate");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - P1.3 persist-failed activate (E1/E2 engine)", () => {
  it("E1: failed write → persist-failed, nothing committed or emitted", async () => {
    const clock = createFakeAuthorityClock(0);
    const store = new ScriptedPreferredHostStore();
    store.failNext();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      preferredStore: store,
    });
    const incarnation = attachReporter(authority.engine, "A");
    const before = authority.events.filter(
      (event) => event.kind === "selection",
    ).length;

    expect(await authority.engine.activate("A", incarnation, "H")).toEqual({
      ok: false,
      reason: "persist-failed",
    });
    expect(authority.engine.snapshot().preferredHostId).toBeNull();
    expect(store.load("acct-1")).toBeNull();
    expect(
      authority.events.filter((event) => event.kind === "selection").length,
    ).toBe(before);

    authority.dispose();
  });

  it("E2: failed write then retry with a succeeding write is durable", async () => {
    const clock = createFakeAuthorityClock(0);
    const store = new ScriptedPreferredHostStore();
    store.failNext();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      preferredStore: store,
    });
    const incarnation = attachReporter(authority.engine, "A");
    expect(await authority.engine.activate("A", incarnation, "H")).toEqual({
      ok: false,
      reason: "persist-failed",
    });
    expect(authority.engine.snapshot().preferredHostId).toBeNull();

    expect(await authority.engine.activate("A", incarnation, "H")).toEqual({
      ok: true,
    });
    expect(authority.engine.snapshot().preferredHostId).toBe("H");
    expect(store.load("acct-1")).toBe("H");
    expect(lastSelectionChange(authority.events).cause).toBe("activate");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - P1.3 F14 clear on identity adopt (H)", () => {
  function buildTransitionPorts(input: {
    readonly bPreference: string;
    readonly bFleet: {
      readonly localHostId: string | null;
      readonly hosts: readonly { hostId: string; kind: "local" | "remote" }[];
    };
  }): {
    engine: SelectionAuthorityEngineImpl;
    events: readonly RecordedEngineEvent[];
    transition: () => void;
  } {
    const store = new InMemoryPreferredHostStore();
    store.save("acct-B", input.bPreference);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: "L-A",
      hosts: [fleetHost("L-A", "local")],
    });
    let identityState = { identityKey: "acct-A", generation: 0 };
    const identityListeners = new Set<
      (identity: { identityKey: string | null; generation: number }) => void
    >();
    const identity: AuthorityIdentitySource = {
      current: () => identityState,
      onChanged: (listener) => {
        identityListeners.add(listener);
        return { dispose: () => identityListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      clock: createFakeAuthorityClock(0),
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: store,
      log: silentAuthorityLog,
    });
    const { events } = recordEngineEvents(engine);
    fleet.publish(1, input.bFleet.localHostId, input.bFleet.hosts);
    return {
      engine,
      events,
      transition: () => {
        identityState = { identityKey: "acct-B", generation: 1 };
        for (const listener of Array.from(identityListeners)) {
          listener(identityState);
        }
      },
    };
  }

  it("H1: already-available B fleet that omits B's persisted preference clears it as deregister-clear", () => {
    const ports = buildTransitionPorts({
      bPreference: "GONE",
      bFleet: {
        localHostId: "L-B",
        hosts: [fleetHost("L-B", "local"), fleetHost("OTHER", "remote")],
      },
    });
    ports.transition();
    expect(ports.engine.snapshot().preferredHostId).toBeNull();
    expect(ports.engine.snapshot().targetHostId).toBe("L-B");
    expect(lastSelectionChange(ports.events).cause).toBe("deregister-clear");
    ports.engine.dispose();
  });

  it("H2: already-available B fleet that still holds B's preference keeps it, cause fleet-shift", () => {
    const ports = buildTransitionPorts({
      bPreference: "L-B",
      bFleet: {
        localHostId: "L-B",
        hosts: [fleetHost("L-B", "local"), fleetHost("OTHER", "remote")],
      },
    });
    ports.transition();
    expect(ports.engine.snapshot().preferredHostId).toBe("L-B");
    expect(ports.engine.snapshot().targetHostId).toBe("L-B");
    expect(lastSelectionChange(ports.events).cause).toBe("fleet-shift");
    ports.engine.dispose();
  });

  it("H3: an empty already-available fleet never clears the persisted preference", () => {
    const ports = buildTransitionPorts({
      bPreference: "GONE",
      bFleet: { localHostId: null, hosts: [] },
    });
    ports.transition();
    expect(ports.engine.snapshot().preferredHostId).toBe("GONE");
    expect(lastSelectionChange(ports.events).cause).not.toBe(
      "deregister-clear",
    );
    ports.engine.dispose();
  });
});

// --------------------------------------------- P3.2: D13 at the derivation
// (host-lifecycle redesign, ticket P3.2 acceptance).
//
// The production guard is `isUsableForSelection`, which excludes every `dead`
// reason and therefore excluded `incompatible` from the day the arm landed.
// What did NOT exist was a scenario exercising it: the predicate had a unit
// test and Activate had a refusal test, but no FAILOVER ever ran with an
// incompatible host in the candidate set. These are that scenario - a green
// run here is not evidence of new production behavior, it is evidence the
// behavior was never asked.
describe("SelectionAuthorityEngineImpl - P3.2 D13: incompatible is never a candidate", () => {
  it("failover skips an incompatible remote and takes the healthy host BEHIND it in fleet order", async () => {
    // No local host, so the choice is made purely among remotes by the third
    // derivation arm - MRU first, then fleet order. X is seeded BEFORE Y, so an
    // engine that forgot D13 would take X: the assertion discriminates rather
    // than merely agreeing with the current implementation.
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [
          fleetHost("P", "remote"),
          fleetHost("X", "remote"),
          fleetHost("Y", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("X", null, INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "X")?.dead?.reason).toBe(
      "incompatible",
    );

    killHostWithRefusals(engine, "A", incarnation, "P");
    clock.advance(0);

    expect(engine.snapshot().effectiveHostId).toBe("Y");
    expect(lastSelectionChange(authority.events).cause).toBe("failover");

    authority.dispose();
  });

  it("a PREFERRED host that goes incompatible after an app update falls over, with the switch cause the toast reads", async () => {
    // C4 hole 2, arm one. The app updates, the running host is suddenly a
    // version behind, and its verdict arrives while it is the preferred and
    // effective host. Derivation must move - and the move is what the surface
    // chip and the one-line "Switched to X" toast narrate (D11), which is why
    // the cause is asserted and not just the destination.
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("P", "remote"), fleetHost("Y", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("P");

    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("P", null, INCOMPAT_DETAIL),
    );
    clock.advance(0);

    expect(findLease(engine.snapshot().leases, "P")?.dead?.reason).toBe(
      "incompatible",
    );
    expect(engine.snapshot().effectiveHostId).toBe("Y");
    expect(lastSelectionChange(authority.events).cause).toBe("failover");

    authority.dispose();
  });

  it("with no candidates behind it, the same host reaches ∅ carrying the detail the update-host modal names it by", async () => {
    // C4 hole 2, arm two - and the exact tuple the window narrator consumes.
    // `deriveNoHostVariant(leases, targetHostId)` names the TARGET first, so
    // ∅ alone is not enough: the target must still be P, and P's lease must
    // still carry the structured incompatibility, or the modal falls through
    // to the generic offline variant and the user is told to wait for a host
    // that is never coming back on its own.
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });

    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("P", null, INCOMPAT_DETAIL),
    );
    clock.advance(0);

    const snapshot = engine.snapshot();
    expect(snapshot.effectiveHostId).toBeNull();
    expect(snapshot.targetHostId).toBe("P");
    const lease = findLease(snapshot.leases, "P");
    expect(lease?.dead?.reason).toBe("incompatible");
    expect(
      lease?.dead?.reason === "incompatible" ? lease.dead.detail : null,
    ).toEqual(INCOMPAT_DETAIL);

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - local proof-of-life clears the ensure cooldown (P5.2)", () => {
  it("T1/P1: a dial success for the local host during cooldown clears the dead(offline) lease", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    killHostWithRefusals(engine, "A", incarnation, "L");
    await ensure.resolve(false);
    const before = findLease(engine.snapshot().leases, "L");
    expect(before?.status).toBe("dead");
    expect(before?.dead?.reason).toBe("offline");

    engine.ingestEvidence(
      "A",
      incarnation,
      dialOutcome("L", "recover-1", "success", 1),
    );

    const after = findLease(engine.snapshot().leases, "L");
    expect(after?.status).not.toBe("dead");

    authority.dispose();
  });

  it("T2/P2: an ensure failure that lands AFTER a local proof of life does not re-arm the cooldown", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    killHostWithRefusals(engine, "A", incarnation, "L");
    expect(ensure.calls.count).toBe(1);

    // Proof of life lands while the ensure request is still in flight.
    engine.ingestEvidence(
      "A",
      incarnation,
      dialOutcome("L", "recover-1", "success", 1),
    );

    // The ensure completes afterwards with a failure that post-dates the proof.
    await ensure.resolve(false);

    const after = findLease(engine.snapshot().leases, "L");
    expect(after?.status).not.toBe("dead");

    authority.dispose();
  });

  it("T3a/P3: a remote proof of life does not clear the local host's cooldown", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("R", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    killHostWithRefusals(engine, "A", incarnation, "L");
    await ensure.resolve(false);
    expect(findLease(engine.snapshot().leases, "L")?.dead?.reason).toBe(
      "offline",
    );

    engine.ingestEvidence(
      "A",
      incarnation,
      dialOutcome("R", "r-proof-1", "success", 1),
    );

    const after = findLease(engine.snapshot().leases, "L");
    expect(after?.status).toBe("dead");
    expect(after?.dead?.reason).toBe("offline");

    authority.dispose();
  });

  it("T3b/P3: a proof of life on a fleet with no local host does not crash and clears nothing local-specific", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("R", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    expect(() => {
      engine.ingestEvidence(
        "A",
        incarnation,
        dialOutcome("R", "r-1", "success", 1),
      );
    }).not.toThrow();

    const after = findLease(engine.snapshot().leases, "R");
    expect(after?.status).toBe("connecting");
    expect(after?.dead).toBeNull();

    authority.dispose();
  });

  it("T4/addendum: a cooldown cleared by a live session does not resurface once that session is lost", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    killHostWithRefusals(engine, "A", incarnation, "L");
    await ensure.resolve(false);
    expect(findLease(engine.snapshot().leases, "L")?.dead?.reason).toBe(
      "offline",
    );

    // A session establishes for the local host - stronger evidence than a
    // dial, and it clears the cooldown the same as T1. While it lives the
    // live-session arm pins the lease `ready` regardless of the cooldown, so
    // this window alone proves nothing about whether the cooldown was
    // actually cleared.
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("L", "s1", "established", 1),
    );
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("ready");

    // The discriminator: once the session goes away, the cooldown must not
    // resurface. If the clear had not happened, losing the session would fall
    // straight through to the still-armed dead(offline) lease.
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("L", "s1", "lost", 1),
    );
    const after = findLease(engine.snapshot().leases, "L");
    expect(after?.status).not.toBe("dead");

    authority.dispose();
  });

  it("T4/addendum: an attach-inventory announcement for the local host also clears the cooldown", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;
    const incarnationA = attachReporter(engine, "A");
    killHostWithRefusals(engine, "A", incarnationA, "L");
    await ensure.resolve(false);
    expect(findLease(engine.snapshot().leases, "L")?.dead?.reason).toBe(
      "offline",
    );

    // A second reporter attaches with the local host already live in its
    // inventory - `installInventory` runs the same proof-of-life path for it.
    const seqB = engine.allocateAttachSeq("B");
    const attachB = engine.attach(
      "B",
      attachRequest(seqB, [liveSession("L", "s-inv")]),
    );
    if (!attachB.ok) throw new Error("expected attach B to succeed");

    const after = findLease(engine.snapshot().leases, "L");
    expect(after?.status).not.toBe("dead");

    authority.dispose();
  });
});

// ------------------------------------------------------- :1799 owed pins
// `completeLocalEnsure` used to match a completion to its request by object
// identity alone. Re-enrolment / a PID-metadata change can republish the
// fleet at the SAME `identityGeneration` with a different `localHostId`
// (A -> B); the token's generation still matches, so neither the identity
// fence nor the object-identity check sees the swap, and A's in-flight
// completion lands into a fleet whose local host is B. The fix compares
// `token.hostId` to the CURRENT `this.fleet.localHostId` and discards a
// mismatch - clearing the token too, which is a second, separately
// assertable defect: while it stood, `requestLocalEnsureIfDown` refused to
// start anything, so B could not ask for its own ensure until A's ceiling
// lapsed.

describe("SelectionAuthorityEngineImpl - completeLocalEnsure fences on the local host across a swap (:1799 fix)", () => {
  it("R1a: a successful ensure for A credits A after the local host became B", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "A",
        hosts: [fleetHost("A", "local"), fleetHost("R", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "rep");

    killHostWithRefusals(engine, "rep", incarnation, "R");
    killHostWithRefusals(engine, "rep", incarnation, "A");
    expect(ensure.calls.count).toBe(1);

    // PREMISE, asserted positively before the harm: the local host really is
    // A right now, and A's lease reads `connecting` only because the
    // engine's own ensure is in flight (D14) - never because anything
    // observed A alive.
    expect(engine.snapshot().targetHostId).toBe("A");
    expect(findLease(engine.snapshot().leases, "A")?.status).toBe("connecting");

    // Re-enrolment: same identity generation, local host becomes B, A's
    // registry row survives as a remote.
    fleet.publish(0, "B", [
      fleetHost("B", "local"),
      fleetHost("A", "remote"),
      fleetHost("R", "remote"),
    ]);
    expect(engine.snapshot().targetHostId).toBe("B");
    // A is now a REMOTE with its refusal streak intact, so it derives `dead`.
    // This is the state the stale completion must not be able to undo.
    expect(findLease(engine.snapshot().leases, "A")?.status).toBe("dead");

    await ensure.resolve(true);

    // THE HARM the fence closes: A was credited with proof of life by a
    // request that was about A but completed into a fleet whose local host
    // is B.
    const aLease = findLease(engine.snapshot().leases, "A");
    if (aLease === undefined) throw new Error("expected a lease for A");
    expect(aLease.status).toBe("dead");
    expect(isUsableForSelection(aLease)).toBe(false);
    expect(ensure.calls.count).toBe(2);

    authority.dispose();
  });

  it("R1b/R1c: a failed ensure for A arms the cooldown against B, and B cannot ask for its own", async () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "A",
        hosts: [fleetHost("A", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "rep");
    killHostWithRefusals(engine, "rep", incarnation, "A");
    expect(ensure.calls.count).toBe(1);

    fleet.publish(0, "B", [fleetHost("B", "local"), fleetHost("A", "remote")]);
    expect(engine.snapshot().targetHostId).toBe("B");

    await ensure.resolve(false);

    // B is local and never dialed: it WANTS an ensure. A second call means B
    // got to ask for itself; one call would mean A's failure armed the
    // cooldown over it instead - and clearing the token is what lets B ask at
    // all rather than waiting out A's ceiling.
    expect(ensure.calls.count).toBe(2);
    expect(findLease(engine.snapshot().leases, "B")?.status).toBe("connecting");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - compat eligibility (B3)", () => {
  /**
   * B3's eligibility half, which `ade7fe0f` did not touch. That mitigation
   * fixed FRESHNESS - a stale `compatible` suppressing a fresh `incompatible`.
   * This is the other half: `isUsableForSelection` answers on lease status
   * alone, and a host whose compatibility has NEVER been established derives
   * as `connecting`, which is usable. So candidate enumeration takes the first
   * usable host in MRU-then-fleet order and cannot tell "proved compatible"
   * from "never asked".
   *
   * The harm is not that an unknown host may be tried - it must be, or nothing
   * is selectable on a cold start where no verdict exists yet. It is that an
   * unknown host is taken **over a host already proved compatible**, which is
   * D13's "never a candidate" in the sense that bites: failing over onto an
   * unproven machine while a proven one sits in the same fleet.
   */
  it("prefers a host proved compatible over one never probed, when failing over", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        // Fleet order is by hostId, so the UNPROBED host is offered first -
        // which is what makes this about ranking rather than luck.
        localHostId: "L",
        hosts: [
          fleetHost("L", "local"),
          fleetHost("A-unprobed", "remote"),
          fleetHost("B-compatible", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
      // The local host cannot be provisioned back to life, so the engine has
      // to reach for a remote and keep it.
      localHostEnsure: unavailableLocalHostEnsurePort,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      compatCompatible("B-compatible", null),
    );
    // The local host dies, so the engine must reach for a remote.
    killHostWithRefusals(engine, "A", incarnation, "L");
    // The engine's own provisioning request outranks the death arm while it is
    // in flight, so let the failed ensure settle before reading the verdict.
    await Promise.resolve();
    await Promise.resolve();
    // A candidate must be continuously usable for the damping window before
    // the engine will move onto it.
    clock.advance(FAILOVER_CANDIDATE_STABILITY_MS + 1);

    expect(engine.snapshot().effectiveHostId).toBe("B-compatible");

    authority.dispose();
  });

  /**
   * The don't-over-fix guard, and the reason this is a RANK and not a gate.
   *
   * A compat verdict is produced BY connecting, so on a cold start no host has
   * one. Making unknown ineligible - the obvious reading of "never a
   * candidate" - would make every host ineligible and ∅ universal. When
   * nothing is proved, every host is equally unknown and the previous order
   * must survive untouched.
   */
  it("still selects an unprobed host when NO host has been proved compatible", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [
          fleetHost("L", "local"),
          fleetHost("A-unprobed", "remote"),
          fleetHost("B-also-unprobed", "remote"),
        ],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: unavailableLocalHostEnsurePort,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    killHostWithRefusals(engine, "A", incarnation, "L");
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(FAILOVER_CANDIDATE_STABILITY_MS + 1);

    // Fleet order, exactly as before the rank existed.
    expect(engine.snapshot().effectiveHostId).toBe("A-unprobed");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - a dead host reaches `dead` (B1/C6)", () => {
  /**
   * B1's corpse path. The measured half was "48 s, zero updates"; the
   * *unboundedness* was PLAUSIBLE - derived from the absent producer, never
   * observed to a bound. This observes it.
   *
   * A host that stops answering loses its session, and then nothing dials it
   * again, because nothing is trying to use a host the app already believes
   * it is connected to. `refusalStreak` therefore never advances, the death
   * predicate never fires, and the lease falls through to `connecting` -
   * which is usable. No failover, no empty state, no error.
   */
  it("a host whose session dies with no further dial evidence still leaves `connecting`", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: readyLocalHostEnsurePort(),
      seedPreferred: "P",
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    // The cold-boot ensure for L fires at attach whichever host is preferred
    // (target-independent lifecycle). Let the ready port answer it: this test
    // jumps the clock 30 minutes below, past the in-flight ceiling, and an
    // ensure that was never given its microtask would lapse into the failed
    // cooldown and read L dead at exactly the moment the fallback needs it.
    await Promise.resolve();
    await Promise.resolve();

    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "established", 0),
    );
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // The machine stops answering: the socket drops. Nothing dials it again.
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "lost", 0),
    );
    const held = findLease(engine.snapshot().leases, "P");
    if (held === undefined) throw new Error("expected a lease for P");
    expect(held.status).toBe("connecting");
    expect(isUsableForSelection(held)).toBe(true);

    clock.advance(30 * 60_000);

    const after = findLease(engine.snapshot().leases, "P");
    if (after === undefined) throw new Error("expected a lease for P");
    expect(isUsableForSelection(after)).toBe(false);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    authority.dispose();
  });

  /**
   * The false-death guard, and the reason the ceiling is scoped to the
   * effective host at all.
   *
   * An idle host nobody is talking to produces no evidence EITHER, so a
   * ceiling armed on every session loss would call it dead from silence -
   * manufacturing the false-Offline verdict C4 exists to prevent, from a
   * second direction. `connecting` ("no evidence yet", neither usable-by-proof
   * nor dead) is the honest answer for a host the app is not pointed at.
   */
  it("does not call a host the app is NOT pointed at dead just because its session ended", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: readyLocalHostEnsurePort(),
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    // L is effective (no preference seeded); P is a bystander the user once
    // had open and has since navigated away from.
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "established", 0),
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "lost", 0),
    );

    clock.advance(30 * 60_000);

    const after = findLease(engine.snapshot().leases, "P");
    if (after === undefined) throw new Error("expected a lease for P");
    expect(after.status).toBe("connecting");
    expect(after.dead).toBeNull();

    authority.dispose();
  });

  /**
   * The arm-time half of that guard, which the bystander case above does NOT
   * prove: removing the effectiveness check at ARM time leaves this suite
   * green, because the derive-time check still catches the bystander.
   *
   * What it does not catch is a STALE ceiling. Arm on every session loss and
   * a host that lost its session long ago carries an already-expired deadline
   * into the moment it is selected - so it would be declared dead on arrival,
   * before anything had the chance to dial it even once. Both checks are
   * load-bearing, for different cases, and the mutation that survives the
   * other test reddens here.
   */
  it("does not kill a host on arrival because its session ended long before it was selected", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: readyLocalHostEnsurePort(),
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "established", 0),
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "lost", 0),
    );

    // Long past the ceiling, with P still a bystander.
    clock.advance(30 * 60_000);

    // The user now picks P in Settings. It has not been dialed yet, so the
    // only honest verdict is `connecting` - nothing has asked it anything.
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("P");

    const onArrival = findLease(engine.snapshot().leases, "P");
    if (onArrival === undefined) throw new Error("expected a lease for P");
    expect(onArrival.status).toBe("connecting");
    expect(isUsableForSelection(onArrival)).toBe(true);

    authority.dispose();
  });

  /**
   * The derive-time half, which neither arm above proves: with the arm-time
   * check in place, a ceiling can still be armed and then OUTLIVE the app's
   * interest in that host, when something moves the selection off it before
   * the ceiling lapses.
   *
   * Once the app is no longer pointed at it, the ceiling stops being a
   * statement anyone needs and "dead" goes back to being a claim about a host
   * nothing has asked anything - which is the bystander objection again,
   * reached from the other direction.
   */
  it("stops applying the ceiling once the app has moved off that host", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: readyLocalHostEnsurePort(),
      seedPreferred: "P",
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "established", 0),
    );
    expect(engine.snapshot().effectiveHostId).toBe("P");
    // Armed: the app IS pointed at P when its last session ends.
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "lost", 0),
    );

    // The user moves to L before the ceiling lapses.
    expect(await engine.activate("A", incarnation, "L")).toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("L");

    clock.advance(30 * 60_000);

    const after = findLease(engine.snapshot().leases, "P");
    if (after === undefined) throw new Error("expected a lease for P");
    expect(after.status).toBe("connecting");
    expect(after.dead).toBeNull();

    authority.dispose();
  });

  /**
   * The RESELECTION half (Codex #1243): the derive-time check above stops a
   * lapsed ceiling from killing P while the app is elsewhere - but P is then
   * carrying an already-expired deadline. Select P AGAIN and the arm reads
   * `connecting` in the pass that selects it (effective is still L while the
   * leases derive), `nextDeadline` never wakes the engine for an instant in
   * the past, and no report is coming: nothing dials a host the app believes
   * it is connected to. Without a restart the app sits on P forever - the
   * unbounded exit the ceiling exists to close, reached one selection later.
   */
  it("bounds a host that is selected AGAIN after its ceiling lapsed elsewhere - a fresh window, then dead", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("P", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: readyLocalHostEnsurePort(),
      seedPreferred: "P",
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "established", 0),
    );
    expect(engine.snapshot().effectiveHostId).toBe("P");
    // Armed: pointed at P when its last session ends.
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("P", "s1", "lost", 0),
    );
    // Moved off P before the ceiling lapses; then the ceiling lapses unseen.
    expect(await engine.activate("A", incarnation, "L")).toEqual({ ok: true });
    clock.advance(30 * 60_000);

    // Selected AGAIN. Not dead on arrival (nothing has dialed it) - and not
    // usable forever either.
    expect(await engine.activate("A", incarnation, "P")).toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("P");
    const onArrival = findLease(engine.snapshot().leases, "P");
    if (onArrival === undefined) throw new Error("expected a lease for P");
    expect(onArrival.status).toBe("connecting");

    // Inside the fresh window: still the honest non-committal answer.
    clock.advance(EFFECTIVE_HOST_POST_SESSION_CEILING_MS - 1);
    expect(findLease(engine.snapshot().leases, "P")?.status).toBe("connecting");
    expect(engine.snapshot().effectiveHostId).toBe("P");

    // The window lapses with no dial and no session: the authority's own exit.
    clock.advance(1);
    const after = findLease(engine.snapshot().leases, "P");
    if (after === undefined) throw new Error("expected a lease for P");
    expect(isUsableForSelection(after)).toBe(false);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - an in-flight ensure is bounded (B2)", () => {
  /**
   * B2 was filed PLAUSIBLE - derived end to end, never executed. This is the
   * execution.
   *
   * `nextDeadline()` has an arm for the cooldown after a FAILED ensure and no
   * arm for an ensure still running, and the in-flight arm of `deriveHostStatus`
   * reports `connecting`, which is usable. So a `convergeReady()` that never
   * settles holds the local lease selectable with no bound at all, and the
   * empty state the user needs in order to act is unreachable.
   *
   * The advance below is 30 minutes - twice `LOCAL_EXPECTED_OUTAGE_CEILING_MS`
   * - deliberately. A small advance would leave "the ceiling is too short" as
   * an explanation; this size can only be read as unbounded.
   */
  it("an ensure that never settles stops holding the local lease usable", () => {
    const clock = createFakeAuthorityClock(0);
    const ensure = createDeferredEnsure();
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local")],
      },
      initialIdentityKey: "acct-1",
      clock,
      localHostEnsure: ensure.port,
    });
    const { engine } = authority;

    // Derivation wants the local host and it has never been dialed, so the
    // engine's one sanctioned process action fires and stays outstanding.
    expect(ensure.calls.count).toBe(1);
    const held = findLease(engine.snapshot().leases, "L");
    if (held === undefined) throw new Error("expected a lease for L");
    expect(held.status).toBe("connecting");
    expect(isUsableForSelection(held)).toBe(true);

    // Nothing will ever settle this ensure: the provisioning controller hung.
    clock.advance(30 * 60_000);

    const after = findLease(engine.snapshot().leases, "L");
    if (after === undefined) throw new Error("expected a lease for L");
    expect(isUsableForSelection(after)).toBe(false);
    expect(engine.snapshot().effectiveHostId).toBeNull();

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - compat anchor must displace, not merely differ (P5.2 T5/P7)", () => {
  it("T5a/P7: a fresh incompatible verdict anchored to a later session displaces a held compatible verdict", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("H", "s1", "established", 0),
    );
    engine.ingestEvidence("A", incarnation, compatCompatible("H", "s1"));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("H", "s2", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("H", "s2", INCOMPAT_DETAIL),
    );

    const after = findLease(engine.snapshot().leases, "H");
    expect(after?.status).toBe("dead");
    expect(after?.dead?.reason).toBe("incompatible");

    authority.dispose();
  });

  // INVERTED, and the inversion is the record of a D13 defect this test used
  // to pin as correct.
  //
  // It was written as the CONTRAST for T5a: proof that an unanchored verdict
  // loses to an anchored one, offered as the reason the failure arm of the
  // GUI producer had to carry an anchor at all. The reasoning was sound and
  // the conclusion was backwards, because the case it describes is not
  // hypothetical - it is the ONE case that matters. A handshake rejected as
  // INCOMPATIBLE fails before the transport ready boundary, so it never
  // announces a session and its verdict is NECESSARILY unanchored; the
  // preceding `compatible` verdict, produced while the now-dead session was
  // live, is anchored. Ranking absence beneath an ordinal therefore dropped
  // every real incompatibility behind a stale compatible one, and no retry
  // could clear it because the rejection reproduces identically forever.
  //
  // The engine now orders two verdicts only when BOTH name a session. An
  // unanchored verdict lands, latest-received. See `ingestCompat`.
  it("T5b/P7: an incompatible verdict with no session anchor LANDS against a held session-anchored compatible", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("H", "s1", "established", 0),
    );
    engine.ingestEvidence("A", incarnation, compatCompatible("H", "s1"));
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    // The rejected handshake: no session to name, so the anchor is null.
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("H", null, INCOMPAT_DETAIL),
    );

    const after = findLease(engine.snapshot().leases, "H");
    if (after === undefined) throw new Error("expected a lease for H");
    expect(after.status).toBe("dead");
    expect(after.dead?.reason).toBe("incompatible");
    expect(isUsableForSelection(after)).toBe(false);

    authority.dispose();
  });

  // RECOVERY. The mirror of T5b, and the case that decides whether holding an
  // unanchored verdict to the safe side is a rule or a trap: once an
  // unanchored `incompatible` is the incumbent, the host is updated,
  // reconnects, establishes a session, and answers the probe. That verdict IS
  // anchored. If it cannot displace an incumbent that names no session, the
  // host is dead("incompatible") forever and no amount of fixing it helps.
  it("T5d: an ANCHORED compatible verdict recovers a host held incompatible by an unanchored one", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    // The rejected handshake names no session.
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("H", null, INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.dead?.reason).toBe(
      "incompatible",
    );

    // The host is updated and comes back: a real session, a real anchor.
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("H", "s9", "established", 0),
    );
    engine.ingestEvidence("A", incarnation, compatCompatible("H", "s9"));

    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });

  it("T5c: an unanchored verdict does not disturb the anchored-vs-anchored ordering it sits beside", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("H", "s1", "established", 0),
    );
    engine.ingestEvidence(
      "A",
      incarnation,
      sessionEvidence("H", "s2", "established", 1),
    );

    // s2 is the later observation, so its verdict supersedes s1's...
    engine.ingestEvidence("A", incarnation, compatCompatible("H", "s2"));
    // ...and an s1-anchored incompatible arriving late must still LOSE, which
    // is the supersession rule the null-handling above must not have weakened.
    engine.ingestEvidence(
      "A",
      incarnation,
      compatIncompatible("H", "s1", INCOMPAT_DETAIL),
    );
    expect(findLease(engine.snapshot().leases, "H")?.status).not.toBe("dead");

    authority.dispose();
  });
});

/**
 * The dial-evidence path's instrumentation.
 *
 * These exist because "a pinned host stopped answering and its lease never
 * reached `dead`" was not diagnosable from a production log. Six of
 * `ingestDial`'s seven exits were indistinguishable from outside - two logged
 * at `debug` (which the renderer drops in production, where the level defaults
 * to `info`) and four logged nothing - so a refusal that was dropped,
 * deduplicated or classified inert left exactly the same trace as a dial that
 * never happened. Those two have opposite fixes, so the instrument's whole job
 * is telling them apart.
 *
 * Every disposition gets its own arm deliberately: an instrument asserted only
 * on its happy path is the one that reports "nothing found" when the truth is
 * "nothing ran".
 */
describe("selection authority dial-evidence instrumentation", () => {
  function dialLogs(records: ReadonlyArray<RecordedAuthorityLog>) {
    return records.filter(
      (record) => record.message === "[selection-authority] dial evidence",
    );
  }

  function stallWarnings(records: ReadonlyArray<RecordedAuthorityLog>) {
    return records.filter((record) => record.level === "warn");
  }

  function attachedAuthority(log: RecordingAuthorityLog) {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [fleetHost("H", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      log,
    });
    const seq = authority.engine.allocateAttachSeq("A");
    const attach = authority.engine.attach("A", attachRequest(seq, []));
    if (!attach.ok) throw new Error("expected attach to succeed");
    return { authority, incarnationId: attach.incarnationId };
  }

  it("reports a disposition for EVERY dial exit, including the silent ones", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    // 1. counted
    engine.ingestEvidence("A", incarnationId, dialRefusal("H", "a1", null, 0));
    // 2. dropped-duplicate-attempt (same attempt id)
    engine.ingestEvidence("A", incarnationId, dialRefusal("H", "a1", null, 1));
    // 3. inert-indeterminate
    engine.ingestEvidence(
      "A",
      incarnationId,
      dialOutcome("H", "a2", "indeterminate", 2),
    );
    // 4. cleared-by-success
    engine.ingestEvidence(
      "A",
      incarnationId,
      dialOutcome("H", "a3", "success", 3),
    );
    // 5. suppressed-live-session
    engine.ingestEvidence(
      "A",
      incarnationId,
      sessionEvidence("H", "s1", "established", 4),
    );
    engine.ingestEvidence("A", incarnationId, dialRefusal("H", "a4", null, 5));
    // 6. dropped-outside-fleet
    engine.ingestEvidence(
      "A",
      incarnationId,
      dialRefusal("GONE", "a5", null, 6),
    );

    expect(
      dialLogs(log.records).map((record) => record.detail.disposition),
    ).toEqual([
      "counted",
      "dropped-duplicate-attempt",
      "inert-indeterminate",
      "cleared-by-success",
      "suppressed-live-session",
      "dropped-outside-fleet",
    ]);

    authority.dispose();
  });

  it("names the death crossing distinctly from an ordinary counted refusal", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);

    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      authority.engine.ingestEvidence(
        "A",
        incarnationId,
        dialRefusal("H", `attempt-${i}`, null, i),
      );
    }

    const dispositions = dialLogs(log.records).map(
      (record) => record.detail.disposition,
    );
    // Only the crossing is distinguished; everything before it is progress.
    expect(dispositions[dispositions.length - 1]).toBe("counted-reached-death");
    expect(dispositions.slice(0, -1).every((d) => d === "counted")).toBe(true);
    // The streak is reported as it stands AFTER the decision, so a reader can
    // see it advance rather than having to count the lines.
    expect(
      dialLogs(log.records).map((record) => record.detail.refusalStreak),
    ).toEqual(
      Array.from({ length: CONFIRMED_DEATH_REFUSAL_STREAK }, (_, i) => i + 1),
    );
    expect(findLease(authority.engine.snapshot().leases, "H")?.status).toBe(
      "dead",
    );

    authority.dispose();
  });

  it("warns once dial failures stop advancing the streak - the reported pathology", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    // A live session suppresses every refusal (invariant 5), so the host fails
    // repeatedly while its lease can never move. This is the shape that
    // strands a pinned surface, and it is silent in production today.
    engine.ingestEvidence(
      "A",
      incarnationId,
      sessionEvidence("H", "s1", "established", 0),
    );
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialRefusal("H", `attempt-${i}`, null, i),
      );
    }

    const warnings = stallWarnings(log.records);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].detail).toMatchObject({
      hostId: "H",
      disposition: "suppressed-live-session",
      consecutiveNonCounting: CONFIRMED_DEATH_REFUSAL_STREAK,
      refusalStreak: 0,
    });

    authority.dispose();
  });

  it("warns ONCE per stall episode, not once per dial past the threshold", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    // The test above stops exactly AT the threshold, so it cannot tell "fire
    // at the crossing" from "fire at or above it". This one runs well past it:
    // a prolonged outage is when this warn fires and also when dials are most
    // frequent, so warning on every subsequent report would bury the
    // transition under its own repetitions, in the logs of the very incident
    // it exists to mark.
    engine.ingestEvidence(
      "A",
      incarnationId,
      sessionEvidence("H", "s1", "established", 0),
    );
    const dials = CONFIRMED_DEATH_REFUSAL_STREAK * 4;
    for (let i = 0; i < dials; i += 1) {
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialRefusal("H", `attempt-${i}`, null, i),
      );
    }

    expect(stallWarnings(log.records)).toHaveLength(1);
    // Every report is still individually recorded - the `debug` channel keeps
    // the full history, so quieting the warn costs no evidence.
    expect(dialLogs(log.records)).toHaveLength(dials);

    authority.dispose();
  });

  it("names the crossing ONCE - later refusals stay ordinary `counted`", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    const dials = CONFIRMED_DEATH_REFUSAL_STREAK + 3;
    for (let i = 0; i < dials; i += 1) {
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialRefusal("H", `attempt-${i}`, null, i),
      );
    }

    // The lease DECISION stays `>=` - the host is dead and stays dead - but
    // the label marks the single report that crossed. `>=` here would report a
    // long outage as an unbroken run of deaths.
    const dispositions = dialLogs(log.records).map(
      (record) => record.detail.disposition,
    );
    expect(
      dispositions.filter((d) => d === "counted-reached-death"),
    ).toHaveLength(1);
    expect(dispositions[CONFIRMED_DEATH_REFUSAL_STREAK - 1]).toBe(
      "counted-reached-death",
    );
    expect(dispositions[CONFIRMED_DEATH_REFUSAL_STREAK]).toBe("counted");
    expect(findLease(engine.snapshot().leases, "H")?.status).toBe("dead");

    authority.dispose();
  });

  it("keeps NO stall state for a host outside the fleet", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    // Evidence for an unknown host is dropped, so there is no lease to strand
    // a surface on and nothing to warn about. Accumulating here would grow one
    // entry per distinct id between fleet snapshots, and an entry recreated
    // after a prune would be inherited by a durable id that later re-registers.
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK * 3; i += 1) {
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialRefusal(`GONE-${i}`, `attempt-${i}`, null, i),
      );
    }
    // Same id repeatedly, which is the case a per-host counter would catch.
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK * 3; i += 1) {
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialRefusal("GONE", `gone-${i}`, null, 100 + i),
      );
    }

    expect(stallWarnings(log.records)).toHaveLength(0);

    authority.dispose();
  });

  it("does not count a REPLAYED success as a stalled failure", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    // A duplicate is classified before its outcome is ever read, so a success
    // arriving twice looks exactly like a refusal that went nowhere. Warning
    // "dial failures are not advancing" on a run of successes would point the
    // reader at the opposite of what happened.
    engine.ingestEvidence(
      "A",
      incarnationId,
      dialOutcome("H", "same", "success", 0),
    );
    for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK * 2; i += 1) {
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialOutcome("H", "same", "success", 1 + i),
      );
    }

    expect(stallWarnings(log.records)).toHaveLength(0);

    authority.dispose();
  });

  it("clears the stall on proof of life that is not a dial - a session", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    // `onHostProvedAlive` is the funnel for every kind of proof, not just a
    // dial success. Without clearing there, inert reports from BEFORE a
    // recovery combine with one after it and warn about an episode that ended.
    engine.ingestEvidence(
      "A",
      incarnationId,
      dialOutcome("H", "a1", "indeterminate", 0),
    );
    engine.ingestEvidence(
      "A",
      incarnationId,
      dialOutcome("H", "a2", "indeterminate", 1),
    );
    engine.ingestEvidence(
      "A",
      incarnationId,
      sessionEvidence("H", "s1", "established", 2),
    );
    // With the session live every later refusal is suppressed, so this is the
    // first report after the recovery and must not complete the old episode.
    engine.ingestEvidence("A", incarnationId, dialRefusal("H", "a3", null, 3));

    expect(stallWarnings(log.records)).toHaveLength(0);

    authority.dispose();
  });

  it("warns again after a host recovers and stalls a SECOND time", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    // Latching on the host forever would be the wrong cure for the flood: a
    // machine that recovers and then strands a surface again is a new
    // incident, and the second one is exactly as worth reporting as the first.
    engine.ingestEvidence(
      "A",
      incarnationId,
      sessionEvidence("H", "s1", "established", 0),
    );
    let seq = 0;
    for (let episode = 0; episode < 2; episode += 1) {
      for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
        seq += 1;
        engine.ingestEvidence(
          "A",
          incarnationId,
          dialRefusal("H", `attempt-${seq}`, null, seq),
        );
      }
      seq += 1;
      // Proof of life clears the stall.
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialOutcome("H", `attempt-${seq}`, "success", seq),
      );
    }

    expect(stallWarnings(log.records)).toHaveLength(2);

    authority.dispose();
  });

  it("stays silent on a healthy host - the stall resets on any real evidence", () => {
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);
    const { engine } = authority;

    // Two non-counting reports, then proof of life, repeatedly. A warn here
    // would fire on every ordinary reconnect and the signal would be worthless.
    for (let round = 0; round < 4; round += 1) {
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialOutcome("H", `ind-${round}-a`, "indeterminate", round),
      );
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialOutcome("H", `ind-${round}-b`, "indeterminate", round),
      );
      engine.ingestEvidence(
        "A",
        incarnationId,
        dialOutcome("H", `ok-${round}`, "success", round),
      );
    }

    expect(stallWarnings(log.records)).toHaveLength(0);

    authority.dispose();
  });

  it("does not materialise an evidence record for a host whose dial was dropped", () => {
    // The instrument reads the streak WITHOUT `hostEvidence()`, because the
    // evidence map's emptiness is load-bearing ("never dialed" gates the
    // launch-time ensure). A diagnostic that created records here would change
    // which hosts get provisioned - observable as a lease that stops being
    // `connecting` for a host nothing legitimately dialed.
    const log = createRecordingAuthorityLog();
    const { authority, incarnationId } = attachedAuthority(log);

    authority.engine.ingestEvidence(
      "A",
      incarnationId,
      dialOutcome("H", "a1", "indeterminate", 0),
    );

    expect(findLease(authority.engine.snapshot().leases, "H")?.status).toBe(
      "connecting",
    );
    expect(dialLogs(log.records)[0].detail.refusalStreak).toBe(0);

    authority.dispose();
  });
});

// ---------------------------------------------------- cold-start hold (M7)

describe("SelectionAuthorityEngineImpl - cold-start hold: a restarting LOCAL target is waited for, not failed over", () => {
  /**
   * Builds an engine with a CONTROLLABLE {@link LocalHostOutageSignal}, seeded
   * on an EMPTY fleet (`localHostId: null, hosts: []`). `createTestAuthority`
   * cannot be used here: it hardcodes `inertLocalHostOutageSignal`, and this
   * suite drives the signal itself - sometimes already `true` before the
   * fleet ever names a local host (the TARGET-side hold: L is never usable,
   * never effective, and the hold answers ∅), sometimes flipped `true` only
   * AFTER a local host has already become effective some other way (the
   * INCUMBENT-side hold, P1 fix: the per-host proof-of-life gate is what
   * decides whether that incumbent's restart is bounded or not).
   *
   * `initialOutage` and `localHostEnsure` are REQUIRED, not defaulted (this
   * repo's type-safety rules: no optional/defaulted params) - every caller
   * states its own premise rather than inheriting one silently. A caller
   * proving the TARGET-side hold passes `true` (matching the original
   * fixture); a caller proving the INCUMBENT-side P1 fix passes `false` and
   * flips it after the incumbent already exists.
   *
   * The empty seed matters as much as the signal: the constructor's own
   * fleet-seed commit runs with `localHostId: null` (no target, no local
   * host), so it can never touch `mruEffectiveHostIds` or any host's
   * proof-of-life latch - only the later `fleet.publish` the test drives is
   * this process's FIRST look at L or R. Publishing L from construction
   * instead would let the auto-ensure's transient `connecting` (usable,
   * before the outage signal is even read) serve L on that very first
   * commit and falsify the cold-start premise before a single assertion
   * runs.
   */
  function coldBootAuthorityWithOutageSignal(
    clock: FakeAuthorityClock,
    initialOutage: boolean,
    localHostEnsure: LocalHostEnsurePort,
  ): {
    readonly engine: SelectionAuthorityEngineImpl;
    readonly fleet: InMemoryHostFleetSource;
    readonly events: RecordedEngineEvent[];
    setOutage(inExpectedOutage: boolean): void;
    dispose(): void;
  } {
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [],
    });
    const identity = {
      current: () => ({ identityKey: "acct-1", generation: 0 }),
      onChanged: () => ({ dispose: () => undefined }),
    };
    let outageState = initialOutage;
    const outageListeners = new Set<(inExpectedOutage: boolean) => void>();
    const outage: LocalHostOutageSignal = {
      inExpectedOutage: () => outageState,
      onChanged: (listener) => {
        outageListeners.add(listener);
        return { dispose: () => outageListeners.delete(listener) };
      },
    };
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure,
      localOutage: outage,
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      preferredStore: new InMemoryPreferredHostStore(),
      log: silentAuthorityLog,
    });
    const { events } = recordEngineEvents(engine);
    return {
      engine,
      fleet,
      events,
      setOutage: (inExpectedOutage) => {
        outageState = inExpectedOutage;
        for (const listener of Array.from(outageListeners)) {
          listener(inExpectedOutage);
        }
      },
      dispose: () => engine.dispose(),
    };
  }

  it("COLD START HOLD: a never-served process holds ∅ for a restarting LOCAL target instead of failing over to a usable remote", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      true,
      readyLocalHostEnsurePort(),
    );
    const { engine, fleet } = authority;

    // The mutation lane was ALREADY cycling the local host before the fleet
    // ever answered - the launch-reconcile-races-boot shape the hold exists
    // for. Publishing L (local, cycling) + R (remote, an ordinarily fine
    // failover candidate) is this process's FIRST look at either host.
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    expect(findLease(engine.snapshot().leases, "R")?.status).toBe("connecting");
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // Still held with no new evidence, comfortably inside the 20s ceiling -
    // this is what distinguishes a genuine hold from a one-shot ∅ that just
    // happens to be the first answer.
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS / 2);
    expect(engine.snapshot().effectiveHostId).toBeNull();
    expect(engine.snapshot().effectiveHostId).not.toBe("R");

    authority.dispose();
  });

  it("P1 FIX - ONE WINDOW PER EPISODE: after the ceiling lapses onto R, a later ∅ adopts a newly-usable Q at once instead of re-arming a fresh hold on the still-restarting L", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      true,
      readyLocalHostEnsurePort(),
    );
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    // 1. The ordinary cold start: L cycling, R a usable remote, hold engaged.
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // 2. The ceiling lapses and R takes over. The LAPSE ITSELF is what the
    //    rest of this test is about: L has had its window for this episode.
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS + 1);
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // 3. R dies with nothing else usable, so the authority genuinely reaches ∅
    //    - the transition that used to destroy the lapse record, because the
    //    pass that saw R still effective decided no host was being awaited.
    killHostWithRefusals(engine, "A", incarnation, "R");
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // 4. A usable Q appears while L is STILL cycling under the same intent -
    //    no new restart episode, just a fleet that now has an answer.
    clock.advance(1_000);
    fleet.publish(0, "L", [
      fleetHost("L", "local"),
      fleetHost("R", "remote"),
      fleetHost("Q", "remote"),
    ]);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );

    // THE REGRESSION: a second full 20s of ∅ - and this one narrates as the
    // hard "No host is available" card, not as a launch, because the window
    // has been served since. Q must be adopted on the spot.
    expect(engine.snapshot().effectiveHostId).toBe("Q");

    authority.dispose();
  });

  it("P1 FIX - NEVER A FIRST WINDOW AFTER SERVICE: a local restart that begins only after the app has been serving gets no ∅ hold at all, so a newly usable Q is adopted at once", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      false,
      unavailableLocalHostEnsurePort,
    );
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    // The app works: nothing is cycling, and derivation names a host. R,
    // because this machine's host cannot be provisioned at all. Which host it
    // is does not matter - what matters is that ∅ has stopped being a launch
    // story for this process, because the window narrator renders any later ∅
    // as the hard "No host is available" card.
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    // Settle the construction-time ensure: while it is outstanding L reads
    // `connecting` (usable) and outranks R as the target, so the premise of
    // this test - a process serving a REMOTE - only holds once it has come
    // back unavailable.
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // The remote dies too. Real ∅, correctly narrated as a verdict.
    killHostWithRefusals(engine, "A", incarnation, "R");
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // NOW the local host starts cycling - the first restart episode this
    // process has seen, so there is no lapsed record to stop a hold arming.
    // The episode guard cannot help here; only "derivation has named a host
    // before" can.
    clock.advance(1_000);
    authority.setOutage(true);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );

    // A usable machine appears. Holding ∅ for it would put the ∅ modal in
    // front of a user who was working a moment ago, for the full ceiling,
    // with a host right there - the hold buying a modal rather than
    // preventing a flicker.
    fleet.publish(0, "L", [
      fleetHost("L", "local"),
      fleetHost("R", "remote"),
      fleetHost("Q", "remote"),
    ]);
    expect(engine.snapshot().effectiveHostId).toBe("Q");

    authority.dispose();
  });

  it("LANDS ON THE TARGET ONCE: ending the outage before the ceiling adopts L directly, with no intermediate hop onto R", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      true,
      readyLocalHostEnsurePort(),
    );
    const { engine, fleet, events } = authority;

    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // Well inside the 20s ceiling - the boot was slow, not hung.
    clock.advance(5_000);
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // The mutation lane finishes; L is now a live candidate again.
    authority.setOutage(false);
    expect(findLease(engine.snapshot().leases, "L")?.status).not.toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // The full event log never once pointed a window at R - the hold's whole
    // job is to make that hop unnecessary when the target lands in time.
    for (const event of events) {
      if (event.kind !== "selection") continue;
      expect(event.change.effectiveHostId).not.toBe("R");
    }

    // Let the ensure the outage's end just triggered settle before disposing.
    await Promise.resolve();
    await Promise.resolve();
    authority.dispose();
  });

  it("BOUNDED: the ceiling forces a fallback to R at 20s even with the LOCAL OUTAGE signal (a 15-minute hold) still true - the exact 'stuck on the startup screen' regression this ceiling prevents", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      true,
      readyLocalHostEnsurePort(),
    );
    const { engine, fleet } = authority;

    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // Just short of the ceiling: still held, and the outage signal has not
    // moved - the premise that the fall-through below is the CEILING firing,
    // not the outage lapsing on its own (it will not for another ~14 minutes,
    // LOCAL_EXPECTED_OUTAGE_CEILING_MS).
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS - 1);
    expect(engine.snapshot().effectiveHostId).toBeNull();
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );

    // The ceiling itself, reached with NO new evidence - the engine's own
    // deadline timer, not a report, is what wakes this transition. L's lease
    // is UNCHANGED (still restarting-expected): the hold decays on ITS OWN
    // ceiling, not on the underlying episode lapsing.
    clock.advance(1);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("R");

    authority.dispose();
  });

  it("after the ceiling forces R, a later-usable local target recovers only through the ordinary RETURN_TO_TARGET_STABILITY_MS window - no special-casing", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      true,
      readyLocalHostEnsurePort(),
    );
    const { engine, fleet } = authority;

    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS);
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // The outage ends; L becomes usable. The engine is FailedOver now (R is
    // effective, L is target) - the ORDINARY M6 return-to-target window
    // applies from here, not the hold (the hold's own ceiling already
    // lapsed when it forced R, and `holdsForColdStart` never re-arms a
    // window for the SAME host once its ceiling has lapsed - see the NO
    // RE-ARM pin below).
    authority.setOutage(false);
    expect(findLease(engine.snapshot().leases, "L")?.status).not.toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // Let the ensure the outage's end just triggered settle. Until it does,
    // `trackUsability`'s in-flight-ensure branch re-stamps L's `usableSince`
    // to `now` on EVERY commit (F5: a booting host accrues no stability while
    // its own request is outstanding), which would make the window below a
    // moving target instead of the fixed 20s check it is meant to be.
    await Promise.resolve();
    await Promise.resolve();

    clock.advance(RETURN_TO_TARGET_STABILITY_MS - 1);
    expect(engine.snapshot().effectiveHostId).toBe("R");

    clock.advance(1);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    authority.dispose();
  });

  it("P1 FIX - UNPROVEN INCUMBENT IS BOUNDED: a local host that became effective only because the engine's own ensure is in flight - never proven alive - gets the BOUNDED hold once it starts restarting, not the unbounded D5/M6 one", () => {
    const clock = createFakeAuthorityClock(0);
    // An ensure whose promise NEVER settles - the exact shape the review
    // finding caught `noteEffective` recording: L reads `connecting` (usable)
    // purely because THIS process's own launch-time ensure is outstanding,
    // never because anything has actually answered it (arm 2 of
    // `deriveLease`).
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      false,
      neverResolvingLocalHostEnsurePort(),
    );
    const { engine, fleet } = authority;

    // First look at L (local) and R (a fine, usable remote). No outage yet,
    // so the never-dialed local host draws the launch ensure and derives
    // `connecting` - usable - and is picked as both target and effective.
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // The mutation lane starts cycling L a moment later - AFTER the ensure
    // was already minted. This is exactly the case the module header's
    // "COMPOSITION" pin protects: the outage signal alone cannot flip L's
    // lease while this engine's own ensure is still outstanding for it, so
    // nothing observable changes yet.
    clock.advance(30_000);
    authority.setOutage(true);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe("connecting");
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // The ensure's OWN in-flight ceiling (B2) is what finally retires the
    // token - the outage's independent 15-minute ceiling (started 30s later)
    // still has comfortable room left, so the freed arm reveals
    // `restarting-expected`, not `dead`.
    clock.advance(LOCAL_EXPECTED_OUTAGE_CEILING_MS - 30_000);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    // L is STILL the effective host - the D5/M6 exemption never newly
    // selects a restarting host, but it does not throw the app off an
    // already-effective one either. What changed is which ARM is holding
    // it: the incumbent has never proved itself, so this is the bounded
    // cold-start hold, not the unbounded one.
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // BOUNDED: comfortably inside the 20s ceiling, still held.
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS - 1);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // At the ceiling, with NO new evidence, the engine's own deadline timer
    // falls through to the usable remote - the exact regression this pins:
    // before the fix, `mruEffectiveHostIds` already held L (from the very
    // first `noteEffective`, the moment L first read `connecting`), so the
    // OLD gate read "already served" and took the unbounded arm, pinning the
    // startup screen for the outage's full 15-minute ceiling with R sitting
    // right there, usable.
    clock.advance(1);
    expect(engine.snapshot().effectiveHostId).toBe("R");

    authority.dispose();
  });

  it("P1 FIX - PROVEN INCUMBENT STAYS UNBOUNDED: a local host proved alive by its own successful ensure keeps the unbounded D5/M6 hold once it starts restarting", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      false,
      readyLocalHostEnsurePort(),
    );
    const { engine, fleet } = authority;

    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // Let the launch ensure settle: a `{ ok: true }` completion is FIRSTHAND
    // proof of life (`onHostProvedAlive`) - the one thing the previous pin's
    // incumbent never got.
    await Promise.resolve();
    await Promise.resolve();

    // Now the mutation lane starts cycling L. With the ensure already
    // settled (no token left to mask arm 3), the outage signal reaches
    // `deriveLease` directly and L reads `restarting-expected` at once.
    authority.setOutage(true);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("L");

    // UNBOUNDED: well past the 20s cold-start ceiling that bounded the
    // UNPROVEN incumbent above - this is the D5/M6 hold at full strength,
    // because `hasProvedAliveAtLeastOnce("L")` is true.
    clock.advance(60_000);
    expect(engine.snapshot().effectiveHostId).toBe("L");
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );

    authority.dispose();
  });

  it("P1 FIX - RE-KEY ON HOST REPLACEMENT: a fleet republish that swaps the LOCAL identity mid-hold gives the new host its own full 20s window, not the old host's remaining time", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      true,
      readyLocalHostEnsurePort(),
    );
    const { engine, fleet } = authority;

    // L1 is cycling before the fleet ever answers (the TARGET-side hold,
    // like the "COLD START HOLD" pin above): ∅ while it is awaited.
    fleet.publish(0, "L1", [
      fleetHost("L1", "local"),
      fleetHost("R", "remote"),
    ]);
    expect(findLease(engine.snapshot().leases, "L1")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // Comfortably inside L1's window.
    clock.advance(15_000);
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // The desktop republishes on a local-identity change (PID metadata,
    // re-enrolment): a DIFFERENT host, L2, is now `localHostId`, and it is
    // ALSO cycling (the outage signal is a port-level fact, not scoped to
    // one host id).
    fleet.publish(0, "L2", [
      fleetHost("L2", "local"),
      fleetHost("R", "remote"),
    ]);
    expect(findLease(engine.snapshot().leases, "L2")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // 10 more seconds - 25s total since L1's window opened, past what WOULD
    // have been L1's 20s ceiling. Still held: L2 re-keyed the hold to ITS
    // OWN start (t=15s), not L1's elapsed time.
    clock.advance(10_000);
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // 20s after the SWAP (t=15s + 20s = t=35s), L2's own window lapses.
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS - 10_000);
    expect(engine.snapshot().effectiveHostId).toBe("R");

    authority.dispose();
  });

  it("P1 FIX - NO RE-ARM AFTER LAPSE: once the ceiling has forced a fallback, further passes for the SAME still-restarting host do not re-engage the hold", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = coldBootAuthorityWithOutageSignal(
      clock,
      true,
      readyLocalHostEnsurePort(),
    );
    const { engine, fleet } = authority;

    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(engine.snapshot().effectiveHostId).toBeNull();

    // The ceiling forces R, exactly as in the "BOUNDED" pin above.
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS);
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // A FURTHER PASS for the SAME host, still restarting: the registry
    // re-publishes the same membership (a periodic refresh, not a change).
    // `holdsForColdStart("L", ...)` is invoked again on this pass - via the
    // LOCAL-TARGET arm, since L is still the target and still
    // `restarting-expected` - and must not re-arm a fresh window just
    // because it is being asked about again.
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // More time and more passes - still no re-arm.
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS);
    fleet.publish(0, "L", [fleetHost("L", "local"), fleetHost("R", "remote")]);
    expect(engine.snapshot().effectiveHostId).toBe("R");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - cold-start hold does not apply once the process has served", () => {
  it("NOT A COLD START: serving remote R once, a later-cycling local L stays on R (the ordinary D8/M6 arms decide, unaffected by the hold)", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("R", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
      seedPreferred: "R",
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");
    // R is preferred and serves directly at cold boot (never-dialed defaults
    // to `connecting`, which is usable) - this process's FIRST non-null
    // effective, which is what empties `mruEffectiveHostIds`' claim of "never
    // served" for the rest of this identity epoch. L is never even the
    // target here - the LOCAL-target-only half of the gate is pinned
    // separately below.
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // The construction-time launch ensure for the never-dialed local L (D14
    // fires it whichever host is the target) is still in flight, and its
    // in-flight arm outranks the expected-outage arm - so the tombstone
    // below needs it settled first, or L would read `connecting` no matter
    // what the tombstone says.
    await Promise.resolve();
    await Promise.resolve();

    // L now starts a deliberate restart while R - not L - is the current
    // effective host. Under the per-host proof-of-life gate the hold's two
    // arms only ever consider the CURRENT effective host (the incumbent arm)
    // or the local TARGET (the second arm, gated on
    // `targetHostId === localHostId`, false here since R is preferred and L
    // is never the target). L is neither, so this is exactly the shape a
    // regression in that per-host scoping would show up in first - a
    // process serving one host entirely unaffected by an UNRELATED host
    // cycling.
    engine.ingestEvidence(
      "A",
      incarnation,
      restartIntent("L", "tomb-cycle", null, clock.now()),
    );
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("R");

    authority.dispose();
  });

  it("P1 FIX - A SERVING FALLBACK IS NEVER DROPPED: with the local host as the TARGET, a later restart intent for it leaves the failed-over R serving instead of holding ∅", async () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: "L",
        hosts: [fleetHost("L", "local"), fleetHost("R", "remote")],
      },
      initialIdentityKey: "acct-1",
      clock,
    });
    const { engine } = authority;
    const incarnation = attachReporter(engine, "A");

    // NO PREFERENCE, so the target IS the local host (M5). That is the whole
    // difference from the case above - there R was preferred and L was never
    // the target, so `targetHostId === localHostId` was false and the
    // target-side arm could not fire whatever it did. Here it is true, which
    // is the population this pin is about.
    expect(engine.snapshot().targetHostId).toBe("L");

    // L is unprovisionable (the harness default port answers "unavailable")
    // and then refuses its dials outright, so the app fails over to R exactly
    // as D8 says. Settle the construction-time ensure first: its in-flight arm
    // outranks the expected-outage arm, so a restart intent landing while it
    // is outstanding would read `connecting` and prove nothing.
    await Promise.resolve();
    await Promise.resolve();
    killHostWithRefusals(engine, "A", incarnation, "L");
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // THE REGRESSION. A restart intent for L - the user relaunching their own
    // machine's host, or the launch lane reconciling - flips its lease from
    // `dead` to `restarting-expected`. `restartingIncumbentHostId` is null (R
    // is the incumbent and R is not restarting), so before the ∅ gate the
    // target-side arm fired and answered null: a cold-start optimization
    // taking a WORKING remote away from a user who was mid-sentence on it, for
    // the whole ceiling. The hold exists to prevent a hop, not to cause an
    // outage.
    engine.ingestEvidence(
      "A",
      incarnation,
      restartIntent("L", "tomb-relaunch", null, clock.now()),
    );
    expect(findLease(engine.snapshot().leases, "L")?.status).toBe(
      "restarting-expected",
    );
    expect(engine.snapshot().effectiveHostId).toBe("R");

    // And it stays R across the span the hold would have covered - the hold
    // was never armed, rather than armed and immediately lapsed.
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS / 2);
    expect(engine.snapshot().effectiveHostId).toBe("R");
    clock.advance(COLD_START_LOCAL_RESTART_HOLD_CEILING_MS);
    expect(engine.snapshot().effectiveHostId).toBe("R");

    authority.dispose();
  });
});

describe("SelectionAuthorityEngineImpl - cold-start hold is LOCAL-target-only", () => {
  it("REMOTE TARGET UNAFFECTED: a cold start with a restarting PREFERRED REMOTE still falls through to a usable remote instead of holding ∅", () => {
    const clock = createFakeAuthorityClock(0);
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [],
      },
      initialIdentityKey: "acct-1",
      clock,
      seedPreferred: "P",
    });
    const { engine, fleet } = authority;
    const incarnation = attachReporter(engine, "A");

    // Speculative evidence fed before the fleet has ever answered
    // (`hasFleetAnswer` is still false, the empty-seed fleet has zero hosts)
    // is accepted rather than dropped - the same loophole
    // `clearPreferredOutsideFleet`'s doc describes for an unanswered port.
    engine.ingestEvidence(
      "A",
      incarnation,
      restartIntent("P", "tomb-remote", null, clock.now()),
    );

    // First real look at the fleet: P (preferred, remote) is mid-restart, R
    // is a fine remote, and there is no local host at all.
    fleet.publish(0, null, [
      fleetHost("P", "remote"),
      fleetHost("R", "remote"),
    ]);
    expect(engine.snapshot().targetHostId).toBe("P");
    expect(findLease(engine.snapshot().leases, "P")?.status).toBe(
      "restarting-expected",
    );
    // The hold's `targetHostId === localHostId` conjunct is false here (no
    // local host exists at all), so derivation falls straight through to a
    // usable remote instead of holding ∅ for the whole tombstone episode -
    // the grace card the hold protects exists only where a LOCAL host is
    // expected.
    expect(engine.snapshot().effectiveHostId).toBe("R");

    authority.dispose();
  });
});
