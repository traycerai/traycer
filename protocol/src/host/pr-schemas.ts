/** Schemas for the `pr.*` host stream surface - the Epic PR View's list and detail subscriptions. */
import { z } from "zod";
import { worktreeBindingOwnerKindSchema } from "./worktree-schemas";

// ---- Shared building blocks ---------------------------------------------- //

/** Per-frame sweep outcome. */
export const prSourceStatusSchema = z.enum([
  "ok",
  "partial",
  "gh-unavailable",
  "error",
  "cached",
]);
export type PrSourceStatus = z.infer<typeof prSourceStatusSchema>;

/**
 * Why the host is not refreshing right now, when that reason is the FETCH LAYER rather than any one PR's outcome.
 * Copy is built CLIENT-SIDE from `kind` + `retryAt`; the host never sends prose.
 */
export const prSourceNoticeSchema = z.object({
  kind: z.enum(["rate-limited", "backing-off"]),
  retryAt: z.number().nullable(),
});
export type PrSourceNotice = z.infer<typeof prSourceNoticeSchema>;

/**
 * Network eligibility for a PR, NOT connectivity health.
 * `cache-only` marks GHES/unknown-host PRs the policy never sweeps by design; a github.com PR that simply hasn't been swept yet is still `live` (its frames carry `sourceStatus: "cached"` until the first sweep lands).
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
 * The PR's *base* GitHub coordinates - owner/repo/prNumber of the repo the PR targets, never the fork/head repo.
 * Nullable AS A GROUP on the light item (see the unknown-base rule below): a positive fact can lack these when discovery only proved head identity (absent/unparseable `prUrl`), and substituting head owner/repo would.
 */
export const prBaseCoordinatesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
});
export type PrBaseCoordinates = z.infer<typeof prBaseCoordinatesSchema>;

export const prRepoIdentifierSchema = z.object({
  owner: z.string(),
  repo: z.string(),
});
export type PrRepoIdentifier = z.infer<typeof prRepoIdentifierSchema>;

/**
 * Which side of a worktree binding entry a row was enumerated from: the entry's own repo (`superproject`) or one of its owned submodule branches (`submodule`).
 */
export const prRepoRoleSchema = z.enum(["superproject", "submodule"]);
export type PrRepoRole = z.infer<typeof prRepoRoleSchema>;

/**
 * Opaque token shared by every PR enumerated from the SAME worktree binding entry - the entry's superproject PR and each of its owned-submodule PRs.
 * Display-hostile by design (it is the entry's local running directory): the client groups on it and never renders it.
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
 * One PR row on the list stream.
 * Every enrichment field below `liveness` is independently nullable so a cache-only or never-swept item still renders from identity + state alone.
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
  // Present on HYDRATION snapshots too, not just sweep-driven updates: a panel opened while the host is already paused must say so on its first frame rather than looking merely stale.
  notice: prSourceNoticeSchema.nullable(),
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
  /** The JOB name alone (`build`, `pre-commit`) - which is not unique. */
  name: z.string(),
  workflowName: z.string().nullable(),
  /** What triggered the run (`pull_request`). `null` outside a workflow run. */
  event: z.string().nullable(),
  /** The app that reported it - "GitHub Actions", "Mintlify", "CodeRabbit". */
  appName: z.string().nullable(),
  /** The reporting app's icon. */
  appLogoUrl: z.string().nullable(),
  /** The one-line reason a commit status carries ("Review completed", "Skipping deployment"). */
  description: z.string().nullable(),
  status: prCheckStatusSchema,
  conclusion: prCheckConclusionSchema.nullable(),
  detailsUrl: z.string().nullable(),
});
export type PrCheckContext = z.infer<typeof prCheckContextSchema>;

/**
 * `checks` section of a detail frame - the first 50 check contexts plus a truncation marker.
 * `observedAt` is `null` for a row that has never been swept (cache-only or not-yet-observed).
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
     * GitHub's review node id where one is known, so a {@link prReviewThreadSchema} can name the review that submitted it.
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
 * Nullable because a thread can outlive the 20-review window, and because a fact persisted before this field existed has no review id to match - both cases render the thread un-nested rather than dropping it.
 */
export const prReviewThreadSchema = z.object({
  id: z.string(),
  reviewId: z.string().nullable(),
  path: z.string(),
  /** The line in the CURRENT head. */
  line: z.number().int().nullable(),
  /** The line as of the commit reviewed. Present even when `line` is not. */
  originalLine: z.number().int().nullable(),
  side: prReviewThreadSideSchema,
  subject: prReviewThreadSubjectSchema,
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  /** The tail of the diff hunk the thread is anchored to, or `null`. */
  diffHunk: z.string().nullable(),
  comments: z.array(prReviewThreadCommentSchema).max(10),
  /** True count, so a clipped thread can say how many replies it is hiding. */
  totalCommentCount: z.number().int().nonnegative(),
});
export type PrReviewThread = z.infer<typeof prReviewThreadSchema>;

