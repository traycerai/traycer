import { describe, expect, it } from "vitest";
import {
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/index";
import { RPC_ERROR_CODES } from "@traycer/protocol/framework/versioned-rpc-types";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  worktreeGetAutoCleanupRunRequestSchema,
  worktreeGetAutoCleanupRunResponseSchema,
  worktreeListAutoCleanupRunsRequestSchema,
  worktreeListAutoCleanupRunsResponseSchema,
  worktreeAutoCleanupPausedReasonSchema,
  worktreeAutoCleanupPolicyStateSchema,
  worktreeSetAutoCleanupPolicyRequestSchema,
  WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT_DEFAULT,
  WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT_MAX,
} from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";

/**
 * The automatic worktree-cleanup methods are ADDITIVE and must ride the
 * optional-capabilities channel. Entering the released floor would be
 * handshake-fatal for every peer that shipped before they existed, and the
 * fallback story is the point: a host without them cannot clean up on a
 * schedule at all, so `unsupported` (controls unavailable) is the only honest
 * degrade - a client-side timer would delete worktrees without the host's
 * freshness proof.
 */
const AUTO_CLEANUP_METHODS = [
  "worktree.getAutoCleanupPolicy",
  "worktree.setAutoCleanupPolicy",
  "worktree.listAutoCleanupRuns",
  "worktree.getAutoCleanupRun",
] as const;

