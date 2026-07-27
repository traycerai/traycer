/**
 * Schemas for the `pr.*` host stream surface - the Epic PR View's list and
 * detail subscriptions.
 *
 * `pr.subscribeListForEpic` carries light per-PR summaries for every PR
 * derived from an epic's chats/worktree bindings. `pr.subscribeDetail`
 * carries the heavy per-PR facts (body, checks, comments/reviews) for one
 * PR at a time, keyed by its GitHub base coordinates.
 *
 * `githubHost` is reserved on every shape from v1.0 even though v1 sweeps
 * github.com only (decision #12) - so multi-host support is additive later
 * rather than a wire break. `sourceStatus` reflects the outcome of the sweep
 * that produced a frame; `liveness` is a per-PR fact (network eligibility)
 * that persists across sweeps.
 */
import { z } from "zod";
import { worktreeBindingOwnerKindSchema } from "./worktree-schemas";

// ---- Shared building blocks ---------------------------------------------- //

/**
 * Per-frame sweep outcome. `cached` marks hydration snapshots and cache-only
 * re-emits where no sweep was attempted; the other four mirror the
 * structured `GhSweepOutcome` union the host runner returns. Participates in
 * the host's emission fingerprint so an `error`/`gh-unavailable` recovery to
 * `ok` always emits, even when the underlying facts are unchanged.
 */
export const prSourceStatusSchema = z.enum([
  "ok",
  "partial",
  "gh-unavailable",
  "error",
  "cached",
]);
export type PrSourceStatus = z.infer<typeof prSourceStatusSchema>;

/**
 * Network eligibility for a PR, NOT connectivity health. `cache-only` marks
 * GHES/unknown-host PRs the policy never sweeps by design; a github.com PR
 * that simply hasn't been swept yet is still `live` (its frames carry
 * `sourceStatus: "cached"` until the first sweep lands).
 */
export const prLivenessSchema = z.enum(["live", "cache-only"]);
export type PrLiveness = z.infer<typeof prLivenessSchema>;

export const prStateSchema = z.enum(["open", "merged", "closed"]);
export type PrState = z.infer<typeof prStateSchema>;

export const prReviewDecisionSchema = z.enum([
  "approved",
  "changes_requested",
  "review_required",
]);
export type PrReviewDecision = z.infer<typeof prReviewDecisionSchema>;

export const prChecksRollupSchema = z.object({
  success: z.number().int().nonnegative(),
  failure: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type PrChecksRollup = z.infer<typeof prChecksRollupSchema>;

/**
 * The PR's *base* GitHub coordinates - owner/repo/prNumber of the repo the
 * PR targets, never the fork/head repo. Nullable AS A GROUP on the light
 * item (see the unknown-base rule below): a positive fact can lack these
 * when discovery only proved head identity (absent/unparseable `prUrl`), and
 * substituting head owner/repo would misidentify a fork PR.
 */
export const prBaseCoordinatesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
});
export type PrBaseCoordinates = z.infer<typeof prBaseCoordinatesSchema>;

/**
 * The local repo a PR is grouped under in the panel (paired internal +
 * OSS-submodule PRs land adjacent) - derived per list projection from the
 * owning chat's worktree binding, independent of the PR's own base
 * coordinates (which may point at an upstream fork owner).
 */
export const prRepoIdentifierSchema = z.object({
  owner: z.string(),
  repo: z.string(),
});
export type PrRepoIdentifier = z.infer<typeof prRepoIdentifierSchema>;

/**
 * Which side of a worktree binding entry a row was enumerated from: the
 * entry's own repo (`superproject`) or one of its owned submodule branches
 * (`submodule`). The GUI nests a `submodule` row under the `superproject` row
 * it shares a {@link prLinkGroupKeySchema} with, so a paired
 * internal+OSS-submodule change reads as one piece of work rather than two
 * unrelated repo groups.
 *
 * A repo is only `submodule` RELATIVE TO a binding entry - the same repo bound
 * directly as its own workspace enumerates as `superproject`. When one PR is
 * reachable both ways, `superproject` wins so the row keeps its own group.
 */
export const prRepoRoleSchema = z.enum(["superproject", "submodule"]);
export type PrRepoRole = z.infer<typeof prRepoRoleSchema>;