/** `reviewThreads` section of a detail frame. */
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
 * `core` section of a detail frame - the light fields plus the heavy-only overview fields (body, author, reviewers/review requests, headRefOid, mergedAt).
 * Unlike the light item's `base`, `owner`/`repo`/`prNumber` here are never null: a detail subscription only ever opens for a fully identified PR (its base coordinates are the subscription's own open-request key).
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
  // Carried for `pr.getLocalDiff`, which needs to name WHICH checkout and which repo under it.
  repoRole: prRepoRoleSchema,
  linkGroupKey: prLinkGroupKeySchema.nullable(),
  owners: z.array(prOwnerRefSchema),
});
export type PrDetailCore = z.infer<typeof prDetailCoreSchema>;

const PR_SUBSCRIBE_DETAIL_FRAME_FIELDS = {
  hasBinaryPayload: z.literal(false),
  sourceStatus: prSourceStatusSchema,
  notice: prSourceNoticeSchema.nullable(),
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

/** Client frame shared by both `pr.*` streams: a manual refresh request. */
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

/** Default byte cap for one range-diff sweep. */
export const DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET = 2 * 1_048_576;

/**
 * Why a PR has no local diff.
 * Each value is a DIFFERENT sentence to the reader, which is the whole reason this isn't a boolean: "you have no checkout of this PR" and "your checkout never fetched the base branch" want different next actions.
 */
export const prLocalDiffUnavailableReasonSchema = z.enum([
  // The `linkGroupKey` matches no worktree binding on this host, or the directory it named is gone.
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
 * `pr.getLocalDiff` request - a ref-RANGE diff, run by the host against the local checkout a PR was pushed from.
 * `epicId` gates this the same way the two `pr.*` streams do: the caller must hold SOME role on the named epic, and the resolved checkout must itself belong to that epic.
 */
export const prGetLocalDiffRequestSchema = z.object({
  epicId: z.string().min(1),
  // `.min(1)` on the REQUEST fields, not on the shared schemas: the host resolves `linkGroupKey` to a directory and matches `repoIdentifier` against a binding, so an empty value reaches that resolution and only fails later.
  // The same fields are nullable on the stream frames (`prLightItemSchema`, `prDetailCoreSchema`), which may legitimately carry an identifier this request could never be made with.
  linkGroupKey: prLinkGroupKeySchema.min(1),
  repoIdentifier: prRepoIdentifierSchema.extend({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
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
 * One file in the range.
 * Metadata comes from `--name-status` + `--numstat`, which cover EVERY file in the range; `patch` comes from the byte-capped patch sweep, so it is `null` for files the budget never reached.
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

/** `pr.getLocalDiff` response. */
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
     * `localHeadOid !== expectedHeadOid`.
     * Computed host-side so every client draws the same conclusion from the same two strings; a `null` `expectedHeadOid` (GitHub never told us) is NOT stale, it is unknown, and reports `false`.
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

// ---- `pr.getLocalDiffSummary` / `pr.getLocalFileDiff` --------------------- //

/** Default byte cap for ONE file's patch. */
export const DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET = 256 * 1024;

/**
 * A full commit OID as the summary response reports it - 40 hex for SHA-1 repos, 64 for SHA-256.
 * Enforced at the schema so an abbreviated OID, a ref name or a revision expression (`HEAD~2`, `a..b`) can never PARSE into a request whose host-side handler splices it into git argv; the host revalidates independently.
 */
export const prLocalDiffOidSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

/**
 * `pr.getLocalDiffSummary` request - `pr.getLocalDiff`'s request minus `byteBudget`, because metadata is never byte-capped: `--name-status` and `--numstat` cover every file in the range at a few dozen bytes each.
 */
export const prGetLocalDiffSummaryRequestSchema =
  prGetLocalDiffRequestSchema.omit({ byteBudget: true });
export type PrGetLocalDiffSummaryRequest = z.infer<
  typeof prGetLocalDiffSummaryRequestSchema
>;

/**
 * One file in the range - {@link prLocalDiffFileSchema} minus its patch.
 * The released monolith file schema stays untouched - its files never feed a request.
 */
export const prLocalDiffSummaryFileSchema = prLocalDiffFileSchema
  .omit({
    patch: true,
  })
  .extend({
    path: z.string().min(1),
    previousPath: z.string().min(1).nullable(),
  });
export type PrLocalDiffSummaryFile = z.infer<
  typeof prLocalDiffSummaryFileSchema
>;

/**
 * A byte-path sidecar token: CANONICAL standard base64 of raw path bytes.
 * The host still re-validates independently - plus the checks that need the decoded bytes and the sibling field (non-UTF-8-ness, companion-path equality) - because it cannot know its caller parsed a request at all.
 */
export const prPathBytesTokenSchema = z
  .string()
  .min(1)
  .refine(isCanonicalBase64, {
    message: "byte-path token must be canonical base64",
  });

function isCanonicalBase64(value: string): boolean {
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

/**
 * One summary file WITH the byte-path sidecars - the shape `pr.getLocalDiffSummary@1.0` binds.
 * There is no sidecar-less peer to project for - `pr.getLocalDiffSummary` had never shipped at all.
 */
export const prLocalDiffSummaryFileV11Schema =
  prLocalDiffSummaryFileSchema.extend({
    pathBytes: prPathBytesTokenSchema.nullable(),
    previousPathBytes: prPathBytesTokenSchema.nullable(),
  });
export type PrLocalDiffSummaryFileV11 = z.infer<
  typeof prLocalDiffSummaryFileV11Schema
>;

/**
 * `pr.getLocalDiffSummary` response - the `diff` variant of `pr.getLocalDiff`'s response minus per-file `patch` and minus `isTruncated` (nothing here is byte-capped, so nothing can truncate).
 * The OIDs are what the per-file calls address: both endpoints are commits, so a per-file answer fetched later can never disagree with the summary that named them, even if the checkout moves in between.
 */
export const prGetLocalDiffSummaryResponseSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("unavailable"),
      reason: prLocalDiffUnavailableReasonSchema,
    }),
    z.object({
      kind: z.literal("summary"),
      /** Canonical absolute repo root the diff was taken in. */
      runningDir: z.string(),
      /** The ref that actually resolved as base, e.g. `origin/development`. */
      resolvedBaseRef: z.string(),
      baseOid: prLocalDiffOidSchema,
      mergeBaseOid: prLocalDiffOidSchema,
      localHeadOid: prLocalDiffOidSchema,
      /** Same contract as `pr.getLocalDiff`'s `isStale`. */
      isStale: z.boolean(),
      files: z.array(prLocalDiffSummaryFileSchema),
    }),
  ],
);
export type PrGetLocalDiffSummaryResponse = z.infer<
  typeof prGetLocalDiffSummaryResponseSchema
>;

/**
 * `pr.getLocalDiffSummary@1.0` response: the summary shape with {@link prLocalDiffSummaryFileV11Schema} rows (field docs on the sidecar-less schema above, which survives only as the base this extends).
 */
export const prGetLocalDiffSummaryResponseV11Schema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("unavailable"),
      reason: prLocalDiffUnavailableReasonSchema,
    }),
    z.object({
      kind: z.literal("summary"),
      runningDir: z.string(),
      resolvedBaseRef: z.string(),
      baseOid: prLocalDiffOidSchema,
      mergeBaseOid: prLocalDiffOidSchema,
      localHeadOid: prLocalDiffOidSchema,
      isStale: z.boolean(),
      files: z.array(prLocalDiffSummaryFileV11Schema),
    }),
  ],
);
export type PrGetLocalDiffSummaryResponseV11 = z.infer<
  typeof prGetLocalDiffSummaryResponseV11Schema
