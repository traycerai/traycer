/**
 * Schemas for the optional automatic worktree-cleanup surface:
 * `worktree.getAutoCleanupPolicy`, `worktree.setAutoCleanupPolicy`,
 * `worktree.listAutoCleanupRuns`, and `worktree.getAutoCleanupRun`.
 *
 * All four are OPTIONAL capabilities (`degrade: { kind: "unsupported" }`),
 * never floor methods: a host that predates them simply lacks the affordance
 * and the GUI renders the controls unavailable. It must never fall back to
 * scheduling cleanup client-side - deletion authority is the host's.
 *
 * What is deliberately NOT here is as much of the contract as what is:
 *
 *  - No eligibility PROOF state. Whether a worktree may be deleted unattended
 *    depends on host-internal freshness and actor evidence (probe outcomes and
 *    their staleness, activity leases, holder inventory, provenance
 *    completeness). Putting any of that on the wire would turn host safety
 *    semantics into a protocol compatibility contract, and would invite a
 *    client to re-derive a verdict the host must own. The wire carries the
 *    RESULT of a cleanup decision, never its evidence.
 *  - No policy scheduling on the client. `lastEvaluatedAt`/`nextEvaluationAt`
 *    are reporting fields for "when did/will this host look", not a schedule a
 *    client is expected to drive.
 *  - `reasonCode` is an OPEN string, not an enum. The host's outcome-reason
 *    ladder is expected to grow with the deletion pipeline; an enum here would
 *    make every new reason a wire break for old GUIs, which is exactly the
 *    response-lane value growth the registry validator forbids on a minor.
 *    A host always pairs it with `displayMessage`, so an unrecognized code
 *    still renders host-composed copy.
 *
 * History is HOST-LOCAL and never cloud-replicated: `worktreePath` is the only
 * path anywhere in these shapes, it identifies a directory on the very host the
 * caller is already talking to, and it exists because a cleanup history that
 * cannot say WHICH worktree was removed is not accountability.
 */
import { z } from "zod";

const idSchema = z.string().min(1);

/**
 * Why a host with an ENABLED policy is not currently evaluating. `null` means
 * evaluation is live. Paused time does not advance `lastEvaluatedAt`, so a
 * client must read this rather than infer a stall from a stale timestamp.
 *
 * A closed enum on the response lane: growing it later needs a new minor whose
 * emission is gated on the negotiated version, exactly like any other
 * host→client value growth. Keep new pause conditions mapped onto these arms
 * unless a genuinely new user action is required to clear them.
 */
export const worktreeAutoCleanupPausedReasonSchema = z.enum([
  // This host has no delegated host credential at all (no host identity), so
  // there is no principal a scheduled deletion could run under.
  "no_host_credential",
  // A credential exists but needs the user to re-authorize it.
  "needs_reauth",
  // The live host credential belongs to a different account than the one that
  // authorized the policy. Authority is never transferred silently.
  "owner_mismatch",
  // Startup reconciliation (holder/lease recovery) did not complete, so the
  // host cannot prove a worktree is unused. Fail closed: delete nothing.
  // Scoped to startup: a durable-activity failure that appears LATER is
  // `activity_plane_unhealthy`, below.
  "startup_reconciliation_failed",
  // The durable worktree-activity plane is unreadable at RUN time - after a
  // clean startup - so the newest activity input to the inactivity age cannot
  // be trusted. Fail closed for the same reason as the startup arm: an
  // unavailable signal is not evidence a worktree is idle.
  //
  // Separate from `startup_reconciliation_failed` because the two differ in
  // what they tell a user: that one means this host never got far enough to
  // evaluate, this one means it was evaluating and stopped. Both clear
  // WITHOUT user action - the host retries and resumes on its own - so no
  // client may offer a repair affordance or schedule anything for either.
  "activity_plane_unhealthy",
]);
export type WorktreeAutoCleanupPausedReason = z.infer<
  typeof worktreeAutoCleanupPausedReasonSchema
>;

/**
 * The host-enforced threshold range, sent so the GUI's control cannot offer a
 * value the host will reject. Bounds are host implementation constants, not
 * user policy - they travel as data precisely so they can move without a
 * protocol change.
 */
export const worktreeAutoCleanupPolicyBoundsSchema = z.object({
  minDays: z.number().int().positive(),
  maxDays: z.number().int().positive(),
});
export type WorktreeAutoCleanupPolicyBounds = z.infer<
  typeof worktreeAutoCleanupPolicyBoundsSchema
