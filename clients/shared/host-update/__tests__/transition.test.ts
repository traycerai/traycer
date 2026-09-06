import { describe, expect, it } from "vitest";
import type { HostUpdateAttemptRead } from "../decode";
import {
  attemptIdentityOf,
  compareAttemptOrder,
  nextAttemptCounter,
  type HostUpdateAttemptClaimBaseline,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptRecord,
} from "../record";
import {
  advanceAttempt,
  decideAttemptClaim,
  decideAttemptRecovery,
  isLegalPhaseTransition,
  type AttemptClaimHolderDisposition,
  type AttemptClaimRequest,
  type AttemptRecoveryContext,
  type AttemptRecoveryEvidence,
  type AttemptRecoveryHolderDisposition,
  type AttemptRecoveryRequest,
} from "../transition";

function makeRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

function baseRequest(
  overrides: Partial<AttemptClaimRequest>,
): AttemptClaimRequest {
  return {
    targetVersion: "1.2.3",
    trigger: "manual",
    action: "start",
    expected: null,
    newAttemptId: "new-attempt",
    initialPhase: "downloading",
    initialContinuation: null,
    claim: null,
    nowIso: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

const HELD: AttemptClaimHolderDisposition = { kind: "held-by-self" };
const HOLDER_LIVE: AttemptClaimHolderDisposition = { kind: "holder-live" };
const NO_HOLDER: AttemptClaimHolderDisposition = { kind: "no-holder" };
const INDETERMINATE: AttemptClaimHolderDisposition = { kind: "indeterminate" };

describe("decideAttemptClaim - create", () => {
  it("creates a new attempt over an absent record when the lock is held", () => {
    const decision = decideAttemptClaim({
      current: { kind: "absent" },
      request: baseRequest({}),
      holder: HELD,
    });
    expect(decision.kind).toBe("create");
    if (decision.kind !== "create") return;
    expect(decision.record).toEqual({
      schemaVersion: 2,
      attemptId: "new-attempt",
      generation: 1,
      sequence: 1,
      trigger: "manual",
      targetVersion: "1.2.3",
      phase: "downloading",
      execution: "active",
      continuation: null,
      progress: null,
      startedAt: "2026-01-01T00:10:00.000Z",
      updatedAt: "2026-01-01T00:10:00.000Z",
      completedAt: null,
      error: null,
    });
  });

  it("creates preparing/activate for initialContinuation 'activate' (the activation-debt arm), and the record can then legally park at waiting-to-activate", () => {
    const decision = decideAttemptClaim({
      current: { kind: "absent" },
      request: baseRequest({
        initialPhase: "preparing",
        initialContinuation: "activate",
      }),
      holder: HELD,
    });
    expect(decision.kind).toBe("create");
    if (decision.kind !== "create") return;
    expect(decision.record.phase).toBe("preparing");
    expect(decision.record.execution).toBe("active");
    expect(decision.record.continuation).toBe("activate");

    const parked = advanceAttempt(
      decision.record,
      attemptIdentityOf(decision.record),
      {
        phase: "waiting-to-activate",
        continuation: "activate",
        progress: null,
        error: null,
        claimRefresh: null,
        nowIso: "2026-01-01T00:11:00.000Z",
      },
    );
    expect(parked.kind).toBe("advanced");
    if (parked.kind !== "advanced") return;
    expect(parked.record.phase).toBe("waiting-to-activate");
    expect(parked.record.execution).toBe("parked");
    expect(parked.record.continuation).toBe("activate");
  });

  it("writes the claim baseline verbatim when the request carries one, and omits the key entirely for null (byte-identical to today)", () => {
    const claim: HostUpdateAttemptClaimBaseline = {
      installedVersion: "1.0.0",
      installGeneration: "gen-a",
      stageFingerprint: "fp-a",
      allowDowngrade: true,
    };
    const withClaim = decideAttemptClaim({
      current: { kind: "absent" },
      request: baseRequest({ claim }),
      holder: HELD,
    });
    expect(withClaim.kind).toBe("create");
    if (withClaim.kind === "create")
      expect(withClaim.record.claim).toEqual(claim);

    const withoutClaim = decideAttemptClaim({
      current: { kind: "absent" },
      request: baseRequest({ claim: null }),
      holder: HELD,
    });
    expect(withoutClaim.kind).toBe("create");
    if (withoutClaim.kind === "create") {
      expect("claim" in withoutClaim.record).toBe(false);
    }
  });

  it.each([
    ["holder-live", HOLDER_LIVE],
    ["no-holder", NO_HOLDER],
    ["indeterminate", INDETERMINATE],
  ])(
    "refuses lock-unavailable over an absent record when the lock is not held (%s)",
    (_label, holder) => {
      const decision = decideAttemptClaim({
        current: { kind: "absent" },
        request: baseRequest({}),
        holder,
      });
      expect(decision).toEqual({
        kind: "refuse",
        reason: "lock-unavailable",
        observed: null,
      });
    },
  );

  it("creates a new attempt over a retained terminal record, regardless of target", () => {
    const terminal = makeRecord({
      phase: "complete",
      execution: "terminal",
      completedAt: "2025-12-31T00:00:00.000Z",
      targetVersion: "9.9.9", // deliberately different from the request's target
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: terminal },
      request: baseRequest({}),
      holder: HELD,
    });
    expect(decision.kind).toBe("create");
    if (decision.kind !== "create") return;
    expect(decision.record.attemptId).toBe("new-attempt");
    expect(decision.record.generation).toBe(1);
    expect(decision.record.sequence).toBe(1);
  });

  it("refuses new-attempt-id-reused when the request's fresh id collides with the retained terminal id", () => {
    const terminal = makeRecord({
      phase: "complete",
      execution: "terminal",
      completedAt: "2025-12-31T00:00:00.000Z",
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: terminal },
      request: baseRequest({ newAttemptId: terminal.attemptId }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "new-attempt-id-reused",
      observed: terminal,
    });
  });
});

describe("decideAttemptClaim - attach requires holder-live evidence and an active same-target record", () => {
  it("attaches to the same target already in flight when a live holder is proven and the request is a plain start", () => {
    const active = makeRecord({});
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: active },
      request: baseRequest({}),
      holder: HOLDER_LIVE,
    });
    expect(decision).toEqual({ kind: "attach", observed: active });
  });

  it("does not attach to a parked record even with holder-live evidence - a park has no executor by definition", () => {
    const parked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: parked },
      request: baseRequest({}),
      holder: HOLDER_LIVE,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "lock-unavailable",
      observed: parked,
    });
  });

  it.each([
    ["no-holder", NO_HOLDER],
    ["indeterminate", INDETERMINATE],
  ])(
    "does not attach to an active same-target record without positive holder-live evidence (%s)",
    (_label, holder) => {
      const active = makeRecord({});
      const decision = decideAttemptClaim({
        current: { kind: "valid", version: 2, value: active },
        request: baseRequest({}),
        holder,
      });
      expect(decision).toEqual({
        kind: "refuse",
        reason: "lock-unavailable",
        observed: active,
      });
    },
  );

  it("does not attach for a non-start action even against an active, same-target, holder-live record", () => {
    const active = makeRecord({});
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: active },
      request: baseRequest({
        action: "force",
        expected: attemptIdentityOf(active),
      }),
      holder: HOLDER_LIVE,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "lock-unavailable",
      observed: active,
    });
  });
});

