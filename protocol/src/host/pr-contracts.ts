/**
 * Versioned RPC contracts for the `pr.*` host surface: two streaming methods
 * and three unaries (the whole-PR local diff, plus its split
 * summary/per-file successor pair).
 *
 * The two streams are plain v1.0 - new top-level registry keys,
 * intersection-negotiated (no `degrade`, no floor/fixture change: `degrade`
 * and `RELEASED_FLOOR_METHOD_NAMES` are unary-only concepts; a peer lacking
 * these methods simply doesn't advertise them). The unaries must each
 * declare `degrade` and stay out of the floor - see their notes.
 */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  prSubscribeListForEpicOpenRequestSchema,
  prSubscribeListForEpicServerFrameSchema,
  prSubscribeDetailOpenRequestSchema,
  prSubscribeDetailServerFrameSchema,
  prSubscribeClientFrameSchema,
  prGetLocalDiffRequestSchema,
  prGetLocalDiffResponseSchema,
  prGetLocalDiffSummaryRequestSchema,
  prGetLocalDiffSummaryResponseSchema,
  prGetLocalFileDiffRequestSchema,
  prGetLocalFileDiffResponseSchema,
} from "./pr-schemas";

/**
 * `pr.subscribeListForEpic@1.0` - streaming RPC for the epic-scoped PR list
 * (panel + changed-dot background sweep). `mode` selects the subscriber's
 * cadence tier (`foreground` ~60s, `background` ~5min); the host poller runs
 * at the fastest cadence among its live subscribers.
 */
export const prSubscribeListForEpicV10 = defineStreamRpcContract({
  method: "pr.subscribeListForEpic",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: prSubscribeListForEpicOpenRequestSchema,
  serverFrameSchema: prSubscribeListForEpicServerFrameSchema,
  clientFrameSchema: prSubscribeClientFrameSchema,
});

/**
 * `pr.subscribeDetail@1.0` - streaming RPC for a single PR's heavy detail
 * (canvas tile). `epicId` is carried for authorization only - the resolver
 * verifies the requested PR is in that epic's derived set before any `gh`
 * invocation; `hostId` is never an argument, always derived from the
 * connection's host context.
 */
export const prSubscribeDetailV10 = defineStreamRpcContract({
  method: "pr.subscribeDetail",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: prSubscribeDetailOpenRequestSchema,
  serverFrameSchema: prSubscribeDetailServerFrameSchema,
  clientFrameSchema: prSubscribeClientFrameSchema,
});

/**
 * `pr.getLocalDiff@1.0` - unary RPC for a PR's patch, read from the LOCAL
 * checkout rather than GitHub.
 *
 * GitHub's GraphQL `PullRequestChangedFile` carries no patch text at all, so
 * the detail sweep can only ever produce a file list; the diff itself has to
 * come from somewhere else. It comes from the worktree the branch was pushed
 * from - which the host already knows about, and which is usually sitting at
 * the very commit the PR is showing.
 *
 * Additive, post-v1.0.0 OPTIONAL unary method: a host that predates it lacks
 * the method entirely, the renderer falls back to the GitHub file list it
 * already had, so it rides the optional-capability channel
 * (`degrade: unsupported` in the registry) and stays out of the released floor
 * and baseline surface.
 */
export const prGetLocalDiffV10 = defineRpcContract({
  method: "pr.getLocalDiff",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: prGetLocalDiffRequestSchema,
  responseSchema: prGetLocalDiffResponseSchema,
});

/**
 * `pr.getLocalDiffSummary@1.0` - the metadata half of `pr.getLocalDiff`: the
 * resolved range (both endpoint OIDs) and every file's name/status/counts,
 * with no patch text at all.
 *
 * Split from the monolith because one 2MiB response rendered in one commit is
 * a multi-second main-thread hang on a large PR, while the metadata sweeps
 * alone are a few KiB and instant. The per-file patches then arrive one
 * visible row at a time over `pr.getLocalFileDiff` below - the Git Diff
 * bundle tile's shipping architecture.
 *
 * New OPTIONAL method rather than a minor bump on `pr.getLocalDiff`: a minor
 * is invisible to the client at render time (the negotiated-manifest registry
 * records method NAMES only), and the client-side version projection would
 * silently strip a request-side "no patches" flag against a v1.0 host -
 * turning every summary ask into the full 2MiB monolith, undetectably. A new
 * name rides the optional-capability channel (`degrade: unsupported`), stays
 * out of the released floor/baseline, and fails loudly (`E_HOST_UNSUPPORTED`)
 * so the client can fall back to the monolith on purpose.
 */
export const prGetLocalDiffSummaryV10 = defineRpcContract({
  method: "pr.getLocalDiffSummary",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: prGetLocalDiffSummaryRequestSchema,
  responseSchema: prGetLocalDiffSummaryResponseSchema,
});

/**
 * `pr.getLocalFileDiff@1.0` - one file's patch from a range
 * `pr.getLocalDiffSummary` resolved, addressed by the summary's OID pair.
 * Mirrors `git.getFileDiff`'s per-file contract (256KiB default budget,
 * `isTruncated`/`truncatedAfterBytes`, `byteBudget: null` = load-full);
 * deliberately single-file rather than batched - the bundle tile fetches one
 * visible row at a time over both transports, and a batch method can sit
 * beside this later exactly as `git.getFileDiffs` sits beside
 * `git.getFileDiff` if relay latency ever demands it.
 *
 * Same optional-method posture as `pr.getLocalDiffSummary` above, and always
 * shipped together with it: a client only reaches for this after a summary
 * succeeded.
 */
export const prGetLocalFileDiffV10 = defineRpcContract({
  method: "pr.getLocalFileDiff",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: prGetLocalFileDiffRequestSchema,
  responseSchema: prGetLocalFileDiffResponseSchema,
});