describe("worktree auto-cleanup methods are optional, not floor", () => {
  it.each(AUTO_CLEANUP_METHODS)(
    "%s is absent from the released floor and its guarded fixture",
    (method) => {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      expect(releasedMethodNames).not.toContain(method);
    },
  );

  it.each(AUTO_CLEANUP_METHODS)(
    "%s advertises on the optional manifest at 1.0, never the floor manifest",
    (method) => {
      const split = splitConnectionManifest(
        hostRpcRegistry,
        RELEASED_FLOOR_METHOD_NAMES,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      expect(split.optionalManifest[method]).toEqual({
        major: 1,
        minor: 0,
        supportedMajors: [1],
      });
      expect(split.manifest[method]).toBeUndefined();
    },
  );

  it.each(AUTO_CLEANUP_METHODS)(
    "%s degrades as unsupported rather than falling back to a floor method",
    (method) => {
      // A `fallback` degrade would silently answer a policy read with some
      // other method's data; there is no floor method that could stand in for
      // "does this host schedule cleanups", so the absence must be visible.
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
    },
  );
});

describe("auto-cleanup policy schemas", () => {
  const policyState = {
    enabled: true,
    inactivityDays: 30,
    revision: 4,
    updatedAt: 1_700_000_000_000,
    updatedByUserId: "user-1",
    lastEvaluatedAt: 1_700_000_100_000,
    nextEvaluationAt: 1_700_086_500_000,
    pausedReason: null,
    bounds: { minDays: 1, maxDays: 365 },
  };

  it("accepts a live policy state", () => {
    expect(worktreeAutoCleanupPolicyStateSchema.parse(policyState)).toEqual(
      policyState,
    );
  });

  it("accepts a host that has never had a policy set", () => {
    // Default-disabled is not an edit, so it has no author and no timestamp.
    // Modelling those as required would force a host to invent an audit trail.
    const untouched = {
      ...policyState,
      enabled: false,
      revision: 0,
      updatedAt: null,
      updatedByUserId: null,
      lastEvaluatedAt: null,
      nextEvaluationAt: null,
    };
    expect(worktreeAutoCleanupPolicyStateSchema.parse(untouched)).toEqual(
      untouched,
    );
  });

  it("carries each paused reason and rejects an unknown one", () => {
    // Pinned as an exact set, not a spot check: this enum sits on the RESPONSE
    // lane, where a value the negotiated peer has never seen fails its strict
    // parse outright. Growing it is a deliberate act that has to edit this
    // list, not something a new arm can slip past.
    expect(worktreeAutoCleanupPausedReasonSchema.options).toEqual([
      "no_host_credential",
      "needs_reauth",
      "owner_mismatch",
      "startup_reconciliation_failed",
      "activity_plane_unhealthy",
    ]);
    for (const pausedReason of worktreeAutoCleanupPausedReasonSchema.options) {
      expect(
        worktreeAutoCleanupPolicyStateSchema.safeParse({
          ...policyState,
          pausedReason,
        }).success,
      ).toBe(true);
    }
    expect(
      worktreeAutoCleanupPolicyStateSchema.safeParse({
        ...policyState,
        pausedReason: "vacation",
      }).success,
    ).toBe(false);
  });

  it("distinguishes a run-time activity-plane failure from a startup failure", () => {
    // Both are fail-closed pauses over the same missing evidence, and both
    // clear with no user action - the host retries and resumes. What differs
    // is what a user is told: `startup_reconciliation_failed` means this host
    // never got far enough to evaluate, `activity_plane_unhealthy` means it
    // was evaluating and stopped. Collapsing them would make the second read
    // as a boot problem on a host that booted fine.
    for (const pausedReason of [
      "startup_reconciliation_failed",
      "activity_plane_unhealthy",
    ] as const) {
      const paused = worktreeAutoCleanupPolicyStateSchema.parse({
        ...policyState,
        pausedReason,
        // Paused time does not advance the schedule, and a paused host names
        // no next check - a client must read `pausedReason` rather than infer
        // a stall from timestamps.
        nextEvaluationAt: null,
      });
      expect(paused.pausedReason).toBe(pausedReason);
      expect(paused.nextEvaluationAt).toBeNull();
      // The policy itself is untouched by a pause: cleanup resumes on the
      // user's existing setting, so nothing here invites a client to re-write
      // the policy as a "recovery" action.
      expect(paused.enabled).toBe(true);
      expect(paused.revision).toBe(policyState.revision);
    }
  });

  it("rejects a non-positive or fractional threshold without pinning the host's bounds", () => {
    const write = {
      enabled: true,
      inactivityDays: 30,
      expectedRevision: 4,
    };
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse(write).success,
    ).toBe(true);
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse({
        ...write,
        inactivityDays: 0,
      }).success,
    ).toBe(false);
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse({
        ...write,
        inactivityDays: 1.5,
      }).success,
    ).toBe(false);
    // The BOUND itself is host-enforced, not schema-enforced: a wire ceiling
    // would freeze an implementation constant into the contract, so a value
    // outside today's bounds must still parse and be refused by the host.
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse({
        ...write,
        inactivityDays: 3_650,
      }).success,
    ).toBe(true);
  });

  it("has a typed revision-conflict code so a stale write is not retried blind", () => {
    expect(RPC_ERROR_CODES).toContain("AUTO_CLEANUP_POLICY_REVISION_CONFLICT");
  });

  it("admits no unconditional write lane - every write states the revision it believed", () => {
    const write = { enabled: true, inactivityDays: 30, expectedRevision: 4 };
    // The race this closes: a client reads the untouched revision 0, another
    // surface enables cleanup (revision 1), and the first client writes with
    // "no expectation" - silently re-enabling or re-thresholding scheduled
    // DELETION with the host unable to detect the overwrite. A never-set
    // policy is not a special case; it already has a concrete revision.
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse({
        ...write,
        expectedRevision: null,
      }).success,
    ).toBe(false);
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse({
        enabled: write.enabled,
        inactivityDays: write.inactivityDays,
      }).success,
    ).toBe(false);
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse({
        ...write,
        expectedRevision: -1,
      }).success,
    ).toBe(false);
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse({
        ...write,
        expectedRevision: 1.5,
      }).success,
    ).toBe(false);
    // The FIRST write is the case the nullable form existed for, and it is
    // expressible without it: `getAutoCleanupPolicy` on an untouched host
    // returns revision 0, and 0 is what that write expects.
    expect(
      worktreeSetAutoCleanupPolicyRequestSchema.safeParse({
        ...write,
        expectedRevision: 0,
      }).success,
    ).toBe(true);
    expect(
      worktreeAutoCleanupPolicyStateSchema.parse({
        ...policyState,
        enabled: false,
        revision: 0,
        updatedAt: null,
        updatedByUserId: null,
      }).revision,
    ).toBe(0);
  });
});