describe("decideAttemptClaim - resume: each action against each parked continuation", () => {
  const resumeApplyParked = makeRecord({
    phase: "waiting-for-work",
    execution: "parked",
    continuation: "resume-apply",
    generation: 3,
    sequence: 7,
    trigger: "automatic",
  });
  const activateParked = makeRecord({
    phase: "waiting-to-activate",
    execution: "parked",
    continuation: "activate",
    generation: 3,
    sequence: 7,
    trigger: "automatic",
  });

  it.each(["resume-apply", "force"] as const)(
    "resumes a resume-apply park for action %s",
    (action) => {
      const decision = decideAttemptClaim({
        current: { kind: "valid", version: 2, value: resumeApplyParked },
        request: baseRequest({
          action,
          expected: attemptIdentityOf(resumeApplyParked),
        }),
        holder: HELD,
      });
      expect(decision.kind).toBe("resume");
      if (decision.kind !== "resume") return;
      expect(decision.continuation).toBe("resume-apply");
      expect(decision.record.phase).toBe("preparing");
      expect(decision.record.execution).toBe("active");
      expect(decision.record.generation).toBe(4);
      expect(decision.record.sequence).toBe(8);
      expect(decision.record.continuation).toBe("resume-apply");
      expect(decision.record.trigger).toBe("automatic");
    },
  );

  it.each(["activate", "defer", "start"] as const)(
    "refuses request-action-mismatch for action %s against a resume-apply park",
    (action) => {
      const request =
        action === "start"
          ? baseRequest({ action: "start", expected: null })
          : baseRequest({
              action,
              expected: attemptIdentityOf(resumeApplyParked),
            });
      const decision = decideAttemptClaim({
        current: { kind: "valid", version: 2, value: resumeApplyParked },
        request,
        holder: HELD,
      });
      expect(decision).toEqual({
        kind: "refuse",
        reason: "request-action-mismatch",
        observed: resumeApplyParked,
      });
    },
  );

  it("resumes an activate park for action activate", () => {
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: activateParked },
      request: baseRequest({
        action: "activate",
        expected: attemptIdentityOf(activateParked),
      }),
      holder: HELD,
    });
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.continuation).toBe("activate");
    expect(decision.record.phase).toBe("preparing");
    expect(decision.record.continuation).toBe("activate");
  });

  it.each(["resume-apply", "force", "defer", "start"] as const)(
    "refuses request-action-mismatch for action %s against an activate park",
    (action) => {
      const request =
        action === "start"
          ? baseRequest({ action: "start", expected: null })
          : baseRequest({
              action,
              expected: attemptIdentityOf(activateParked),
            });
      const decision = decideAttemptClaim({
        current: { kind: "valid", version: 2, value: activateParked },
        request,
        holder: HELD,
      });
      expect(decision).toEqual({
        kind: "refuse",
        reason: "request-action-mismatch",
        observed: activateParked,
      });
    },
  );

  // `continue` is identity-bound (§ D19): it does not name an operation, it
  // names an ATTEMPT and adopts whichever continuation that attempt's park
  // says. So, unlike every other action above, it resumes BOTH parks.
  it("resumes a resume-apply park for action continue", () => {
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: resumeApplyParked },
      request: baseRequest({
        action: "continue",
        expected: attemptIdentityOf(resumeApplyParked),
      }),
      holder: HELD,
    });
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.continuation).toBe("resume-apply");
    expect(decision.record.continuation).toBe("resume-apply");
  });

  it("resumes an activate park for action continue", () => {
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: activateParked },
      request: baseRequest({
        action: "continue",
        expected: attemptIdentityOf(activateParked),
      }),
      holder: HELD,
    });
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.continuation).toBe("activate");
    expect(decision.record.continuation).toBe("activate");
  });
});

describe("decideAttemptClaim - continue with expected: null is refused, never a create", () => {
  it("refuses stale-expectation for continue with expected: null, before any record is even consulted", () => {
    // Invariant: `continue with expected: null` -> `stale-expectation`. This
    // is the generic non-`start` rule (§1.1) - `continue` is never the sole
    // unbound operation `start` is, so it cannot mint a fresh attempt either.
    const decision = decideAttemptClaim({
      current: { kind: "absent" },
      request: baseRequest({ action: "continue", expected: null }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "stale-expectation",
      observed: null,
    });
  });
});

describe("decideAttemptClaim - recovery outranks supersession", () => {
  // §1.1: `requires-recovery` must be checked for EVERY active record, before
  // the target comparison, regardless of what the new request's target is.
  it("requires recovery for an active record even when the request names a different target", () => {
    const active = makeRecord({ generation: 2, sequence: 5 });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: active },
      request: baseRequest({ targetVersion: "2.0.0" }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "requires-recovery",
      observed: active,
    });
  });

  it("requires recovery for an active, unheld record even though this contender holds the lock", () => {
    const active = makeRecord({});
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: active },
      request: baseRequest({}),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "requires-recovery",
      observed: active,
    });
  });
});

describe("decideAttemptClaim - supersede", () => {
  it("supersedes a parked attempt for a different target, and a second decision then creates", () => {
    const parked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      generation: 1,
      sequence: 2,
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: parked },
      request: baseRequest({ targetVersion: "2.0.0" }),
      holder: HELD,
    });
    expect(decision.kind).toBe("supersede");
    if (decision.kind !== "supersede") return;
    expect(decision.record.generation).toBe(2);
    expect(decision.record.sequence).toBe(3);
    expect(decision.record.phase).toBe("superseded");
    expect(decision.record.continuation).toBeNull();

    const followUp = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: decision.record },
      request: baseRequest({ targetVersion: "2.0.0" }),
      holder: HELD,
    });
    expect(followUp.kind).toBe("create");
  });
});

