/**
 * `agent.activity.subscribe@1.x` - per-user agent activity.
 *
 * The host selects the authoritative read plane. Every `state` frame is a
 * complete replacement and names the plane that served it, so a reconnect or
 * a local/cloud transition needs neither a replay cursor nor renderer-side
 * entitlement logic.
 *
 * `1.1` adds `cloudSyncStatus` to the `state` frame: the host's view of its
 * cloud link at the moment it built the union. A cloud-served union that was
 * built while the link was down is a true statement about what the host could
 * SEE, not about who is working - hocuspocus clears every remote host's
 * awareness entry the instant the socket closes, so without this stamp the
 * stripped union was wire-identical to "everyone went idle". `null` is NO
 * CLAIM: a local-plane frame, or a `1.0` host that predates the field. A
 * consumer must never read `null` as "connected".
 *
 * `1.0` is frozen below (`agentActivitySubscribeServerFrameSchemaV10`) - it
 * has shipped, and `canBridgeStream()` needs the `{1,0}` line registered to
 * bridge a `1.1` client down to a `1.0` host. Do not add fields to it.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  epicCloudSyncStatusSchema,
  type EpicCloudSyncStatus,
} from "@traycer/protocol/host/epic/subscribe";

export const agentActivitySubscribeOpenRequestSchema = z.object({});
export type AgentActivitySubscribeOpenRequest = z.infer<
  typeof agentActivitySubscribeOpenRequestSchema
>;

export const agentActivityEpicBucketSchema = z.object({
  working: z.array(z.string()),
  turn: z.array(z.string()),
});
export type AgentActivityEpicBucket = z.infer<
  typeof agentActivityEpicBucketSchema
>;

export const agentActivityByEpicSchema = z.record(
  z.string(),
  agentActivityEpicBucketSchema,
);
export type AgentActivityByEpic = z.infer<typeof agentActivityByEpicSchema>;

export const agentActivityServedBySchema = z.enum(["local", "cloud"]);
export type AgentActivityServedBy = z.infer<typeof agentActivityServedBySchema>;

/**
 * The host's cloud-link status stamped on a cloud-served `state` frame. Same
 * vocabulary as `epic.subscribe`'s `cloudSyncStatus` on purpose - it is the
 * same notification-room lifecycle reporting it. `null` = no claim.
 */
export const agentActivityCloudSyncStatusSchema = epicCloudSyncStatusSchema;
export type AgentActivityCloudSyncStatus = EpicCloudSyncStatus;

// ─── Frozen `agent.activity.subscribe@1.0` shape (as shipped) ───────────────
//
// Hand-frozen verbatim, NOT derived from the live union below: the compat gate
// diffs dumped JSON Schema per released version, so a `.omit()`-derived copy
// would drift with every live edit. A `1.0` peer's plain `z.object` parse
// strips `cloudSyncStatus` from a `1.1` frame; the host also strips it before
// the wire for `1.0` connections (it serializes frames as-is).
export const agentActivitySubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("state"),
      servedBy: agentActivityServedBySchema,
      byEpic: agentActivityByEpicSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type AgentActivitySubscribeServerFrameV10 = z.infer<
  typeof agentActivitySubscribeServerFrameSchemaV10
>;

// ─── Live `agent.activity.subscribe@1.1` shape ──────────────────────────────
export const agentActivitySubscribeServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("state"),
      servedBy: agentActivityServedBySchema,
      byEpic: agentActivityByEpicSchema,
      // Absent on a `1.0` host's frame -> `null` on a `1.1` client: the client
      // never manufactures a "connected" claim for a host that cannot make one.
      cloudSyncStatus: agentActivityCloudSyncStatusSchema
        .nullable()
        .default(null),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type AgentActivitySubscribeServerFrame = z.infer<
  typeof agentActivitySubscribeServerFrameSchema
>;

export const agentActivitySubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type AgentActivitySubscribeClientFrame = z.infer<
  typeof agentActivitySubscribeClientFrameSchema
>;

export const agentActivitySubscribeV10 = defineStreamRpcContract({
  method: "agent.activity.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: agentActivitySubscribeOpenRequestSchema,
  serverFrameSchema: agentActivitySubscribeServerFrameSchemaV10,
  clientFrameSchema: agentActivitySubscribeClientFrameSchema,
});

export const agentActivitySubscribeV11 = defineStreamRpcContract({
  method: "agent.activity.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: agentActivitySubscribeOpenRequestSchema,
  serverFrameSchema: agentActivitySubscribeServerFrameSchema,
  clientFrameSchema: agentActivitySubscribeClientFrameSchema,
});