>;

/**
 * The one user-controlled setting, per HOST IDENTITY (not per signed-in user).
 *
 * `updatedAt`/`updatedByUserId` are `null` on a host where the policy has never
 * been set - the default-disabled state is not an edit, and inventing an author
 * for it would make the audit trail lie. `revision` increments on every
 * effective update and is the token a queued deletion target is validated
 * against, so a policy change invalidates work already in flight.
 */
export const worktreeAutoCleanupPolicySchema = z.object({
  enabled: z.boolean(),
  // Whole days. Bounds are enforced by the host (see `bounds`), not pinned
  // here: a schema-level ceiling would freeze an implementation constant into
  // the wire contract.
  inactivityDays: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().nullable(),
  updatedByUserId: idSchema.nullable(),
});
export type WorktreeAutoCleanupPolicy = z.infer<
  typeof worktreeAutoCleanupPolicySchema
>;

/**
 * Observable scheduler state. Distinct from the policy because it changes
 * without a user edit - which is also why the host persists it separately from
 * the policy file.
 */
export const worktreeAutoCleanupSchedulerStateSchema = z.object({
  // Last completed evaluation pass, `null` if this host has never evaluated.
  lastEvaluatedAt: z.number().nullable(),
  // When the host next intends to evaluate. `null` while paused or disabled -
  // an absent next check is a real state, not an unknown one.
  nextEvaluationAt: z.number().nullable(),
  pausedReason: worktreeAutoCleanupPausedReasonSchema.nullable(),
});
export type WorktreeAutoCleanupSchedulerState = z.infer<
  typeof worktreeAutoCleanupSchedulerStateSchema
>;

/**
 * What both policy methods answer with: the policy, the scheduler's live view
 * of it, and the bounds the control must respect. One shape for read and write
 * so a successful update never needs a second round trip to re-render.
 */
export const worktreeAutoCleanupPolicyStateSchema = z.object({
  ...worktreeAutoCleanupPolicySchema.shape,
  ...worktreeAutoCleanupSchedulerStateSchema.shape,
  bounds: worktreeAutoCleanupPolicyBoundsSchema,
});
export type WorktreeAutoCleanupPolicyState = z.infer<
  typeof worktreeAutoCleanupPolicyStateSchema
>;

export const worktreeGetAutoCleanupPolicyRequestSchema = z.object({});
export type WorktreeGetAutoCleanupPolicyRequest = z.infer<
  typeof worktreeGetAutoCleanupPolicyRequestSchema
>;

export const worktreeGetAutoCleanupPolicyResponseSchema =
  worktreeAutoCleanupPolicyStateSchema;
export type WorktreeGetAutoCleanupPolicyResponse =
  WorktreeAutoCleanupPolicyState;

/**
 * `expectedRevision` is optimistic concurrency, not decoration: two GUIs (or
 * two devices) editing the same host's policy must not silently overwrite each
 * other, because the loser's setting would keep deleting worktrees. A mismatch
 * is refused with `AUTO_CLEANUP_POLICY_REVISION_CONFLICT`; the client re-reads
 * and re-presents rather than retrying blind.
 *
 * REQUIRED and non-nullable, with no "write unconditionally" lane. A never-set
 * policy is not a special case - it already has a concrete revision, `0`, which
 * `getAutoCleanupPolicy` returns - so an unconditional lane would buy nothing
 * and cost the guarantee: a client that read `0`, went stale while another
 * surface enabled cleanup at revision `1`, and then wrote without an
 * expectation would silently re-enable or re-threshold scheduled DELETION with
 * the host unable to detect the race. Every write states what it believed;
 * the first one states `0`.
 *
 * `inactivityDays` travels even when `enabled` is false so disabling preserves
 * the user's threshold for the next enable.
 */
export const worktreeSetAutoCleanupPolicyRequestSchema = z.object({
  enabled: z.boolean(),
  inactivityDays: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
});
export type WorktreeSetAutoCleanupPolicyRequest = z.infer<
  typeof worktreeSetAutoCleanupPolicyRequestSchema
>;

export const worktreeSetAutoCleanupPolicyResponseSchema =
  worktreeAutoCleanupPolicyStateSchema;
export type WorktreeSetAutoCleanupPolicyResponse =
  WorktreeAutoCleanupPolicyState;