describe("decideAttemptClaim - fail-closed refusals", () => {
  it.each([
    ["corrupt", { kind: "corrupt" } as HostUpdateAttemptRead],
    [
      "unreadable",
      { kind: "unreadable", cause: "EACCES" } as HostUpdateAttemptRead,
    ],
    [
      "unsupported-version",
      { kind: "unsupported-version", version: 9 } as HostUpdateAttemptRead,
    ],
  ])(
    "refuses record-fail-closed for a %s record, regardless of holder disposition",
    (_label, current) => {
      for (const holder of [HELD, HOLDER_LIVE, NO_HOLDER, INDETERMINATE]) {
        const decision = decideAttemptClaim({
          current,
          request: baseRequest({}),
          holder,
        });
        expect(decision).toEqual({
          kind: "refuse",
          reason: "record-fail-closed",
          observed: null,
        });
      }
    },
  );

  it("refuses stale-expectation when the request's expected identity has moved on", () => {
    const record = makeRecord({ generation: 2, sequence: 5 });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: record },
      request: baseRequest({
        action: "force",
        expected: { attemptId: "attempt-1", generation: 1, sequence: 1 },
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "stale-expectation",
      observed: record,
    });
  });

  it("refuses target-conflict when a different target is in flight and this contender lost the lock", () => {
    const active = makeRecord({});
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: active },
      request: baseRequest({ targetVersion: "2.0.0" }),
      holder: NO_HOLDER,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "target-conflict",
      observed: active,
    });
  });

  it("refuses lock-unavailable when a retained terminal record is found without the lock", () => {
    const terminal = makeRecord({ phase: "complete", execution: "terminal" });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: terminal },
      request: baseRequest({}),
      holder: NO_HOLDER,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "lock-unavailable",
      observed: terminal,
    });
  });

  it("refuses request-action-mismatch when action is start but an expected identity is supplied", () => {
    const record = makeRecord({});
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: record },
      request: baseRequest({
        action: "start",
        expected: attemptIdentityOf(record),
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "request-action-mismatch",
      observed: null,
    });
  });
});

describe("decideAttemptClaim - identity-bound requests never create", () => {
  it.each([
    ["held-by-self", HELD],
    ["holder-live", HOLDER_LIVE],
    ["no-holder", NO_HOLDER],
    ["indeterminate", INDETERMINATE],
  ])(
    "refuses stale-expectation for an identity-bound request over an absent record (%s)",
    (_label, holder) => {
      const decision = decideAttemptClaim({
        current: { kind: "absent" },
        request: baseRequest({
          action: "force",
          expected: { attemptId: "gone", generation: 1, sequence: 1 },
        }),
        holder,
      });
      expect(decision).toEqual({
        kind: "refuse",
        reason: "stale-expectation",
        observed: null,
      });
    },
  );

  it("refuses attempt-already-terminal for an identity-bound request matching a terminal record", () => {
    const terminal = makeRecord({
      phase: "complete",
      execution: "terminal",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: terminal },
      request: baseRequest({
        action: "force",
        expected: attemptIdentityOf(terminal),
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "attempt-already-terminal",
      observed: terminal,
    });
  });

  it("refuses stale-expectation for an identity-bound request whose identity does not match a live active record", () => {
    const active = makeRecord({ generation: 2, sequence: 5 });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: active },
      request: baseRequest({
        action: "force",
        expected: { attemptId: "attempt-1", generation: 1, sequence: 1 },
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "stale-expectation",
      observed: active,
    });
  });

  it("refuses stale-expectation for an identity-bound request whose identity does not match a parked record", () => {
    const parked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      generation: 2,
      sequence: 4,
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: parked },
      request: baseRequest({
        action: "resume-apply",
        expected: { attemptId: "attempt-1", generation: 1, sequence: 1 },
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "stale-expectation",
      observed: parked,
    });
  });

  it("still resumes for an identity-bound request matching a parked record", () => {
    const parked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      generation: 2,
      sequence: 4,
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: parked },
      request: baseRequest({
        action: "resume-apply",
        expected: attemptIdentityOf(parked),
      }),
      holder: HELD,
    });
    expect(decision.kind).toBe("resume");
  });
});

describe("decideAttemptClaim - identity-bound requests are bound to target, not just identity", () => {
  it("refuses request-target-mismatch when the exact identity matches but the request names a different target (active record)", () => {
    const active = makeRecord({ targetVersion: "1.2.3" });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: active },
      request: baseRequest({
        action: "force",
        targetVersion: "9.9.9",
        expected: attemptIdentityOf(active),
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "request-target-mismatch",
      observed: active,
    });
  });

  it("refuses request-target-mismatch when the exact identity matches but the request names a different target (parked record)", () => {
    const parked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      targetVersion: "1.2.3",
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: parked },
      request: baseRequest({
        action: "resume-apply",
        targetVersion: "9.9.9",
        expected: attemptIdentityOf(parked),
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "request-target-mismatch",
      observed: parked,
    });
  });

  it("does not retarget or choose a different continuation - an exact identity+action match is required to resume", () => {
    const resumeApplyParked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
    });
    // Correct identity and target, but the action asks for the OTHER
    // continuation. Must refuse, not silently resume the wrong one.
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: resumeApplyParked },
      request: baseRequest({
        action: "activate",
        expected: attemptIdentityOf(resumeApplyParked),
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "request-action-mismatch",
      observed: resumeApplyParked,
    });
  });
});

describe("decideAttemptClaim - counter-exhausted at the safe-integer ceiling", () => {
  it("refuses counter-exhausted when resuming a parked attempt at the generation ceiling", () => {
    const parked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      generation: Number.MAX_SAFE_INTEGER,
      sequence: 3,
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: parked },
      request: baseRequest({
        action: "resume-apply",
        expected: attemptIdentityOf(parked),
      }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "counter-exhausted",
      observed: parked,
    });
  });

  it("refuses counter-exhausted when superseding a parked attempt at the sequence ceiling", () => {
    const parked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      generation: 3,
      sequence: Number.MAX_SAFE_INTEGER,
    });
    const decision = decideAttemptClaim({
      current: { kind: "valid", version: 2, value: parked },
      request: baseRequest({ targetVersion: "2.0.0" }),
      holder: HELD,
    });
    expect(decision).toEqual({
      kind: "refuse",
      reason: "counter-exhausted",
      observed: parked,
    });
  });
});

