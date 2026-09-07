/**
 * `agent.inbox.subscribe@1.0` - streaming-RPC contract used by the `traycer monitor` background command (spawned inside a Claude Code TUI session) to receive inbox messages addressed to a single agent id.
 * Awareness is delivered only to a sink that is connected at that moment - it is never queued, so a reconnecting monitor never replays a stale broadcast.
 */
import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { z } from "zod";
import { roleAwarenessEventSchema } from "@traycer/protocol/host/agent/roles";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

export const agentInboxSubscribeOpenRequestSchema = z.object({
  agentId: z.string(),
  /** Epic the agent belongs to. */
  epicId: z.string(),
});
export type AgentInboxSubscribeOpenRequest = z.infer<
  typeof agentInboxSubscribeOpenRequestSchema
>;

/**
 * Single inbox item as delivered to the monitor. Mirrors
 * `MailboxEnvelope` on the host side.
 */
export const agentInboxMessageSchema = z.object({
  /**
   * Reply contract for this inbox delivery. Reply-expected messages always
   * carry the broker-minted thread id the receiver must echo back.
   */
  reply: z.discriminatedUnion("expectsReply", [
    z.object({
      expectsReply: z.literal(true),
      responseId: z.string(),
    }),
    z.object({
      expectsReply: z.literal(false),
    }),
  ]),
  fromAgentId: z.string(),
  /** Sender's display title (chat title or TUI agent title). */
  senderTitle: z.string().nullable(),
  /**
   * Sender's harness id (claude/codex/cursor/opencode). Null for senders
   * without a harness binding.
   */
  senderHarnessId: z.string().nullable(),
  epicId: z.string(),
  prompt: z.string(),
  /** Epoch millis the broker received the envelope. */
  enqueuedAt: z.number().int(),
});
export type AgentInboxMessage = z.infer<typeof agentInboxMessageSchema>;

/**
 * `@1.2` message shape: adds `eventId`, the durable inbox row's key, so the monitor can acknowledge it via `agent.inbox.ack` once it has been safely surfaced to the agent.
 */
export const agentInboxMessageSchemaV12 = agentInboxMessageSchema.extend({
  /** Durable inbox row key - see `agent.inbox.ack`. */
  eventId: z.string(),
});
export type AgentInboxMessageV12 = z.infer<typeof agentInboxMessageSchemaV12>;

/**
 * Out-of-band notice the broker emits when a receiver the calling agent had outstanding requests to has gone idle without replying.
 */
export const agentInboxNoticeSchema = z.object({
  kind: z.literal("inactivity"),
  /**
   * The agent the notice is addressed to - the original sender that asked for a reply and is being told its counterparty went silent.
   */
  senderAgentId: z.string(),
  /** The thread id the original sender owns. */
  responseId: z.string(),
  /** The receiver that went idle (the calling agent's counterparty). */
  receiverAgentId: z.string(),
  /** Receiver's display title at notice time, when known. */
  receiverTitle: z.string().nullable(),
  receiverHarnessId: z.string().nullable(),
  epicId: z.string(),
  /**
   * Why the notice fired, so the monitor can render accurate copy and the sender knows how much to trust it and how to proceed: - `turn-ended` - receiver's turn ended (Stop hook) with no reply.
   * Informational only: the sender must not re-send or spawn a replacement (contrast `user-stopped`, where the thread stays open).
   */
  reason: z.enum([
    "turn-ended",
    "exited",
    "quiet",
    "user-stopped",
    "errored",
    "awaiting-input",
    "receiver-cancelled",
  ]),
  /**
   * Raw, human-readable detail behind `reason` (the error text for `errored`, a prompt summary for `awaiting-input`), or null when the reason needs no elaboration.
   */
  detail: z.string().nullable(),
  droppedReceivers: z
    .array(
      z.object({
        receiverAgentId: z.string(),
        responseId: z.string(),
      }),
    )
    .nullable(),
  /** Epoch millis the notice fired. */
  noticedAt: z.number().int(),
});
export type AgentInboxNoticeV12 = z.infer<typeof agentInboxNoticeSchema>;

/** Authenticated actor that initiated an `agent.stop` cancellation. */
export const agentStopInitiatorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({
    type: z.literal("agent"),
    agentId: z.string(),
    agentTitle: z.string().nullable(),
  }),
]);

