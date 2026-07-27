/**
 * Versioned RPC contracts for the `pr.*` host surface: two streaming methods
 * and one unary.
 *
 * The two streams are plain v1.0 - new top-level registry keys,
 * intersection-negotiated (no `degrade`, no floor/fixture change: `degrade`
 * and `RELEASED_FLOOR_METHOD_NAMES` are unary-only concepts; a peer lacking
 * these methods simply doesn't advertise them). `pr.getLocalDiff` IS unary, so
 * it must declare `degrade` and stay out of the floor - see its own note.
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