describe("record ordering and counters at the safe-integer ceiling", () => {
  it("nextAttemptCounter returns null at Number.MAX_SAFE_INTEGER", () => {
    expect(nextAttemptCounter(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("compareAttemptOrder orders MAX_SAFE_INTEGER - 1 before MAX_SAFE_INTEGER without collapsing to 0", () => {
    const a: HostUpdateAttemptIdentity = {
      attemptId: "attempt-1",
      generation: 1,
      sequence: Number.MAX_SAFE_INTEGER - 1,
    };
    const b: HostUpdateAttemptIdentity = {
      attemptId: "attempt-1",
      generation: 1,
      sequence: Number.MAX_SAFE_INTEGER,
    };
    expect(compareAttemptOrder(a, b)).toBe(-1);
    expect(compareAttemptOrder(b, a)).toBe(1);
  });
});

describe("isLegalPhaseTransition - load-bearing prohibitions", () => {
  it("forbids waiting-to-activate -> applying: bytes are already placed, re-applying would corrupt", () => {
    expect(isLegalPhaseTransition("waiting-to-activate", "applying")).toBe(
      false,
    );
  });

  it("forbids reaching complete from anywhere except verifying", () => {
    const nonVerifyingPhases = [
      "downloading",
      "preparing",
      "applying",
      "waiting-for-work",
      "waiting-to-activate",
      "restarting",
    ] as const;
    for (const phase of nonVerifyingPhases) {
      expect(isLegalPhaseTransition(phase, "complete")).toBe(false);
    }
    expect(isLegalPhaseTransition("verifying", "complete")).toBe(true);
  });
});

describe("advanceAttempt - continuation provenance matrix", () => {
  it.each([
    [
      "preparing/null -> waiting-to-activate/activate",
      makeRecord({ phase: "preparing", continuation: null }),
      "waiting-to-activate",
      "activate",
      "continuation-phase-order",
    ],
    ...(["restarting", "verifying", "waiting-to-activate"] as const).map(
      (phase) =>
        [
          `resumed resume-apply preparing -> ${phase}`,
          makeRecord({ phase: "preparing", continuation: "resume-apply" }),
          phase,
          phase === "waiting-to-activate" ? "activate" : "resume-apply",
          phase === "waiting-to-activate"
            ? "illegal-continuation"
            : "continuation-phase-order",
        ] as const,
    ),
    [
      "activate/preparing -> verifying/activate",
      makeRecord({ phase: "preparing", continuation: "activate" }),
      "verifying",
      "activate",
      "continuation-phase-order",
    ],
    [
      "activate/preparing -> applying/activate",
      makeRecord({ phase: "preparing", continuation: "activate" }),
      "applying",
      "activate",
      "continuation-forbids-phase",
    ],
    [
      "activate/preparing -> downloading/activate",
      makeRecord({ phase: "preparing", continuation: "activate" }),
      "downloading",
      "activate",
      "continuation-forbids-phase",
    ],
  ] as const)(
    "rejects %s with the provenance-specific reason",
    (_label, current, phase, continuation, reason) => {
      const outcome = advanceAttempt(current, attemptIdentityOf(current), {
        phase,
        continuation,
        progress: null,
        error: null,
        claimRefresh: null,
        nowIso: "2026-01-01T00:05:00.000Z",
      });
      expect(outcome).toEqual({ kind: "rejected", reason });
    },
  );

  it.each([
    ["applying/null -> waiting-to-activate/activate", null],
    ["applying/resume-apply -> waiting-to-activate/activate", "resume-apply"],
  ] as const)(
    "allows the sole byte-placement handoff: %s",
    (_label, continuation) => {
      const current = makeRecord({ phase: "applying", continuation });
      const outcome = advanceAttempt(current, attemptIdentityOf(current), {
        phase: "waiting-to-activate",
        continuation: "activate",
        progress: null,
        error: null,
        claimRefresh: null,
        nowIso: "2026-01-01T00:05:00.000Z",
      });
      expect(outcome.kind).toBe("advanced");
      if (outcome.kind !== "advanced") return;
      expect(outcome.record.phase).toBe("waiting-to-activate");
      expect(outcome.record.continuation).toBe("activate");
      expect(outcome.record.execution).toBe("parked");
    },
  );

  it("allows a resumed activate segment to repark, then cross restart and verification", () => {
    const preparing = makeRecord({
      phase: "preparing",
      continuation: "activate",
    });
    const reparking = advanceAttempt(preparing, attemptIdentityOf(preparing), {
      phase: "waiting-to-activate",
      continuation: "activate",
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(reparking.kind).toBe("advanced");
    if (reparking.kind !== "advanced") return;

    const restarting = advanceAttempt(preparing, attemptIdentityOf(preparing), {
      phase: "restarting",
      continuation: "activate",
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:06:00.000Z",
    });
    expect(restarting.kind).toBe("advanced");
    if (restarting.kind !== "advanced") return;

    const verifying = advanceAttempt(
      restarting.record,
      attemptIdentityOf(restarting.record),
      {
        phase: "verifying",
        continuation: "activate",
        progress: null,
        error: null,
        claimRefresh: null,
        nowIso: "2026-01-01T00:07:00.000Z",
      },
    );
    expect(verifying.kind).toBe("advanced");
    if (verifying.kind === "advanced") {
      expect(verifying.record.phase).toBe("verifying");
      expect(verifying.record.continuation).toBe("activate");
    }
  });
});

describe("advanceAttempt", () => {
  it("advances a legal transition, bumping sequence and stamping updatedAt", () => {
    const current = makeRecord({ phase: "downloading" });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "preparing",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect(outcome.record.phase).toBe("preparing");
    expect(outcome.record.sequence).toBe(2);
    expect(outcome.record.updatedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(outcome.record.completedAt).toBeNull();
  });

  it("rejects identity-mismatch for a different attempt entirely", () => {
    const current = makeRecord({});
    const outcome = advanceAttempt(
      current,
      { attemptId: "some-other-attempt", generation: 1, sequence: 1 },
      {
        phase: "preparing",
        continuation: null,
        progress: null,
        error: null,
        claimRefresh: null,
        nowIso: "2026-01-01T00:05:00.000Z",
      },
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "identity-mismatch" });
  });

  it("rejects generation-superseded when a newer generation has since been claimed", () => {
    const current = makeRecord({ generation: 2 });
    const outcome = advanceAttempt(
      current,
      { attemptId: "attempt-1", generation: 1, sequence: 1 },
      {
        phase: "preparing",
        continuation: null,
        progress: null,
        error: null,
        claimRefresh: null,
        nowIso: "2026-01-01T00:05:00.000Z",
      },
    );
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "generation-superseded",
    });
  });

  it("rejects sequence-stale when this segment's own view of sequence is behind disk", () => {
    const current = makeRecord({ sequence: 3 });
    const outcome = advanceAttempt(
      current,
      { attemptId: "attempt-1", generation: 1, sequence: 1 },
      {
        phase: "preparing",
        continuation: null,
        progress: null,
        error: null,
        claimRefresh: null,
        nowIso: "2026-01-01T00:05:00.000Z",
      },
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "sequence-stale" });
  });

  it("rejects terminal when the current record is already terminal", () => {
    const current = makeRecord({ phase: "failed", execution: "terminal" });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "preparing",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({ kind: "rejected", reason: "terminal" });
  });

  it.each([
    ["waiting-for-work", "resume-apply", "preparing"],
    ["waiting-to-activate", "activate", "restarting"],
    ["waiting-to-activate", "activate", "applying"],
  ] as const)(
    "rejects not-active for %s -> %s directly via advanceAttempt: leaving a park is a claim, not an advance (the reported waiting-to-activate -> restarting bypass)",
    (phase, continuation, targetPhase) => {
      const current = makeRecord({
        phase,
        execution: "parked",
        continuation,
      });
      const outcome = advanceAttempt(current, attemptIdentityOf(current), {
        phase: targetPhase,
        continuation,
        progress: null,
        error: null,
        claimRefresh: null,
        nowIso: "2026-01-01T00:05:00.000Z",
      });
      expect(outcome).toEqual({ kind: "rejected", reason: "not-active" });
    },
  );

  it("rejects continuation-forbids-phase for an activate segment advancing to applying", () => {
    const current = makeRecord({
      phase: "preparing",
      execution: "active",
      continuation: "activate",
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "applying",
      continuation: "activate",
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "continuation-forbids-phase",
    });
  });

  it("rejects continuation-forbids-phase for an activate segment advancing to downloading", () => {
    const current = makeRecord({
      phase: "preparing",
      execution: "active",
      continuation: "activate",
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "downloading",
      continuation: "activate",
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "continuation-forbids-phase",
    });
  });

  it("rejects illegal-continuation when an active->active advance erases an in-flight continuation", () => {
    const current = makeRecord({
      phase: "preparing",
      execution: "active",
      continuation: "activate",
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "preparing",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "illegal-continuation",
    });
  });

  it("rejects illegal-continuation when an active->active advance swaps the in-flight continuation", () => {
    const current = makeRecord({
      phase: "preparing",
      execution: "active",
      continuation: "activate",
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "preparing",
      continuation: "resume-apply",
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "illegal-continuation",
    });
  });

  it("rejects illegal-continuation when parking with a continuation that does not match the in-flight one", () => {
    const current = makeRecord({
      phase: "preparing",
      execution: "active",
      continuation: "activate",
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "waiting-for-work",
      continuation: "resume-apply",
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "illegal-continuation",
    });
  });

  it("advances preparing/activate -> restarting/activate, carrying the continuation unchanged", () => {
    const current = makeRecord({
      phase: "preparing",
      execution: "active",
      continuation: "activate",
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "restarting",
      continuation: "activate",
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect(outcome.record.phase).toBe("restarting");
    expect(outcome.record.continuation).toBe("activate");
    expect(outcome.record.execution).toBe("active");
  });

  it("allows a terminal landing with continuation: null from an in-flight activate segment", () => {
    const current = makeRecord({
      phase: "restarting",
      execution: "active",
      continuation: "activate",
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "failed",
      continuation: null,
      progress: null,
      error: { code: "restart-failed", message: "boom", phase: "restarting" },
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect(outcome.record.phase).toBe("failed");
    expect(outcome.record.execution).toBe("terminal");
    expect(outcome.record.continuation).toBeNull();
  });

  it("rejects counter-exhausted when the sequence is already at the safe-integer ceiling", () => {
    const current = makeRecord({ sequence: Number.MAX_SAFE_INTEGER });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "preparing",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({ kind: "rejected", reason: "counter-exhausted" });
  });

  it("rejects illegal-phase when advancing to complete from anywhere but verifying", () => {
    const current = makeRecord({ phase: "restarting" });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "complete",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({ kind: "rejected", reason: "illegal-phase" });
  });

  it("rejects illegal-continuation when the target phase's continuation contract is violated", () => {
    const current = makeRecord({ phase: "downloading" });
    // `waiting-for-work` is a legal successor of `downloading`, but it must
    // carry `resume-apply`, never `null`.
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "waiting-for-work",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "illegal-continuation",
    });
  });

  it("stamps completedAt only when the advance lands on a terminal phase", () => {
    const current = makeRecord({ phase: "verifying" });

    const nonTerminal = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "verifying",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:06:00.000Z",
    });
    expect(nonTerminal.kind).toBe("advanced");
    if (nonTerminal.kind === "advanced") {
      expect(nonTerminal.record.completedAt).toBeNull();
    }

    const terminal = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "complete",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:07:00.000Z",
    });
    expect(terminal.kind).toBe("advanced");
    if (terminal.kind === "advanced") {
      expect(terminal.record.execution).toBe("terminal");
      expect(terminal.record.completedAt).toBe("2026-01-01T00:07:00.000Z");
    }
  });
});

describe("advanceAttempt - claimRefresh (D19): the three park arms", () => {
  const priorClaim: HostUpdateAttemptClaimBaseline = {
    installedVersion: "1.2.3",
    installGeneration: "gen-prior",
    stageFingerprint: "fp-prior",
    // Deliberately `true` with a refresh naming an installedVersion BELOW the
    // record's own target - a recomputation from version order would say
    // `false`, so a passing test here is proof the value was COPIED, not
    // rederived from the refresh or from the target.
    allowDowngrade: true,
  };

  it("replaces the three identity fields on a refresh and copies allowDowngrade from the prior record, never recomputing it", () => {
    const current = makeRecord({
      phase: "applying",
      continuation: null,
      claim: priorClaim,
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "waiting-to-activate",
      continuation: "activate",
      progress: null,
      error: null,
      claimRefresh: {
        installedVersion: "0.9.0",
        installGeneration: "gen-refreshed",
        stageFingerprint: "fp-refreshed",
      },
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect(outcome.record.claim).toEqual({
      installedVersion: "0.9.0",
      installGeneration: "gen-refreshed",
      stageFingerprint: "fp-refreshed",
      allowDowngrade: true,
    });
  });

  it("carries the claim byte-identically when claimRefresh is null on a claimed record - a park may refresh or carry, never drop", () => {
    const current = makeRecord({
      phase: "applying",
      continuation: null,
      claim: priorClaim,
    });
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "waiting-to-activate",
      continuation: "activate",
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect(outcome.record.claim).toEqual(priorClaim);
  });

  it("ignores a refresh on a claim-less record - a legacy continuation cannot gain a consent nobody granted it", () => {
    const current = makeRecord({ phase: "applying", continuation: null });
    expect("claim" in current).toBe(false);
    const outcome = advanceAttempt(current, attemptIdentityOf(current), {
      phase: "waiting-to-activate",
      continuation: "activate",
      progress: null,
      error: null,
      claimRefresh: {
        installedVersion: "1.0.0",
        installGeneration: "gen-a",
        stageFingerprint: null,
      },
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect("claim" in outcome.record).toBe(false);
  });
});

// ---- decideAttemptRecovery ---------------------------------------------------
//
// The evidence-based recovery arm for `requires-recovery` (§ ticket 03 scope
// item 1). Pure, clock-free, and lock-scoped: `holder` must already be
// `recovery-lock-held` by the time this runs, so the only interesting inputs
// are the record's execution/identity and the typed install/stage/running
// evidence triple.

const LOCK_HELD: AttemptRecoveryHolderDisposition = {
  kind: "recovery-lock-held",
};
const RECOVERY_HOLDER_LIVE: AttemptRecoveryHolderDisposition = {
  kind: "holder-live",
};
const RECOVERY_INDETERMINATE: AttemptRecoveryHolderDisposition = {
  kind: "indeterminate",
};

const NO_EVIDENCE: AttemptRecoveryEvidence = {
  installed: { kind: "absent" },
  staged: { kind: "absent" },
  running: { kind: "absent" },
};

function recoveryContext(overrides: {
  readonly current: HostUpdateAttemptRecord;
  readonly request?: Partial<AttemptRecoveryRequest>;
  readonly holder?: AttemptRecoveryHolderDisposition;
}): AttemptRecoveryContext {
  const current = overrides.current;
  return {
    current,
    request: {
      expected: attemptIdentityOf(current),
      // `force` is the broadest resume authorization (covers resume-apply)
      // so it is a safe default for every test that returns before the
      // action/continuation check is even reached. Tests that exercise an
      // `activate` continuation must override this explicitly.
      action: "force",
      requestedTargetVersion: current.targetVersion,
      evidence: NO_EVIDENCE,
      nowIso: "2026-01-01T00:04:00.000Z",
      ...overrides.request,
    },
    holder: overrides.holder ?? LOCK_HELD,
  };
}

describe("decideAttemptRecovery - holder proof is mandatory", () => {
  it.each([
    ["holder-live", RECOVERY_HOLDER_LIVE],
    ["indeterminate", RECOVERY_INDETERMINATE],
  ])(
    "refuses holder-not-proven-absent for %s, before even inspecting the record",
    (_label, holder) => {
      const active = makeRecord({});
      const decision = decideAttemptRecovery(
        recoveryContext({ current: active, holder }),
      );
      expect(decision).toEqual({
        kind: "refuse",
        reason: "holder-not-proven-absent",
      });
    },
  );
});

describe("decideAttemptRecovery - record must be active and identity-matched", () => {
  it("refuses record-not-recoverable for a parked record", () => {
    const parked = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
    });
    const decision = decideAttemptRecovery(
      recoveryContext({ current: parked }),
    );
    expect(decision).toEqual({
      kind: "refuse",
      reason: "record-not-recoverable",
    });
  });

  it("refuses record-not-recoverable for a terminal record", () => {
    const terminal = makeRecord({
      phase: "complete",
      execution: "terminal",
      completedAt: "2025-12-31T00:00:00.000Z",
    });
    const decision = decideAttemptRecovery(
      recoveryContext({ current: terminal }),
    );
    expect(decision).toEqual({
      kind: "refuse",
      reason: "record-not-recoverable",
    });
  });

  it("refuses identity-mismatch for an active record when the expected identity has moved on", () => {
    const active = makeRecord({ generation: 2, sequence: 5 });
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          expected: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        },
      }),
    );
    expect(decision).toEqual({ kind: "refuse", reason: "identity-mismatch" });
  });

  it("refuses identity-mismatch when the attempt id itself differs", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          expected: {
            attemptId: "some-other-attempt",
            generation: 1,
            sequence: 1,
          },
        },
      }),
    );
    expect(decision).toEqual({ kind: "refuse", reason: "identity-mismatch" });
  });
});