/**
 * Opaque token shared by every PR enumerated from the SAME worktree binding
 * entry - the entry's superproject PR and each of its owned-submodule PRs.
 * Display-hostile by design (it is the entry's local running directory): the
 * client groups on it and never renders it. `null` when the entry has no
 * stable local path, which only suppresses nesting - both rows still list.
 */
export const prLinkGroupKeySchema = z.string();

export const prOwnerRefSchema = z.object({
  ownerId: z.string(),
  ownerKind: worktreeBindingOwnerKindSchema,
});
export type PrOwnerRef = z.infer<typeof prOwnerRefSchema>;

export const prActorSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().nullable(),
});
export type PrActor = z.infer<typeof prActorSchema>;

export const prReviewRequestSchema = prActorSchema.extend({
  kind: z.enum(["user", "team"]),
});
export type PrReviewRequest = z.infer<typeof prReviewRequestSchema>;

// ---- pr.subscribeListForEpic ---------------------------------------------- //

export const prSubscribeListForEpicModeSchema = z.enum([
  "foreground",
  "background",
]);
export type PrSubscribeListForEpicMode = z.infer<
  typeof prSubscribeListForEpicModeSchema
>;

export const prSubscribeListForEpicOpenRequestSchema = z.object({
  epicId: z.string(),
  mode: prSubscribeListForEpicModeSchema,
});
export type PrSubscribeListForEpicOpenRequest = z.infer<
  typeof prSubscribeListForEpicOpenRequestSchema
>;

/**
 * One PR row on the list stream. `base` is nullable as a whole group (see
 * `prBaseCoordinatesSchema`) - a `null` base marks a list-only row rendered
 * from head identity alone (no tile affordance, no persisted selection).
 * Every enrichment field below `liveness` is independently nullable so a
 * cache-only or never-swept item still renders from identity + state alone.
 */
export const prLightItemSchema = z.object({
  githubHost: z.string().nullable(),
  base: prBaseCoordinatesSchema.nullable(),
  prUrl: z.string().nullable(),
  state: prStateSchema,
  liveness: prLivenessSchema,
  observedAt: z.number().nullable(),
  isDraft: z.boolean().nullable(),
  title: z.string().nullable(),
  baseRefName: z.string().nullable(),
  headRefName: z.string().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  checksRollup: prChecksRollupSchema.nullable(),
  reviewDecision: prReviewDecisionSchema.nullable(),
  commentCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().nullable(),
  repoIdentifier: prRepoIdentifierSchema,
  repoRole: prRepoRoleSchema,
  linkGroupKey: prLinkGroupKeySchema.nullable(),
  owners: z.array(prOwnerRefSchema),
});
export type PrLightItem = z.infer<typeof prLightItemSchema>;

const PR_SUBSCRIBE_LIST_FOR_EPIC_FRAME_FIELDS = {
  hasBinaryPayload: z.literal(false),
  sourceStatus: prSourceStatusSchema,
  items: z.array(prLightItemSchema),
} as const;

export const prSubscribeListForEpicServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...PR_SUBSCRIBE_LIST_FOR_EPIC_FRAME_FIELDS,
    }),
    z.object({
      kind: z.literal("updated"),
      ...PR_SUBSCRIBE_LIST_FOR_EPIC_FRAME_FIELDS,
    }),
    z.object({
      kind: z.literal("error"),
      hasBinaryPayload: z.literal(false),
      message: z.string(),
      isFatal: z.boolean(),
    }),
  ],
);
export type PrSubscribeListForEpicServerFrame = z.infer<
  typeof prSubscribeListForEpicServerFrameSchema
>;

// ---- pr.subscribeDetail --------------------------------------------------- //

export const prSubscribeDetailOpenRequestSchema = z.object({
  epicId: z.string(),
  githubHost: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
});
export type PrSubscribeDetailOpenRequest = z.infer<
  typeof prSubscribeDetailOpenRequestSchema
>;

export const prCheckStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "pending",
  "requested",
  "waiting",
]);
export type PrCheckStatus = z.infer<typeof prCheckStatusSchema>;