/**
 * A pass either finished, is still running, or was cut short by the host
 * stopping. `interrupted` is TERMINAL for the run record - the next pass starts
 * a new run rather than resuming this one - so a client must never render it as
 * "still working".
 */
export const worktreeAutoCleanupRunStatusSchema = z.enum([
  "running",
  "completed",
  "interrupted",
]);
export type WorktreeAutoCleanupRunStatus = z.infer<
  typeof worktreeAutoCleanupRunStatusSchema
>;

/**
 * One evaluation pass. The counts are the aggregate the notification and the
 * history list both report, and they are recorded by the host as each target
 * settles - so a `running` run already carries partial counts.
 *
 * `evaluatedCount` is how many managed worktrees the pass considered;
 * `candidateCount` how many survived selection and were queued for deletion.
 * The four outcome counts sum to at most `candidateCount` (a still-queued
 * target is in none of them).
 */
export const worktreeAutoCleanupRunSummarySchema = z.object({
  runId: idSchema,
  // The policy revision the pass ran under. A run whose revision no longer
  // matches the live policy explains why its targets were skipped.
  policyRevision: z.number().int().nonnegative(),
  inactivityDays: z.number().int().positive(),
  // The single cutoff captured at pass start, so a long pass judges every
  // target against the same instant.
  cutoffAt: z.number(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  status: worktreeAutoCleanupRunStatusSchema,
  evaluatedCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  interruptedCount: z.number().int().nonnegative(),
  // The pass stopped discovering because it hit its row/wall budget, not
  // because it ran out of worktrees. Distinguishes "nothing left to do" from
  // "more to do soon" without exposing the cursor itself.
  budgetExhausted: z.boolean(),
});
export type WorktreeAutoCleanupRunSummary = z.infer<
  typeof worktreeAutoCleanupRunSummarySchema
>;

/**
 * The tier a target held when it was selected. Only the three GREEN tiers of
 * the shared ladder can ever appear: automatic cleanup never removes a
 * `review`, `orphaned`, or `in-use` worktree, so a wider enum here would
 * advertise a capability that does not exist.
 *
 * Values match `WorktreeTier` in `@traycer/protocol/worktree/classify-worktree`
 * verbatim - the labels the user was shown and the label recorded against a
 * deletion must be the same words.
 */
export const worktreeAutoCleanupEligibleTierSchema = z.enum([
  "merged",
  "at-base-commit",
  "unreferenced",
]);
export type WorktreeAutoCleanupEligibleTier = z.infer<
  typeof worktreeAutoCleanupEligibleTierSchema
>;

/**
 * How one target ended.
 *
 * `skipped` is deliberately NOT a failure: losing eligibility between selection
 * and deletion is the safety engine working as designed (the worktree became
 * dirty, someone opened a terminal in it, the policy changed), and presenting
 * it in failure styling would train users to ignore the one state that means
 * "Traycer could not do an authorized operation" - `failed`.
 *
 * `interrupted` means the host stopped before a terminal result was durably
 * recorded. It is an honest "unconfirmed", never inferred success: the row
 * cannot claim the worktree was deleted just because it is gone now.
 */
export const worktreeAutoCleanupTargetOutcomeSchema = z.enum([
  "deleted",
  "skipped",
  "failed",
  "interrupted",
]);
export type WorktreeAutoCleanupTargetOutcome = z.infer<
  typeof worktreeAutoCleanupTargetOutcomeSchema
>;

/**
 * One worktree a pass acted on.
 *
 * The activity inputs are kept alongside the derived `activityAt` because the
 * single question a user asks of this screen is "why did it think this was
 * inactive" - and the answer is which of the three inputs was newest. The
 * ordinary Settings row shows only the derived value; this detail view is where
 * the inputs earn their place.
 */
export const worktreeAutoCleanupTargetSchema = z.object({
  targetId: idSchema,
  runId: idSchema,
  // Host-local canonical path. The only path in this surface - see the module
  // header on why history stays local.
  worktreePath: z.string().min(1),
  // Display identity, the same "owner/repo"-or-basename label the worktree
  // listing renders, so a history row and a settings row name one repository
  // the same way.
  repoLabel: z.string(),
  // Branch checked out at selection, `null` for a detached target. Automatic
  // cleanup does not select detached worktrees, so `null` here means the label
  // was unavailable, not that a detached worktree was deleted.
  branchLabel: z.string().nullable(),
  tierAtSelection: worktreeAutoCleanupEligibleTierSchema,
  // The authoritative last-activity timestamp the cutoff was applied to:
  // `max(createdAtInput, reflogAtInput, durableActivityInput)`.
  activityAt: z.number(),
  createdAtInput: z.number().nullable(),
  reflogAtInput: z.number().nullable(),
  durableActivityInput: z.number().nullable(),
  // `null` while the target is still queued or executing within a `running`
  // run. A settled target always carries both an outcome and `settledAt`.
  outcome: worktreeAutoCleanupTargetOutcomeSchema.nullable(),
  // Stable host reason code (open string; see the module header) plus the
  // host-composed sentence a client renders when it does not know the code.
  reasonCode: idSchema.nullable(),
  displayMessage: z.string().min(1).nullable(),
  // Best-effort teardown telemetry. Neither value cancels removal; they exist
  // so a user can repair a broken teardown hook they would otherwise never see.
  teardownExitCode: z.number().int().nullable(),
  teardownTimedOut: z.boolean(),
  // Points at an earlier `interrupted` record for the same path that this
  // record resolves, so history collapses the pair into ONE cleanup entry with
  // the unconfirmed attempt as a sub-line instead of showing two deletions.
  supersedesTargetId: idSchema.nullable(),
  settledAt: z.number().nullable(),
});
export type WorktreeAutoCleanupTarget = z.infer<
  typeof worktreeAutoCleanupTargetSchema
>;

/**
 * The host's ceiling on one history page. A client asking for more is a client
 * bug, not a negotiation: history is a local SQLite read whose cost is paid by
 * the same host the user is waiting on.
 */
export const WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT_MAX = 100;
export const WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT_DEFAULT = 25;

/**
 * Cursor pagination over runs, newest first. `cursor` is an opaque host token -
 * clients must not parse or synthesize one; `null` starts at the newest run.
 */
export const worktreeListAutoCleanupRunsRequestSchema = z.object({
  cursor: z.string().min(1).nullable().default(null),
  limit: z
    .number()
    .int()
    .min(1)
    .max(WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT_MAX)
    .default(WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT_DEFAULT),
});
export type WorktreeListAutoCleanupRunsRequest = z.infer<
  typeof worktreeListAutoCleanupRunsRequestSchema
>;

export const worktreeListAutoCleanupRunsResponseSchema = z.object({
  runs: z.array(worktreeAutoCleanupRunSummarySchema),
  // `null` when this page reached the end of retained history.
  nextCursor: z.string().min(1).nullable(),
});
export type WorktreeListAutoCleanupRunsResponse = z.infer<
  typeof worktreeListAutoCleanupRunsResponseSchema
>;

export const worktreeGetAutoCleanupRunRequestSchema = z.object({
  runId: idSchema,
});
export type WorktreeGetAutoCleanupRunRequest = z.infer<
  typeof worktreeGetAutoCleanupRunRequestSchema
>;

/**
 * One run with its targets. `run: null` (and then always `targets: []`, which
 * the refinement below enforces rather than merely asserting here) is the total
 * answer for a run this host does not have - retention GC and a notification
 * that outlives its run both make that an ordinary outcome, not an error.
 *
 * Modeled as an object with a nullable member rather than a nullable ROOT: a
 * union at the root freezes this response against additive growth (every arm is
 * fingerprinted exactly), while an object root can gain optional fields on a
 * minor.
 */
export const worktreeGetAutoCleanupRunResponseSchema = z
  .object({
    run: worktreeAutoCleanupRunSummarySchema.nullable(),
    targets: z.array(worktreeAutoCleanupTargetSchema),
  })
  // The `targets: []` above is a validated invariant, not prose. Targets
  // without their run are unrenderable: every count, threshold, and cutoff a
  // client would explain them with lives on the run summary. Refusing the
  // combination here means a retention GC that dropped a run mid-read fails
  // loudly at the contract instead of reaching the GUI as history with no
  // context.
  .superRefine((response, ctx) => {
    if (response.run === null && response.targets.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message:
          "An absent run carries no targets - `targets` must be empty when `run` is null.",
      });
    }
  });
export type WorktreeGetAutoCleanupRunResponse = z.infer<
  typeof worktreeGetAutoCleanupRunResponseSchema
>;
