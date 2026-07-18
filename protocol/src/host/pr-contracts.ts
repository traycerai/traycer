/**
 * Versioned RPC contracts for the `pr.*` host stream surface. Two streaming
 * methods, both plain v1.0 - new top-level registry keys, intersection-
 * negotiated (no `degrade`, no floor/fixture change: `degrade` and
 * `RELEASED_FLOOR_METHOD_NAMES` are unary-only concepts; a peer lacking
 * these methods simply doesn't advertise them).
 */
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  prSubscribeListForEpicOpenRequestSchema,
  prSubscribeListForEpicServerFrameSchema,
  prSubscribeDetailOpenRequestSchema,
  prSubscribeDetailServerFrameSchema,
  prSubscribeClientFrameSchema,
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