export const prCheckConclusionSchema = z.enum([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);
export type PrCheckConclusion = z.infer<typeof prCheckConclusionSchema>;

export const prCheckContextSchema = z.object({
  /**
   * The JOB name alone (`build`, `pre-commit`) - which is not unique. A repo
   * running one reusable workflow across five packages reports `build` five
   * times, and a list keyed on this shows five identical rows. See
   * {@link prCheckContextSchema.workflowName}.
   */
  name: z.string(),
  /**
   * The workflow the job belongs to (`Run Pre-commit`), or `null` for a check
   * that did not come from a workflow run at all - a third-party app's check,
   * or a commit status. Together with `name` and `event` this reconstructs the
   * identity GitHub displays, and is what makes five `build` rows tellable
   * apart.
   */
  workflowName: z.string().nullable(),
  /** What triggered the run (`pull_request`). `null` outside a workflow run. */
  event: z.string().nullable(),
  /** The app that reported it - "GitHub Actions", "Mintlify", "CodeRabbit". */
  appName: z.string().nullable(),
  /**
   * The reporting app's icon. A check list is scanned, not read: the app mark
   * is what lets a reader find the one CodeRabbit row among fourteen Actions
   * rows without parsing any text.
   */
  appLogoUrl: z.string().nullable(),
  /**
   * The one-line reason a commit status carries ("Review completed",
   * "Skipping deployment"). Only `StatusContext` has this; a `CheckRun` has no
   * equivalent field and reports `null`.
   */
  description: z.string().nullable(),
  status: prCheckStatusSchema,
  conclusion: prCheckConclusionSchema.nullable(),
  detailsUrl: z.string().nullable(),
});
export type PrCheckContext = z.infer<typeof prCheckContextSchema>;

/**
 * `checks` section of a detail frame - the first 50 check contexts plus a
 * truncation marker. `observedAt` is `null` for a row that has never been
 * swept (cache-only or not-yet-observed).
 */
export const prChecksSectionSchema = z.object({
  observedAt: z.number().nullable(),
  contexts: z.array(prCheckContextSchema).max(50),
  isTruncated: z.boolean(),
});
export type PrChecksSection = z.infer<typeof prChecksSectionSchema>;

export const prReviewStateSchema = z.enum([
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
  "pending",
]);
export type PrReviewState = z.infer<typeof prReviewStateSchema>;

/**
 * One entry in the chronological activity feed - an issue comment or a
 * submitted review, interleaved by `createdAt`.
 */
export const prActivityItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("comment"),
    id: z.string(),
    author: prActorSchema.nullable(),
    body: z.string(),
    createdAt: z.number(),
  }),
  z.object({
    kind: z.literal("review"),
    /**
     * GitHub's review node id where one is known, so a
     * {@link prReviewThreadSchema} can name the review that submitted it.
     * Falls back to the review's url, then to a synthetic key, for facts
     * persisted before the id was captured - a thread then simply fails to
     * match and renders un-nested.
     */
    id: z.string(),
    author: prActorSchema.nullable(),
    body: z.string(),
    state: prReviewStateSchema,
    createdAt: z.number(),
  }),
]);
export type PrActivityItem = z.infer<typeof prActivityItemSchema>;

/**
 * `activity` section of a detail frame - the last ~20 comments and reviews,
 * chronological, full bodies (decision #11).
 */
export const prActivitySectionSchema = z.object({
  observedAt: z.number().nullable(),
  items: z.array(prActivityItemSchema).max(20),
  isTruncated: z.boolean(),
});
export type PrActivitySection = z.infer<typeof prActivitySectionSchema>;

// ---- review threads (inline comments) ------------------------------------ //

/** Which side of the diff a thread is anchored to. */
export const prReviewThreadSideSchema = z.enum(["left", "right"]);
export type PrReviewThreadSide = z.infer<typeof prReviewThreadSideSchema>;

/**
 * What a thread is attached to. `line` is the ordinary case; `file` is a
 * comment on the file as a whole, which carries no line at all.
 */
export const prReviewThreadSubjectSchema = z.enum(["line", "file"]);
export type PrReviewThreadSubject = z.infer<typeof prReviewThreadSubjectSchema>;

/** One message in a thread. Threads are replies, so there are usually several. */
export const prReviewThreadCommentSchema = z.object({
  id: z.string(),
  author: prActorSchema.nullable(),
  body: z.string(),
  createdAt: z.number(),
  url: z.string().nullable(),
});
export type PrReviewThreadComment = z.infer<typeof prReviewThreadCommentSchema>;