>;

/** `pr.getLocalFileDiff` request - one file's patch from the range the summary resolved. */
export const prGetLocalFileDiffRequestSchema = z.object({
  epicId: z.string().min(1),
  linkGroupKey: prLinkGroupKeySchema.min(1),
  repoIdentifier: prRepoIdentifierSchema.extend({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  repoRole: prRepoRoleSchema,
  mergeBaseOid: prLocalDiffOidSchema,
  headOid: prLocalDiffOidSchema,
  path: z.string().min(1),
  previousPath: z.string().min(1).nullable(),
  ignoreWhitespace: z.boolean(),
  /** `null` requests the full patch - the "Load Full" ask. */
  byteBudget: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET),
});
export type PrGetLocalFileDiffRequest = z.infer<
  typeof prGetLocalFileDiffRequestSchema
>;

/**
 * `pr.getLocalFileDiff@1.0` request: the summary row's byte-path sidecars, echoed verbatim per side (never derived client-side).
 */
export const prGetLocalFileDiffRequestV11Schema =
  prGetLocalFileDiffRequestSchema.extend({
    pathBytes: prPathBytesTokenSchema.nullable(),
    previousPathBytes: prPathBytesTokenSchema.nullable(),
  });
export type PrGetLocalFileDiffRequestV11 = z.infer<
  typeof prGetLocalFileDiffRequestV11Schema
>;

/** `pr.getLocalFileDiff` response. */
export const prGetLocalFileDiffResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unavailable"),
    reason: prLocalDiffUnavailableReasonSchema,
  }),
  z.object({
    kind: z.literal("diff"),
    patch: z.string(),
    isBinary: z.boolean(),
    isTruncated: z.boolean(),
    truncatedAfterBytes: z.number().int().nonnegative().nullable(),
  }),
]);
export type PrGetLocalFileDiffResponse = z.infer<
  typeof prGetLocalFileDiffResponseSchema
>;