describe("decideAttemptRecovery - unreadable evidence fails closed before any other check", () => {
  it.each([
    ["installed", { installed: { kind: "unreadable" } } as const],
    ["staged", { staged: { kind: "unreadable" } } as const],
    ["running", { running: { kind: "unreadable" } } as const],
  ])(
    "refuses evidence-unreadable when %s evidence is unreadable",
    (_leg, patch) => {
      const active = makeRecord({});
      const decision = decideAttemptRecovery(
        recoveryContext({
          current: active,
          request: { evidence: { ...NO_EVIDENCE, ...patch } },
        }),
      );
      expect(decision).toEqual({
        kind: "refuse",
        reason: "evidence-unreadable",
      });
    },
  );
});

describe("decideAttemptRecovery - terminalize-complete: exact installed + running proof", () => {
  it("terminalizes complete when installed and running (host-home-bound) both verify the exact target", () => {
    const active = makeRecord({ generation: 2, sequence: 9 });
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: {
              kind: "verified",
              version: "1.2.3",
              owner: "host-home-bound",
            },
          },
        },
      }),
    );
    expect(decision.kind).toBe("terminalize-complete");
    if (decision.kind !== "terminalize-complete") return;
    expect(decision.record.phase).toBe("complete");
    expect(decision.record.execution).toBe("terminal");
    expect(decision.record.generation).toBe(3);
    expect(decision.record.sequence).toBe(10);
    expect(decision.record.continuation).toBeNull();
    expect(decision.record.progress).toBeNull();
    expect(decision.record.error).toBeNull();
    expect(decision.record.recovery).toEqual({
      recoveredBy: "attempt-executor",
      outcome: "complete",
      evidence: {
        installed: { kind: "verified", version: "1.2.3" },
        staged: { kind: "absent", version: null },
        running: { kind: "verified", version: "1.2.3", ownerBound: true },
      },
    });
  });

  it("does not terminalize complete for a running process bound elsewhere (unbound owner), even at the exact version", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: { kind: "unbound", version: "1.2.3" },
          },
        },
      }),
    );
    // `running.kind === "unbound"` at the target is itself a contradiction
    // (§ recoveryEvidenceContradicts), not a silent fall-through to resume.
    expect(decision.kind).toBe("terminalize-failed");
  });
});

