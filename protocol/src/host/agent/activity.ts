/**
 * `agent.activity.subscribe@1.0` - host-local, per-user agent activity.
 *
 * The authenticated connection supplies the user identity. Every activity
 * frame is a complete replacement of that user's current host-local state;
 * reconnect therefore needs no replay cursor or revision.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

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

const activityProjectionFields = {
  byEpic: agentActivityByEpicSchema,
  hasBinaryPayload: z.literal(false),
} as const;

export const agentActivitySubscribeServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("snapshot"), ...activityProjectionFields }),
    z.object({ kind: z.literal("update"), ...activityProjectionFields }),
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
  serverFrameSchema: agentActivitySubscribeServerFrameSchema,
  clientFrameSchema: agentActivitySubscribeClientFrameSchema,
});