describe("auto-cleanup history schemas", () => {
  const run = {
    runId: "run-1",
    policyRevision: 4,
    inactivityDays: 30,
    cutoffAt: 1_697_408_000_000,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_030_000,
    status: "completed" as const,
    evaluatedCount: 12,
    candidateCount: 3,
    deletedCount: 2,
    skippedCount: 1,
    failedCount: 0,
    interruptedCount: 0,
    budgetExhausted: false,
  };

  const target = {
    targetId: "target-1",
    runId: "run-1",
    worktreePath: "/Users/dev/.traycer/worktrees/acme-web-1",
    repoLabel: "acme/web",
    branchLabel: "traycer/feature",
    tierAtSelection: "merged" as const,
    activityAt: 1_690_000_000_000,
    createdAtInput: 1_680_000_000_000,
    reflogAtInput: 1_690_000_000_000,
    durableActivityInput: 1_685_000_000_000,
    outcome: "deleted" as const,
    reasonCode: null,
    displayMessage: null,
    teardownExitCode: null,
    teardownTimedOut: false,
    supersedesTargetId: null,
    settledAt: 1_700_000_020_000,
  };

  it("defaults a first history page to the host's own page size", () => {
    expect(worktreeListAutoCleanupRunsRequestSchema.parse({})).toEqual({
      cursor: null,
      limit: WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT_DEFAULT,
    });
    expect(
      worktreeListAutoCleanupRunsRequestSchema.safeParse({
        cursor: null,
        limit: WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it("parses a page of run summaries", () => {
    const page = { runs: [run], nextCursor: "cursor-1" };
    expect(worktreeListAutoCleanupRunsResponseSchema.parse(page)).toEqual(page);
  });

  it("accepts an in-flight run whose targets have not settled", () => {
    // A `running` run is readable, so a queued target must be expressible with
    // no outcome yet. Forcing one would make the GUI invent a verdict.
    const pending = {
      run: { ...run, status: "running" as const, completedAt: null },
      targets: [
        {
          ...target,
          outcome: null,
          settledAt: null,
        },
      ],
    };
    expect(worktreeGetAutoCleanupRunResponseSchema.parse(pending)).toEqual(
      pending,
    );
  });

  it("expresses an interrupted attempt superseded by a later record", () => {
    const recovered = {
      run,
      targets: [
        {
          ...target,
          targetId: "target-0",
          outcome: "interrupted" as const,
          reasonCode: "host_stopped",
          displayMessage: "Host stopped during cleanup",
        },
        {
          ...target,
          targetId: "target-2",
          outcome: "skipped" as const,
          reasonCode: "target_absent",
          displayMessage: "The worktree was already gone",
          supersedesTargetId: "target-0",
        },
      ],
    };
    expect(worktreeGetAutoCleanupRunResponseSchema.parse(recovered)).toEqual(
      recovered,
    );
  });

  it("answers a run this host no longer retains without an error", () => {
    // Retention GC bounds history, and a notification outlives its run - so
    // "gone" is an ordinary answer, not a failure.
    expect(
      worktreeGetAutoCleanupRunResponseSchema.parse({
        run: null,
        targets: [],
      }),
    ).toEqual({ run: null, targets: [] });
    expect(
      worktreeGetAutoCleanupRunRequestSchema.safeParse({ runId: "" }).success,
    ).toBe(false);
  });

  it("refuses targets orphaned from their run", () => {
    // The absent-run answer is `{ run: null, targets: [] }` and nothing else.
    // Targets without their summary are unrenderable - every count, threshold,
    // and cutoff a client would explain them with lives on the run - so the
    // contract refuses the pair rather than letting a GC that dropped a run
    // mid-read reach the GUI as history with no context.
    expect(
      worktreeGetAutoCleanupRunResponseSchema.safeParse({
        run: null,
        targets: [target],
      }).success,
    ).toBe(false);
  });

  it("only admits the three green tiers as a selection tier", () => {
    // Automatic cleanup never removes a Review, Orphaned, or In-use worktree.
    // A wider enum here would advertise a capability that does not exist.
    for (const tierAtSelection of [
      "merged",
      "at-base-commit",
      "unreferenced",
    ] as const) {
      expect(
        worktreeGetAutoCleanupRunResponseSchema.safeParse({
          run,
          targets: [{ ...target, tierAtSelection }],
        }).success,
      ).toBe(true);
    }
    for (const tierAtSelection of ["review", "orphaned", "in-use"]) {
      expect(
        worktreeGetAutoCleanupRunResponseSchema.safeParse({
          run,
          targets: [{ ...target, tierAtSelection }],
        }).success,
      ).toBe(false);
    }
  });

  it("keeps reason codes an open string so a newer host's reason still renders", () => {
    // The host's reason ladder grows with the deletion pipeline; an enum here
    // would make each new reason a wire break for older GUIs, which then have
    // `displayMessage` to fall back on.
    expect(
      worktreeGetAutoCleanupRunResponseSchema.safeParse({
        run,
        targets: [
          {
            ...target,
            outcome: "skipped" as const,
            reasonCode: "not_eligible:some_future_sub_reason",
            displayMessage: "No longer eligible",
          },
        ],
      }).success,
    ).toBe(true);
  });
});
