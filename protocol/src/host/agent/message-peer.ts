import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/** Navigation identity for the other end of an existing A2A conversation. */
export const agentMessagePeerSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    agentId: z.string().min(1),
    hostId: z.string().min(1),
    title: z.string().nullable(),
    surface: z.enum(["gui", "tui"]),
  }),
);
export type AgentMessagePeer = z.infer<typeof agentMessagePeerSchema>;

export const agentMessagePeerOriginSchema = lazySchema(() =>
  z.object({
    direction: z.enum(["sent", "received"]),
    /** Receiver transcript message id, preserved when a chat is forked. */
    messageId: z.string().min(1),
  }),
);
export type AgentMessagePeerOrigin = z.infer<
  typeof agentMessagePeerOriginSchema
>;

export const resolveAgentMessagePeerRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    chatId: z.string().min(1),
    /** Exact id or the unambiguous prefix originally passed to the send tool. */
    agentId: z.string().min(1),
    origin: agentMessagePeerOriginSchema.nullable().default(null),
  }),
);

export const resolveAgentMessagePeerResponseSchema = lazySchema(() =>
  z.object({ peer: agentMessagePeerSchema.nullable() }),
);

export const agentResolveMessagePeerV10 = defineRpcContract({
  method: "agent.resolveMessagePeer",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: resolveAgentMessagePeerRequestSchema,
  responseSchema: resolveAgentMessagePeerResponseSchema,
});