/**
 * One inline review thread: a place in the diff plus the conversation about it.
 *
 * This is where a bot review's actual findings live. A review's `body` is only
 * its preamble - CodeRabbit's is literally "Actionable comments posted: 5" -
 * and the five findings are five threads. Carrying reviews without threads
 * therefore renders the count and hides the content, which is what it did.
 *
 * `reviewId` is the join back to the review that submitted it (GitHub's
 * `PullRequestReviewComment.pullRequestReview.id`). Nullable because a thread
 * can outlive the 20-review window, and because a fact persisted before this
 * field existed has no review id to match - both cases render the thread
 * un-nested rather than dropping it.
 */
export const prReviewThreadSchema = z.object({
  id: z.string(),
  reviewId: z.string().nullable(),
  path: z.string(),
  /**
   * The line in the CURRENT head. GitHub returns `null` for an outdated
   * thread - the code it referred to has since moved or gone - which is
   * exactly when {@link originalLine} is the only anchor left.
   */
  line: z.number().int().nullable(),
  /** The line as of the commit reviewed. Present even when `line` is not. */
  originalLine: z.number().int().nullable(),
  side: prReviewThreadSideSchema,
  subject: prReviewThreadSubjectSchema,
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  /**
   * The tail of the diff hunk the thread is anchored to, or `null`.
   *
   * Carried ONCE per thread and truncated to its last few lines. GitHub
   * repeats the full hunk verbatim on every comment in the thread, and for a
   * comment on a new file that hunk is the entire file: measured over one real
   * PR it was 2.7x the weight of every comment body combined, and two thirds
   * of the whole payload.
   */
  diffHunk: z.string().nullable(),
  comments: z.array(prReviewThreadCommentSchema).max(10),
  /** True count, so a clipped thread can say how many replies it is hiding. */
  totalCommentCount: z.number().int().nonnegative(),
});
export type PrReviewThread = z.infer<typeof prReviewThreadSchema>;

/**
 * `reviewThreads` section of a detail frame.
 *
 * Kept OUT of {@link prActivitySectionSchema} deliberately. That section is a
 * chronological conversation whose members have no file, no line and no
 * resolved state; a thread has all three, and one bot review can contribute
 * twenty of them. Merged in, twenty findings would drown two human comments,
 * blow the section's own 20-item cap, and force every consumer that walks
 * `activity.items` (the attention queue, the reviewer roll-up) to learn a
 * third kind it has no use for.
 */
export const prReviewThreadsSectionSchema = z.object({
  observedAt: z.number().nullable(),
  threads: z.array(prReviewThreadSchema).max(20),
  isTruncated: z.boolean(),
});
export type PrReviewThreadsSection = z.infer<
  typeof prReviewThreadsSectionSchema
>;

/** GraphQL `PullRequestChangedFile.changeType`, lowercased. */
export const prFileChangeTypeSchema = z.enum([
  "added",
  "deleted",
  "modified",
  "renamed",
  "copied",
  "changed",
]);
export type PrFileChangeType = z.infer<typeof prFileChangeTypeSchema>;

export const prChangedFileSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  changeType: prFileChangeTypeSchema.nullable(),
});
export type PrChangedFile = z.infer<typeof prChangedFileSchema>;

/**
 * `files` section of a detail frame - the first 100 changed files (names and
 * per-file counts only; patch content is deliberately not carried in v1).
 */
export const prFilesSectionSchema = z.object({
  observedAt: z.number().nullable(),
  files: z.array(prChangedFileSchema).max(100),
  totalCount: z.number().int().nonnegative().nullable(),
  isTruncated: z.boolean(),
});
export type PrFilesSection = z.infer<typeof prFilesSectionSchema>;

/**
 * One commit on the PR. `author` is the GitHub user when resolvable;
 * `authorName` falls back to the git author string for unlinked commits.
 */
export const prCommitSchema = z.object({
  oid: z.string(),
  messageHeadline: z.string().nullable(),
  author: prActorSchema.nullable(),
  authorName: z.string().nullable(),
  committedAt: z.number().nullable(),
});
export type PrCommit = z.infer<typeof prCommitSchema>;

/** `commits` section of a detail frame - the last 30 commits, chronological. */
export const prCommitsSectionSchema = z.object({
  observedAt: z.number().nullable(),
  commits: z.array(prCommitSchema).max(30),
  totalCount: z.number().int().nonnegative().nullable(),
  isTruncated: z.boolean(),
});
export type PrCommitsSection = z.infer<typeof prCommitsSectionSchema>;

