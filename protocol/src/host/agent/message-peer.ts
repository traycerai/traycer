import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The bot whose trunk or thread session is the other end (`@1.1`): the bot's
 * current title, so a client opens the bot's channel by it.
 */
export const agentMessagePeerBotSchema = lazySchema(() =>
  z.object({
    botId: z.string().min(1),
    title: z.string(),
  }),
);
export type AgentMessagePeerBot = z.infer<typeof agentMessagePeerBotSchema>;

/**
 * Navigation identity for the other end of an existing A2A conversation. For
 * a bot's session, `epicId` is the bot id and `agentId` the session's chat id,
 * as the routing records hold them, and `bot` names the bot.
 */
export const agentMessagePeerSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    agentId: z.string().min(1),
    hostId: z.string().min(1),
    title: z.string().nullable(),
    surface: z.enum(["gui", "tui"]),
    bot: agentMessagePeerBotSchema.nullable(),
  }),
);
export type AgentMessagePeer = z.infer<typeof agentMessagePeerSchema>;

/** The `@1.0` peer, frozen: it names no bot. */
const agentMessagePeerSchemaV10 = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    agentId: z.string().min(1),
    hostId: z.string().min(1),
    title: z.string().nullable(),
    surface: z.enum(["gui", "tui"]),
  }),
);

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

const resolveAgentMessagePeerResponseSchemaV10 = lazySchema(() =>
  z.object({ peer: agentMessagePeerSchemaV10.nullable() }),
);

export const agentResolveMessagePeerV10 = defineRpcContract({
  method: "agent.resolveMessagePeer",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: resolveAgentMessagePeerRequestSchema,
  responseSchema: resolveAgentMessagePeerResponseSchemaV10,
});

/**
 * `agent.resolveMessagePeer@1.1` (Tracy Bots T107): the peer names the bot
 * when the other end is a bot's trunk or thread session. A 1.0 host names
 * none, so its sender chip stays as it was.
 */
export const agentResolveMessagePeerV11 = defineRpcContract({
  method: "agent.resolveMessagePeer",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: resolveAgentMessagePeerRequestSchema,
  responseSchema: resolveAgentMessagePeerResponseSchema,
});
export const agentResolveMessagePeerUpgradeV10ToV11 = defineUpgradePath<
  typeof agentResolveMessagePeerV10,
  typeof agentResolveMessagePeerV11
>({
  from: agentResolveMessagePeerV10.schemaVersion,
  to: agentResolveMessagePeerV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    peer: response.peer === null ? null : { ...response.peer, bot: null },
  }),
});