/**
 * `@1.3` notice shape: adds structured stop provenance.
 * A distinct schema preserves the frozen @1.0-@1.2 trees; older monitors ignore the additive field while current renderers can name the responsible agent.
 */
export const agentInboxNoticeSchemaV13 = agentInboxNoticeSchema.extend({
  /** Non-null only for `receiver-cancelled`. */
  stopInitiator: agentStopInitiatorSchema.nullable(),
});
export type AgentInboxNotice = z.infer<typeof agentInboxNoticeSchemaV13>;

// ─── Frozen agent.inbox.subscribe@1.0 shape (as shipped) ──────────────────
export const agentInboxSubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("message"),
      ...textFrameFields,
      item: agentInboxMessageSchema,
    }),
    z.object({
      kind: z.literal("notice"),
      ...textFrameFields,
      notice: agentInboxNoticeSchema,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ],
);

// ─── agent.inbox.subscribe@1.1 - additive: role awareness ─────────────────
// Typed and NOT reply-bearing - it carries no responseId and no `expectsReply`, so it cannot create a pending A2A thread.
export const agentInboxSubscribeServerFrameSchemaV11 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("message"),
      ...textFrameFields,
      item: agentInboxMessageSchema,
    }),
    z.object({
      kind: z.literal("notice"),
      ...textFrameFields,
      notice: agentInboxNoticeSchema,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("role-awareness"),
      ...textFrameFields,
      event: roleAwarenessEventSchema,
    }),
  ],
);

// ─── agent.inbox.subscribe@1.2 - additive: durable inbox eventId ──────────
// A `@1.0`/`@1.1` monitor negotiates one of the older, frozen frame trees above - which have no `eventId` field at all - and can never call `agent.inbox.ack`.
export const agentInboxSubscribeServerFrameSchemaV12 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("message"),
      ...textFrameFields,
      item: agentInboxMessageSchemaV12,
    }),
    z.object({
      kind: z.literal("notice"),
      ...textFrameFields,
      notice: agentInboxNoticeSchema,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("role-awareness"),
      ...textFrameFields,
      event: roleAwarenessEventSchema,
    }),
  ],
);

// ─── agent.inbox.subscribe@1.3 - additive: stop initiator provenance ──────

export const agentInboxSubscribeServerFrameSchemaV13 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("message"),
      ...textFrameFields,
      item: agentInboxMessageSchemaV12,
    }),
    z.object({
      kind: z.literal("notice"),
      ...textFrameFields,
      notice: agentInboxNoticeSchemaV13,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("role-awareness"),
      ...textFrameFields,
      event: roleAwarenessEventSchema,
    }),
  ],
);

/** The latest installed shape. Host code builds frames against this. */
export const agentInboxSubscribeServerFrameSchema =
  agentInboxSubscribeServerFrameSchemaV13;
export type AgentInboxSubscribeServerFrame = z.infer<
  typeof agentInboxSubscribeServerFrameSchema
>;

export const agentInboxSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ],
);
export type AgentInboxSubscribeClientFrame = z.infer<
  typeof agentInboxSubscribeClientFrameSchema
>;

export const agentInboxSubscribeV10 = defineStreamRpcContract({
  method: "agent.inbox.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: agentInboxSubscribeOpenRequestSchema,
  serverFrameSchema: agentInboxSubscribeServerFrameSchemaV10,
  clientFrameSchema: agentInboxSubscribeClientFrameSchema,
});

export const agentInboxSubscribeV11 = defineStreamRpcContract({
  method: "agent.inbox.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: agentInboxSubscribeOpenRequestSchema,
  serverFrameSchema: agentInboxSubscribeServerFrameSchemaV11,
  clientFrameSchema: agentInboxSubscribeClientFrameSchema,
});

export const agentInboxSubscribeV12 = defineStreamRpcContract({
  method: "agent.inbox.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: agentInboxSubscribeOpenRequestSchema,
  serverFrameSchema: agentInboxSubscribeServerFrameSchemaV12,
  clientFrameSchema: agentInboxSubscribeClientFrameSchema,
});

export const agentInboxSubscribeV13 = defineStreamRpcContract({
  method: "agent.inbox.subscribe",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: agentInboxSubscribeOpenRequestSchema,
  serverFrameSchema: agentInboxSubscribeServerFrameSchemaV13,
  clientFrameSchema: agentInboxSubscribeClientFrameSchema,
});