/**
 * `core` section of a detail frame - the light fields plus the heavy-only
 * overview fields (body, author, reviewers/review requests, headRefOid,
 * mergedAt). Unlike the light item's `base`, `owner`/`repo`/`prNumber` here
 * are never null: a detail subscription only ever opens for a fully
 * identified PR (its base coordinates are the subscription's own open-request
 * key).
 */
export const prDetailCoreSchema = z.object({
  observedAt: z.number().nullable(),
  githubHost: z.string(),
  base: prBaseCoordinatesSchema,
  prUrl: z.string().nullable(),
  state: prStateSchema,
  isDraft: z.boolean().nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  author: prActorSchema.nullable(),
  baseRefName: z.string().nullable(),
  headRefName: z.string().nullable(),
  headRefOid: z.string().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  checksRollup: prChecksRollupSchema.nullable(),
  reviewDecision: prReviewDecisionSchema.nullable(),
  reviewRequests: z.array(prReviewRequestSchema),
  commentCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().nullable(),
  mergedAt: z.number().nullable(),
  repoIdentifier: prRepoIdentifierSchema,
  // Carried for `pr.getLocalDiff`, which needs to name WHICH checkout and
  // which repo under it. Both were already on the light item; the detail
  // stream re-states them so a tile opened straight from a deep link (with no
  // list frame ever received) can still ask for the local diff.
  repoRole: prRepoRoleSchema,
  linkGroupKey: prLinkGroupKeySchema.nullable(),
  owners: z.array(prOwnerRefSchema),
});
export type PrDetailCore = z.infer<typeof prDetailCoreSchema>;

const PR_SUBSCRIBE_DETAIL_FRAME_FIELDS = {
  hasBinaryPayload: z.literal(false),
  sourceStatus: prSourceStatusSchema,
  liveness: prLivenessSchema,
  core: prDetailCoreSchema,
  checks: prChecksSectionSchema,
  activity: prActivitySectionSchema,
  reviewThreads: prReviewThreadsSectionSchema,
  files: prFilesSectionSchema,
  commits: prCommitsSectionSchema,
} as const;

export const prSubscribeDetailServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    ...PR_SUBSCRIBE_DETAIL_FRAME_FIELDS,
  }),
  z.object({
    kind: z.literal("updated"),
    ...PR_SUBSCRIBE_DETAIL_FRAME_FIELDS,
  }),
  z.object({
    kind: z.literal("error"),
    hasBinaryPayload: z.literal(false),
    message: z.string(),
    isFatal: z.boolean(),
  }),
]);
export type PrSubscribeDetailServerFrame = z.infer<
  typeof prSubscribeDetailServerFrameSchema
>;

// ---- Shared client frame --------------------------------------------------- //

/**
 * Client frame shared by both `pr.*` streams: a manual refresh request.
 * Concurrent refreshes coalesce single-flight into at most one trailing
 * sweep (host-side); the wire shape is identical on both methods.
 */
