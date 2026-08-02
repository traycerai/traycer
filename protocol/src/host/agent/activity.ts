/**
 * `agent.activity.subscribe@1.0` - per-user agent activity.
 *
 * The host selects the authoritative read plane. Every `state` frame is a
 * complete replacement and names the plane that served it, so a reconnect or
 * a local/cloud transition needs neither a replay cursor nor renderer-side
 * entitlement logic.
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

export const agentActivityServedBySchema = z.enum(["local", "cloud"]);
export type AgentActivityServedBy = z.infer<typeof agentActivityServedBySchema>;

export const agentActivitySubscribeServerFrameSchema = z.discriminatedUnion(
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
