/**
 * Versioned RPC contracts for the `pr.*` host surface: two streaming methods and three unaries (the whole-PR local diff, plus its split summary/per-file successor pair).
 * The unaries must each declare `degrade` and stay out of the floor - see their notes.
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
  prGetLocalDiffSummaryResponseV11Schema,
  prGetLocalFileDiffRequestV11Schema,
  prGetLocalFileDiffResponseSchema,
} from "./pr-schemas";

/**
 * `pr.subscribeListForEpic@1.0` - streaming RPC for the epic-scoped PR list (panel + changed-dot background sweep).
 */
export const prSubscribeListForEpicV10 = defineStreamRpcContract({
  method: "pr.subscribeListForEpic",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: prSubscribeListForEpicOpenRequestSchema,
  serverFrameSchema: prSubscribeListForEpicServerFrameSchema,
  clientFrameSchema: prSubscribeClientFrameSchema,
});

/**
 * `pr.subscribeDetail@1.0` - streaming RPC for a single PR's heavy detail (canvas tile).
 * `hostId` is never an argument, always derived from the connection's host context.
 */
export const prSubscribeDetailV10 = defineStreamRpcContract({
  method: "pr.subscribeDetail",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: prSubscribeDetailOpenRequestSchema,
  serverFrameSchema: prSubscribeDetailServerFrameSchema,
  clientFrameSchema: prSubscribeClientFrameSchema,
});

/**
 * `pr.getLocalDiff@1.0` - unary RPC for a PR's patch, read from the LOCAL checkout rather than GitHub.
 */
export const prGetLocalDiffV10 = defineRpcContract({
  method: "pr.getLocalDiff",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: prGetLocalDiffRequestSchema,
  responseSchema: prGetLocalDiffResponseSchema,
});

/**
 * `pr.getLocalDiffSummary@1.0` - the metadata half of `pr.getLocalDiff`: the resolved range (both endpoint OIDs) and every file's name/status/counts, with no patch text at all.
 * A new name rides the optional-capability channel (`degrade: unsupported`), stays out of the released floor/baseline, and fails loudly (`E_HOST_UNSUPPORTED`) so the client can fall back to the monolith on purpose.
 */
export const prGetLocalDiffSummaryV10 = defineRpcContract({
  method: "pr.getLocalDiffSummary",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: prGetLocalDiffSummaryRequestSchema,
  responseSchema: prGetLocalDiffSummaryResponseV11Schema,
});

/**
 * `pr.getLocalFileDiff@1.0` - one file's patch from a range `pr.getLocalDiffSummary` resolved, addressed by the summary's OID pair.
 */
export const prGetLocalFileDiffV10 = defineRpcContract({
  method: "pr.getLocalFileDiff",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: prGetLocalFileDiffRequestV11Schema,
  responseSchema: prGetLocalFileDiffResponseSchema,
});