describe("decideAttemptRecovery - terminalize-failed: evidence contradictions", () => {
  it("terminalizes failed when installed is positively missing at the target version", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          evidence: {
            installed: { kind: "missing", version: "1.2.3" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
        },
      }),
    );
    expect(decision.kind).toBe("terminalize-failed");
    if (decision.kind !== "terminalize-failed") return;
    expect(decision.record.error?.code).toBe("recovery-evidence-contradiction");
  });

  it("terminalizes failed when staged is positively missing at the target version", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "missing", version: "1.2.3" },
            running: { kind: "absent" },
          },
        },
      }),
    );
    expect(decision.kind).toBe("terminalize-failed");
  });

  it("terminalizes failed when running is unbound at the exact target version", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "unbound", version: "1.2.3" },
          },
        },
      }),
    );
    expect(decision.kind).toBe("terminalize-failed");
  });

  it("terminalizes failed when a host-home-bound running target disagrees with a DIFFERENT verified installed version", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          evidence: {
            installed: { kind: "verified", version: "9.9.9" },
            staged: { kind: "absent" },
            running: {
              kind: "verified",
              version: "1.2.3",
              owner: "host-home-bound",
            },
          },
        },
      }),
    );
    expect(decision.kind).toBe("terminalize-failed");
    if (decision.kind !== "terminalize-failed") return;
    expect(decision.record.error?.message).toContain(
      "install, stage, and running-host evidence disagreed",
    );
  });

  it("does NOT contradict when a missing artifact names a version other than the current target", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          evidence: {
            installed: { kind: "missing", version: "9.9.9" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
        },
      }),
    );
    // No evidence at all for the actual target -> insufficient, not a
    // contradiction.
    expect(decision.kind).toBe("terminalize-failed");
    if (decision.kind !== "terminalize-failed") return;
    expect(decision.record.error?.code).toBe("recovery-evidence-insufficient");
  });
});