export const prSubscribeClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("refresh"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type PrSubscribeClientFrame = z.infer<
  typeof prSubscribeClientFrameSchema
>;

// ---- `pr.getLocalDiff` ---------------------------------------------------- //

/**
 * Default byte cap for one range-diff sweep. Deliberately larger than the
 * per-file `git.getFileDiff` budget: this is ONE call carrying a whole PR,
 * and a PR whose full patch exceeds 2MiB is one no reader was going to read
 * inline anyway - it truncates and points at GitHub.
 */
export const DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET = 2 * 1_048_576;

/**
 * Why a PR has no local diff. Each value is a DIFFERENT sentence to the
 * reader, which is the whole reason this isn't a boolean: "you have no
 * checkout of this PR" and "your checkout never fetched the base branch" want
 * different next actions.
 */
export const prLocalDiffUnavailableReasonSchema = z.enum([
  // The `linkGroupKey` matches no worktree binding on this host, or the
  // directory it named is gone. Includes the case of a client that made the
  // key up: keys are only ever honoured when a persisted binding vouches for
  // them (they are local paths, so an unchecked key would be a read primitive).
  "no-local-checkout",
  // A checkout was found but it isn't this PR's repo - a submodule that was
  // never initialized, or a binding whose remote has since been re-pointed.
  "repo-mismatch",
  // The checkout exists but one of the two endpoints isn't in it: an
  // un-fetched base branch, or a head branch that was deleted after merge.
  "ref-unavailable",
  // Endpoints resolve but share no history, so there is no merge base to
  // diff from - a force-pushed rewrite, or a branch grafted from elsewhere.
  "no-merge-base",
  // git itself is unusable here (absent, or the repo is refused as too large).
  "git-unavailable",
]);
export type PrLocalDiffUnavailableReason = z.infer<
  typeof prLocalDiffUnavailableReasonSchema
>;

/**
 * `pr.getLocalDiff` request - a ref-RANGE diff, run by the host against the
 * local checkout a PR was pushed from.
 *
 * `linkGroupKey` is the same opaque token the list/detail streams already
 * carry (see {@link prLinkGroupKeySchema}); the host resolves it back to a
 * directory itself rather than accepting a path from the client. `repoRole`
 * and `repoIdentifier` disambiguate WHICH repo under that key is meant, since
 * one key covers a superproject and every submodule it owns.
 *
 * `epicId` gates this the same way the two `pr.*` streams do: the caller must
 * hold SOME role on the named epic, and the resolved checkout must itself
 * belong to that epic. Without it, a caller who merely knows another epic's
 * `linkGroupKey` (an opaque token, not a secret) could read that epic's local
 * diff despite having no role on it.
 *
 * `expectedHeadOid` is GitHub's tip. The host never uses it to select refs -
 * it only reports the local tip back, so the client can say "your checkout is
 * N commits from what GitHub is showing" instead of quietly rendering a diff
 * of something else.
 */
export const prGetLocalDiffRequestSchema = z.object({
  // No `hostId`: like the two `pr.*` streams, and unlike `git.*`, the host it
  // runs on is the only host it could mean - taking one as an argument would
  // invite a caller to believe it selects something.
  epicId: z.string().min(1),
  linkGroupKey: prLinkGroupKeySchema,
  repoIdentifier: prRepoIdentifierSchema,
  repoRole: prRepoRoleSchema,
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  expectedHeadOid: z.string().nullable(),
  ignoreWhitespace: z.boolean(),
  byteBudget: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET),
});
export type PrGetLocalDiffRequest = z.infer<typeof prGetLocalDiffRequestSchema>;

/**
 * One file in the range. Metadata comes from `--name-status` + `--numstat`,
 * which cover EVERY file in the range; `patch` comes from the byte-capped
 * patch sweep, so it is `null` for files the budget never reached. That split
 * is deliberate: a truncated response still knows the true file count and
 * per-file line counts, so the UI can say what it is not showing.
 */
export const prLocalDiffFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: prFileChangeTypeSchema,
  insertions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  isBinary: z.boolean(),
  patch: z.string().nullable(),
});
export type PrLocalDiffFile = z.infer<typeof prLocalDiffFileSchema>;

/**
 * `pr.getLocalDiff` response. `unavailable` is a normal outcome, not an error:
 * most PRs in a list have no checkout on this machine, and the caller renders
 * the GitHub-sourced file list instead.
 */
export const prGetLocalDiffResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unavailable"),
    reason: prLocalDiffUnavailableReasonSchema,
  }),
  z.object({
    kind: z.literal("diff"),
    /** Canonical absolute repo root the diff was taken in. */
    runningDir: z.string(),
    /** The ref that actually resolved as base, e.g. `origin/development`. */
    resolvedBaseRef: z.string(),
    baseOid: z.string(),
    mergeBaseOid: z.string(),
    localHeadOid: z.string(),
    /**
     * `localHeadOid !== expectedHeadOid`. Computed host-side so every client
     * draws the same conclusion from the same two strings; a `null`
     * `expectedHeadOid` (GitHub never told us) is NOT stale, it is unknown,
     * and reports `false`.
     */
    isStale: z.boolean(),
    files: z.array(prLocalDiffFileSchema),
    /** The patch sweep hit `byteBudget`; later `files[].patch` are `null`. */
    isTruncated: z.boolean(),
  }),
]);
export type PrGetLocalDiffResponse = z.infer<
  typeof prGetLocalDiffResponseSchema
>;