// ─── `agent.inbox.read@1.0` - unary recent-inbox read ─────────────────────
// GUI agents have no truncation problem and never route through the durable TUI inbox, so this is a TUI-only recovery path.

export const agentInboxReadRequestSchema = z.object({
  epicId: z.string(),
  /** The calling agent reading its own inbox (defaults to $TRAYCER_AGENT_ID). */
  agentId: z.string(),
});
export type AgentInboxReadRequest = z.infer<typeof agentInboxReadRequestSchema>;

export const agentInboxReadResponseSchema = z.object({
  /** Recently-delivered messages, oldest first (bounded by the broker ring). */
  messages: z.array(agentInboxMessageSchema),
});
export type AgentInboxReadResponse = z.infer<
  typeof agentInboxReadResponseSchema
>;

export const agentInboxReadV10 = defineRpcContract({
  method: "agent.inbox.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentInboxReadRequestSchema,
  responseSchema: agentInboxReadResponseSchema,
});

// ─── `agent.inbox.read@2.0` - bounded durable-inbox page ─────────────────
// Keep @1.0 frozen for existing clients, but make the canonical read a single-row cursor page so a recovery read never allocates an entire backlog in the host RPC process.
export const agentInboxReadCursorSchema = z.object({
  createdAt: z.number().int(),
  eventId: z.string(),
});
export type AgentInboxReadCursor = z.infer<typeof agentInboxReadCursorSchema>;

export const agentInboxReadRequestSchemaV20 =
  agentInboxReadRequestSchema.extend({
    /** Resume after this oldest-first durable inbox row, or start at the head. */
    after: agentInboxReadCursorSchema.nullable(),
  });
export type AgentInboxReadRequestV20 = z.infer<
  typeof agentInboxReadRequestSchemaV20
>;

export const agentInboxReadResponseSchemaV20 =
  agentInboxReadResponseSchema.extend({
    /** Cursor for the following page, or null when this page reached the end. */
    nextCursor: agentInboxReadCursorSchema.nullable(),
  });
export type AgentInboxReadResponseV20 = z.infer<
  typeof agentInboxReadResponseSchemaV20
>;

export const agentInboxReadV20 = defineRpcContract({
  method: "agent.inbox.read",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: agentInboxReadRequestSchemaV20,
  responseSchema: agentInboxReadResponseSchemaV20,
});

export const agentInboxReadUpgradeV10ToV20 = defineUpgradePath<
  typeof agentInboxReadV10,
  typeof agentInboxReadV20
>({
  from: agentInboxReadV10.schemaVersion,
  to: agentInboxReadV20.schemaVersion,
  upgradeRequest: (request) => ({ ...request, after: null }),
  upgradeResponse: (response) => ({ ...response, nextCursor: null }),
});

export const agentInboxReadDowngradeV20ToV10 = defineDowngradePath<
  typeof agentInboxReadV20,
  typeof agentInboxReadV10
>({
  from: agentInboxReadV20.schemaVersion,
  to: agentInboxReadV10.schemaVersion,
  downgradeRequest: (request) => {
    if (request.after !== null) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Paginated inbox reads require a newer Traycer host. Upgrade the host before using --after.",
        },
      };
    }
    return {
      ok: true,
      value: { epicId: request.epicId, agentId: request.agentId },
    };
  },
  downgradeResponse: (response) => {
    if (response.nextCursor !== null) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "This inbox has more messages than an older Traycer client can read safely. Upgrade the client to continue.",
        },
      };
    }
    return {
      ok: true,
      value: { messages: response.messages },
    };
  },
});

// ─── `agent.inbox.ack@1.0` - unary durable-inbox acknowledgement ──────────

export const agentInboxAckRequestSchema = z.object({
  epicId: z.string(),
  /** The calling agent acknowledging its own inbox. */
  agentId: z.string(),
  /** Durable inbox row keys to retire. Empty is a no-op. */
  eventIds: z.array(z.string()).max(500),
});
export type AgentInboxAckRequest = z.infer<typeof agentInboxAckRequestSchema>;

export const agentInboxAckResponseSchema = z.object({});
export type AgentInboxAckResponse = z.infer<typeof agentInboxAckResponseSchema>;

export const agentInboxAckV10 = defineRpcContract({
  method: "agent.inbox.ack",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentInboxAckRequestSchema,
  responseSchema: agentInboxAckResponseSchema,
});