describe("decideAttemptRecovery - target change supersedes rather than resuming or terminalizing", () => {
  it("supersedes the old attempt when the requested target has moved on, even with no other evidence", () => {
    const active = makeRecord({
      targetVersion: "1.2.3",
      generation: 4,
      sequence: 11,
    });
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: { requestedTargetVersion: "2.0.0", evidence: NO_EVIDENCE },
      }),
    );
    expect(decision.kind).toBe("supersede");
    if (decision.kind !== "supersede") return;
    expect(decision.record.phase).toBe("superseded");
    expect(decision.record.execution).toBe("terminal");
    expect(decision.record.generation).toBe(5);
    expect(decision.record.sequence).toBe(12);
    expect(decision.superseded).toEqual(attemptIdentityOf(active));
    // The new target is NOT minted here - two durable writes, matching the
    // `decideAttemptClaim` supersede/create split.
    expect(decision.record.targetVersion).toBe("1.2.3");
    // Unlike `decideAttemptClaim`'s own parked-target supersede (which
    // attaches no recovery provenance), a recovery-driven supersede must
    // preserve the evidence that reconciled this attempt.
    expect(decision.record.recovery).toEqual({
      recoveredBy: "attempt-executor",
      outcome: "superseded",
      evidence: {
        installed: { kind: "absent", version: null },
        staged: { kind: "absent", version: null },
        running: { kind: "absent", version: null, ownerBound: false },
      },
    });
  });

  it("terminalizes complete rather than superseding when the OLD target's evidence proves completion", () => {
    // Recovery must not silently "complete" an attempt for a target the
    // caller no longer wants, then separately create the new one - the old
    // target's own evidence match is irrelevant once requestedTargetVersion
    // has moved on for THIS record.
    const active = makeRecord({ targetVersion: "1.2.3" });
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          requestedTargetVersion: "2.0.0",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: {
              kind: "verified",
              version: "1.2.3",
              owner: "host-home-bound",
            },
          },
        },
      }),
    );
    expect(decision.kind).toBe("terminalize-complete");
    // Complete is checked first (installed+running match), which is
    // correct: the old target genuinely finished. Only when it did NOT
    // finish does target-change fall through to supersede.
    if (decision.kind === "terminalize-complete") {
      expect(decision.record.targetVersion).toBe("1.2.3");
    }
  });
});

describe("decideAttemptRecovery - resume-new-generation: continuation choice and precedence", () => {
  it("resumes activate when installed evidence verifies the target (byte placement proven)", () => {
    const active = makeRecord({ generation: 1, sequence: 3 });
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          action: "activate",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
        },
      }),
    );
    expect(decision.kind).toBe("resume-new-generation");
    if (decision.kind !== "resume-new-generation") return;
    expect(decision.continuation).toBe("activate");
    expect(decision.record.phase).toBe("preparing");
    expect(decision.record.execution).toBe("active");
    expect(decision.record.continuation).toBe("activate");
    expect(decision.record.generation).toBe(2);
    expect(decision.record.sequence).toBe(4);
  });

  it("resumes resume-apply when only staged evidence verifies the target", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "verified", version: "1.2.3" },
            running: { kind: "absent" },
          },
        },
      }),
    );
    expect(decision.kind).toBe("resume-new-generation");
    if (decision.kind !== "resume-new-generation") return;
    expect(decision.continuation).toBe("resume-apply");
    expect(decision.record.continuation).toBe("resume-apply");
  });

  it("prefers activate over resume-apply when BOTH installed and staged verify the target", () => {
    // Installed bytes already placed outranks a stale staged artifact -
    // re-applying already-placed bytes would be corruption (§1.5).
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          action: "activate",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "verified", version: "1.2.3" },
            running: { kind: "absent" },
          },
        },
      }),
    );
    expect(decision.kind).toBe("resume-new-generation");
    if (decision.kind !== "resume-new-generation") return;
    expect(decision.continuation).toBe("activate");
  });

  it("terminalizes failed (insufficient) when neither installed nor staged verify the target and nothing contradicts", () => {
    const active = makeRecord({});
    const decision = decideAttemptRecovery(
      recoveryContext({ current: active, request: { evidence: NO_EVIDENCE } }),
    );
    expect(decision.kind).toBe("terminalize-failed");
    if (decision.kind !== "terminalize-failed") return;
    expect(decision.record.error?.code).toBe("recovery-evidence-insufficient");
  });

  it("recovers the C/R collision (installed verified at the SAME target a live process reports as `foreign`) as resume-new-generation/activate, not as an evidence contradiction", () => {
    // §D9/D16: a `foreign` running leg is debt, never a contradiction - no
    // equality in this module accepts it, so `runningTarget` below is false
    // and only `installedTarget` decides the outcome, exactly like the plain
    // "installed verifies, running absent" case above.
    const active = makeRecord({ targetVersion: "1.2.3" });
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          action: "activate",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: { kind: "foreign", runtimeIdentity: "1.2.3" },
          },
        },
      }),
    );
    expect(decision.kind).toBe("resume-new-generation");
    if (decision.kind !== "resume-new-generation") return;
    expect(decision.continuation).toBe("activate");
    expect(decision.record.phase).toBe("preparing");
    expect(decision.record.execution).toBe("active");
  });
});

