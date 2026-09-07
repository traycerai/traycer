/**
 * `agent.activity.subscribe@1.x` - per-user agent activity.
 * A consumer must never read `null` as "connected".
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

/** The host's cloud-link status stamped on a cloud-served `state` frame. */
export const agentActivityCloudSyncStatusSchema = epicCloudSyncStatusSchema;
export type AgentActivityCloudSyncStatus = EpicCloudSyncStatus;

// ─── Frozen `agent.activity.subscribe@1.0` shape (as shipped) ───────────────
// Hand-frozen verbatim, NOT derived from the live union below: the compat gate diffs dumped JSON Schema per released version, so a `.omit()`-derived copy would drift with every live edit.
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
