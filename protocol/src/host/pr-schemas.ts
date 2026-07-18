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
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().int(),
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
  owners: z.array(prOwnerRefSchema),
});
export type PrLightItem = z.infer<typeof prLightItemSchema>;

const prSubscribeListForEpicFrameFields = {
  hasBinaryPayload: z.literal(false),
  sourceStatus: prSourceStatusSchema,
  items: z.array(prLightItemSchema),
} as const;

export const prSubscribeListForEpicServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...prSubscribeListForEpicFrameFields,
    }),
    z.object({
      kind: z.literal("updated"),
      ...prSubscribeListForEpicFrameFields,
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
  githubHost: z.string(),
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().int(),
});
export type PrSubscribeDetailOpenRequest = z.infer<
  typeof prSubscribeDetailOpenRequestSchema
>;

export const prCheckStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
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
]);
export type PrCheckConclusion = z.infer<typeof prCheckConclusionSchema>;

export const prCheckContextSchema = z.object({
  name: z.string(),
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
  owners: z.array(prOwnerRefSchema),
});
export type PrDetailCore = z.infer<typeof prDetailCoreSchema>;

const prSubscribeDetailFrameFields = {
  hasBinaryPayload: z.literal(false),
  sourceStatus: prSourceStatusSchema,
  liveness: prLivenessSchema,
  core: prDetailCoreSchema,
  checks: prChecksSectionSchema,
  activity: prActivitySectionSchema,
  files: prFilesSectionSchema,
  commits: prCommitsSectionSchema,
} as const;

export const prSubscribeDetailServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...prSubscribeDetailFrameFields,
    }),
    z.object({
      kind: z.literal("updated"),
      ...prSubscribeDetailFrameFields,
    }),
    z.object({
      kind: z.literal("error"),
      hasBinaryPayload: z.literal(false),
      message: z.string(),
      isFatal: z.boolean(),
    }),
  ],
);
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