describe("decideAttemptRecovery - the C/R collision's terminal encoding still reads as a valid leg to the decoder as of dfc9e1521", () => {
  // A frozen copy of `parseRecoveryRunningLeg` EXACTLY as it read before this
  // ticket (`git show 69a4a4d78~1:protocol/src/config/host-update-attempt.ts`,
  // lines 673-696). It must never be "fixed" to know about `runtimeIdentity` -
  // the entire point of lowering `foreign` to `unbound` + the raw identity in
  // `version` is that a reader built before this ticket still accepts the
  // record as a normal `unbound` leg instead of failing closed as corrupt.
  type FrozenLeg =
    | {
        readonly kind: "absent" | "verified" | "unbound" | "unreadable";
        readonly version: string | null;
        readonly ownerBound: boolean;
      }
    | "invalid";

  function frozenNullableNonEmptyString(
    value: unknown,
  ): string | null | "invalid" {
    if (value === undefined) return "invalid";
    if (value === null) return null;
    return typeof value === "string" && value.length > 0 ? value : "invalid";
  }

  function frozenParseRecoveryRunningLeg(value: unknown): FrozenLeg {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return "invalid";
    }
    const raw = value as Record<string, unknown>;
    const version = frozenNullableNonEmptyString(raw.version);
    if (
      version === "invalid" ||
      (raw.kind !== "absent" &&
        raw.kind !== "verified" &&
        raw.kind !== "unbound" &&
        raw.kind !== "unreadable") ||
      ((raw.kind === "verified" || raw.kind === "unbound") &&
        version === null) ||
      ((raw.kind === "absent" || raw.kind === "unreadable") &&
        version !== null) ||
      typeof raw.ownerBound !== "boolean"
    ) {
      return "invalid";
    }
    if (raw.kind !== "verified" && raw.ownerBound) return "invalid";
    return { kind: raw.kind, version, ownerBound: raw.ownerBound };
  }

  it("yields a terminalize-failed/recovery-evidence-insufficient record whose running leg the frozen decoder still reads as a valid unbound leg", () => {
    // Record targets D; installed evidence verifies an UNRELATED old target C
    // (so `recoveryContinuation` offers neither activate nor resume-apply);
    // the request also names D, so this is the `recovery-evidence-insufficient`
    // arm, not the target-change `supersede` arm (that is what a request
    // naming D against a record targeting C would hit instead).
    const active = makeRecord({ targetVersion: "D" });
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: {
          requestedTargetVersion: "D",
          evidence: {
            installed: { kind: "verified", version: "C" },
            staged: { kind: "absent" },
            running: { kind: "foreign", runtimeIdentity: "C" },
          },
        },
      }),
    );
    expect(decision.kind).toBe("terminalize-failed");
    if (decision.kind !== "terminalize-failed") return;
    expect(decision.record.error?.code).toBe("recovery-evidence-insufficient");
    const runningLeg = decision.record.recovery?.evidence.running;

    // The OLD reader's verdict is asserted FIRST, deliberately. It is the
    // property this pin exists for - a record this build writes must still
    // read as a valid leg to a reader that predates `runtimeIdentity` - and
    // asserting the exact new shape ahead of it would make any change to the
    // encoding fail on the shape line, hiding whether the old reader would
    // still have accepted it.
    const frozenResult = frozenParseRecoveryRunningLeg(runningLeg);
    expect(frozenResult).not.toBe("invalid");
    expect(frozenResult).toEqual({
      kind: "unbound",
      version: "C",
      ownerBound: false,
    });

    // The raw identity in `version` is what makes this load-bearing rather
    // than decorative: strip it and the frozen decoder fails closed.
    expect(
      frozenParseRecoveryRunningLeg({ ...runningLeg, version: null }),
    ).toBe("invalid");

    expect(runningLeg).toEqual({
      kind: "unbound",
      version: "C",
      ownerBound: false,
      runtimeIdentity: "C",
    });
  });
});

describe("decideAttemptRecovery - counter-exhausted at the safe-integer ceiling", () => {
  const ceilingRecord = makeRecord({
    generation: Number.MAX_SAFE_INTEGER,
    sequence: 5,
  });

  it("refuses counter-exhausted for a terminalize-complete decision at the generation ceiling", () => {
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: ceilingRecord,
        request: {
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: {
              kind: "verified",
              version: "1.2.3",
              owner: "host-home-bound",
            },
          },
        },
      }),
    );
    expect(decision).toEqual({ kind: "refuse", reason: "counter-exhausted" });
  });

  it("refuses counter-exhausted for a terminalize-failed decision at the generation ceiling", () => {
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: ceilingRecord,
        request: { evidence: NO_EVIDENCE },
      }),
    );
    expect(decision).toEqual({ kind: "refuse", reason: "counter-exhausted" });
  });

  it("refuses counter-exhausted for a supersede decision at the generation ceiling", () => {
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: ceilingRecord,
        request: { requestedTargetVersion: "2.0.0", evidence: NO_EVIDENCE },
      }),
    );
    expect(decision).toEqual({ kind: "refuse", reason: "counter-exhausted" });
  });

  it("refuses counter-exhausted for a resume-new-generation decision at the generation ceiling", () => {
    const decision = decideAttemptRecovery(
      recoveryContext({
        current: ceilingRecord,
        request: {
          action: "activate",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
        },
      }),
    );
    expect(decision).toEqual({ kind: "refuse", reason: "counter-exhausted" });
  });
});

describe("decideAttemptRecovery - request action authorizes only its own continuation", () => {
  const active = makeRecord({});
  const installedVerifiedOnly = {
    installed: { kind: "verified" as const, version: "1.2.3" },
    staged: { kind: "absent" as const },
    running: { kind: "absent" as const },
  };
  const stagedVerifiedOnly = {
    installed: { kind: "absent" as const },
    staged: { kind: "verified" as const, version: "1.2.3" },
    running: { kind: "absent" as const },
  };

  it.each(["start", "resume-apply", "force", "defer"] as const)(
    "refuses request-action-mismatch for action=%s when evidence only offers activate",
    (action) => {
      const decision = decideAttemptRecovery(
        recoveryContext({
          current: active,
          request: { action, evidence: installedVerifiedOnly },
        }),
      );
      expect(decision).toEqual({
        kind: "refuse",
        reason: "request-action-mismatch",
      });
    },
  );

  it.each(["start", "activate", "defer"] as const)(
    "refuses request-action-mismatch for action=%s when evidence only offers resume-apply",
    (action) => {
      const decision = decideAttemptRecovery(
        recoveryContext({
          current: active,
          request: { action, evidence: stagedVerifiedOnly },
        }),
      );
      expect(decision).toEqual({
        kind: "refuse",
        reason: "request-action-mismatch",
      });
    },
  );

  it("a defer request never claims, even when evidence would otherwise support terminalize-complete or a target-change supersede", () => {
    const completeEvidence = {
      installed: { kind: "verified" as const, version: "1.2.3" },
      staged: { kind: "absent" as const },
      running: {
        kind: "verified" as const,
        version: "1.2.3",
        owner: "host-home-bound" as const,
      },
    };
    // Complete/supersede never consult the action - they are reconciliations
    // of physical fact, not claims. `defer` genuinely can reach them; what it
    // must never reach is `resume-new-generation`, which starts new work.
    const completeDecision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: { action: "defer", evidence: completeEvidence },
      }),
    );
    expect(completeDecision.kind).toBe("terminalize-complete");

    const deferDecision = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: { action: "defer", evidence: installedVerifiedOnly },
      }),
    );
    expect(deferDecision).toEqual({
      kind: "refuse",
      reason: "request-action-mismatch",
    });
  });

  it("force may resume resume-apply but not activate; activate may resume activate but not resume-apply", () => {
    const forceResumesApply = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: { action: "force", evidence: stagedVerifiedOnly },
      }),
    );
    expect(forceResumesApply.kind).toBe("resume-new-generation");
    if (forceResumesApply.kind === "resume-new-generation") {
      expect(forceResumesApply.continuation).toBe("resume-apply");
    }

    const activateResumesActivate = decideAttemptRecovery(
      recoveryContext({
        current: active,
        request: { action: "activate", evidence: installedVerifiedOnly },
      }),
    );
    expect(activateResumesActivate.kind).toBe("resume-new-generation");
    if (activateResumesActivate.kind === "resume-new-generation") {
      expect(activateResumesActivate.continuation).toBe("activate");
    }
  });
});
