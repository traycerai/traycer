/**
 * `agent.inbox.subscribe@1.0` - streaming-RPC contract used by the
 * `traycer monitor` background command (spawned inside a Claude Code TUI
 * session) to receive inbox messages addressed to a single agent id.
 *
 * Delivery model:
 *
 *   - `agent.sendMessage` from another agent enqueues a `MailboxEnvelope`
 *     on the broker's per-receiver inbox queue (RAM-only).
 *   - On every enqueue the broker fires `onInboxChange`; the stream
 *     resolver drains the queue and pushes each envelope to the subscribed
 *     monitor as a `message` frame.
 *   - If no monitor is subscribed when a message lands, it queues until
 *     one connects and the resolver replays the backlog on open. The
 *     inactivity sweep in the broker is the safety net: a sender on
 *     `expectReply=true` gets a stalled-receiver notice if no progress
 *     happens within the window.
 *
 * Monitor presence is the TUI agent's authoritative reachability signal:
 * the resolver registers/unregisters the agent with the host's
 * `AgentActivityTracker` on open/close, replacing the older PTY-data
 * heuristic from `TerminalSessionManager`.
 */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { z } from "zod";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

export const agentInboxSubscribeOpenRequestSchema = z.object({
  agentId: z.string(),
  /**
   * Epic the agent belongs to. The resolver uses this to open the
   * caller's epic lease and look up the agent record so it can verify
   * the agent belongs to the calling user.
   */
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
  /**
   * Sender's display title (chat title or TUI agent title). Null when the
   * sender record didn't expose one — receivers should fall back to
   * `fromAgentId` in that case.
   */
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
 * Out-of-band notice the broker emits when a receiver the calling agent
 * had outstanding requests to has gone idle without replying. Surfaced to
 * the monitor as a distinct frame kind so the agent sees a clearly-marked
 * system signal rather than something that looks like a peer message.
 */
export const agentInboxNoticeSchema = z.object({
  kind: z.literal("inactivity"),
  /**
   * The agent the notice is addressed to — the original sender that asked
   * for a reply and is being told its counterparty went silent. Stream
   * subscribers are already scoped to a single agent id, so this is
   * redundant with the subscription target; it's on the wire so the
   * receiving agent (or any future fan-out path) can see "this notice is
   * for me" without consulting subscription metadata.
   */
  senderAgentId: z.string(),
  /** The thread id the original sender owns. */
  responseId: z.string(),
  /** The receiver that went idle (the calling agent's counterparty). */
  receiverAgentId: z.string(),
  /** Receiver's display title at notice time, when known. */
  receiverTitle: z.string().nullable(),
  /** Receiver's harness id at notice time, when known. */
  receiverHarnessId: z.string().nullable(),
  epicId: z.string(),
  /**
   * Why the notice fired, so the monitor can render accurate copy and the
   * sender knows how much to trust it and how to proceed:
   *   - `turn-ended`     - receiver's turn ended (Stop hook) with no reply.
   *     Accurate, primary signal.
   *   - `exited`         - receiver's process exited without replying.
   *     Definitive for this run.
   *   - `quiet`          - watchdog backstop: long PTY silence. Advisory -
   *     the receiver may still be mid-turn; check its transcript.
   *   - `user-stopped`   - the receiver's turn was stopped by the user. It
   *     will not resume on its own.
   *   - `errored`        - the receiver's turn ended on an error (e.g. an
   *     API usage/rate limit). The raw text is in `detail`.
   *   - `awaiting-input` - the receiver is mid-turn but blocked on a human
   *     (asked a question / requested approval); it will not reply until a
   *     person responds. The prompt summary is in `detail`.
   *   - `receiver-cancelled` - the user stopped the receiver agent outright,
   *     so this message was dropped undelivered and the thread is closed.
   *     Informational only: the sender must not re-send or spawn a
   *     replacement (contrast `user-stopped`, where the thread stays open).
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
   * Raw, human-readable detail behind `reason` (the error text for
   * `errored`, a prompt summary for `awaiting-input`), or null when the
   * reason needs no elaboration.
   */
  detail: z.string().nullable(),
  /**
   * For `receiver-cancelled` only: every (receiver, responseId) thread of
   * this sender that the same `agent.stop` dropped, so the monitor can list
   * them in a single notice when the sender was waiting on more than one
   * stopped agent. `receiverAgentId`/`responseId` above mirror the first
   * entry. Null for every other reason.
   */
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
export type AgentInboxNotice = z.infer<typeof agentInboxNoticeSchema>;

export const agentInboxSubscribeServerFrameSchema = z.discriminatedUnion(
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
  serverFrameSchema: agentInboxSubscribeServerFrameSchema,
  clientFrameSchema: agentInboxSubscribeClientFrameSchema,
});

// ─── `agent.inbox.read@1.0` - unary recent-inbox read ─────────────────────
//
// Lets a TUI agent re-read its recently-delivered inbox messages IN FULL.
// The `traycer monitor` stream surfaces each message to the agent through a
// harness background-output notification, which the harness truncates for
// large payloads. This unary read returns the broker's retained ring (full
// bodies, oldest first) so the agent can recover the complete message via a
// direct `traycer agent inbox` call, whose stdout is not subject to that
// notification cap. GUI agents have no truncation problem and never route
// through the broker inbox, so this is a TUI-only recovery path.

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
