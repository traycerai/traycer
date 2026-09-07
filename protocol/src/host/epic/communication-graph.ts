/**
 * `epic.communicationGraph.subscribe@1.0` - per-epic event log. Rows are `id`-ascending, exactly-once for wire-representable kinds; unrepresentable kinds are skipped (id gaps are not loss).
 * Frame kind carries no activity semantics. Do not add this method to the unary released floor.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

/**
 * Event classes captured at the host's choke points
 * A stored row whose kind the serving host cannot represent here is therefore skipped outright (see the representability exception in the module doc), and adding a kind is a NEW MINOR, never a silent widening.
 */
export const epicCommunicationGraphEventKindSchema = z.enum([
  "a2a_message",
  "a2a_notice",
  "agent_created",
]);
export type EpicCommunicationGraphEventKind = z.infer<
  typeof epicCommunicationGraphEventKindSchema
>;

/** Where the event can be re-opened in the product, so a timeline entry can jump to its exact source: */
export const epicCommunicationGraphOriginKindSchema = z.enum([
  "gui_block",
  "gui_message",
  "tui_session",
]);
export type EpicCommunicationGraphOriginKind = z.infer<
  typeof epicCommunicationGraphOriginKindSchema
>;

/**
 * One row of the host's append-only event log, on the wire.
 * `messageText` carries the FULL message body, never a truncation or a summary: for TUI-received and TUI↔TUI messages nothing else durable exists, so truncating here would silently destroy the record.
 */
export const epicCommunicationGraphEventSchema = z.object({
  /**
   * Autoincrement row id. Monotonic per host and doubles as the resume cursor
   * (`sinceCursor`). Not comparable across hosts.
   */
  id: z.number().int().positive(),
  kind: epicCommunicationGraphEventKindSchema,
  /** Host wall clock at capture, epoch millis. Ordering key for the timeline. */
  timestamp: z.number().int(),
  /** The sending agent. */
  senderAgentId: z.string().nullable(),
  /** The receiving agent. */
  receiverAgentId: z.string().nullable(),
  /** The broker thread id (reused across a directed pair). */
  responseId: z.string().nullable(),
  /**
   * The `responseId` this message answers, or null for a new request. Drives
   * reply-vs-request edge styling and open-thread detection.
   */
  inReplyTo: z.string().nullable(),
  /** Whether the sender asked for a reply. */
  expectReply: z.boolean().nullable(),
  /** Full message or notice text, not a preview. */
  messageText: z.string().nullable(),
  /**
   * `a2a_notice` ONLY: why the broker gave up on the thread (`turn-ended`, `errored`, `awaiting-input`, ...).
   */
  noticeReason: z.string().nullable(),
  /** Origin ref: surface the event can be re-opened on, or null if unknown. */
  originKind: epicCommunicationGraphOriginKindSchema.nullable(),
  originChatId: z.string().nullable(),
  /** Origin ref: block or message id to anchor on within `originChatId`. */
  originRefId: z.string().nullable(),
});
export type EpicCommunicationGraphEvent = z.infer<
  typeof epicCommunicationGraphEventSchema
>;

export const epicCommunicationGraphSubscribeOpenRequestSchema = z.object({
  epicId: z.string(),
  /**
   * Highest event `id` the client has already applied FOR THIS HOST, or null for a first open.
   * Required-and-nullable rather than optional so the resume intent is always explicit on the wire - "start from the beginning" and "I forgot to send a cursor" are not the same request.
   */
  sinceCursor: z.number().int().nonnegative().nullable(),
});
export type EpicCommunicationGraphSubscribeOpenRequest = z.infer<
  typeof epicCommunicationGraphSubscribeOpenRequestSchema
>;

export const epicCommunicationGraphSubscribeServerFrameSchema =
  z.discriminatedUnion("kind", [
    /**
     * Exactly one per subscription, emitted first: the INITIAL BATCH of rows above the open's `sinceCursor`, ordered by `id` ascending.
     * Do NOT treat the end of the snapshot as "caught up to now".
     */
    z.object({
      kind: z.literal("snapshot"),
      epicId: z.string(),
      events: z.array(epicCommunicationGraphEventSchema),
      /** Highest row id this host's log held when the subscription OPENED, or null when the log was empty. */
      headId: z.number().int().positive().nullable(),
      ...textFrameFields,
    }),
    /**
     * One row, delivered after the snapshot, continuing the same strictly `id`-ascending sequence.
     * A row arrives here for any of three reasons the client cannot tell apart and must not try to
     */
    z.object({
      kind: z.literal("event"),
      epicId: z.string(),
      event: epicCommunicationGraphEventSchema,
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type EpicCommunicationGraphSubscribeServerFrame = z.infer<
  typeof epicCommunicationGraphSubscribeServerFrameSchema
>;

export const epicCommunicationGraphSubscribeClientFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type EpicCommunicationGraphSubscribeClientFrame = z.infer<
  typeof epicCommunicationGraphSubscribeClientFrameSchema
>;

export const epicCommunicationGraphSubscribeV10 = defineStreamRpcContract({
  method: "epic.communicationGraph.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: epicCommunicationGraphSubscribeOpenRequestSchema,
  serverFrameSchema: epicCommunicationGraphSubscribeServerFrameSchema,
  clientFrameSchema: epicCommunicationGraphSubscribeClientFrameSchema,
});

/**
 * `host.communicationGraph.subscribe@1.0` - the CLOUD-relayed counterpart of `epic.communicationGraph.subscribe` above: a per-epic Communication Graph feed sourced from Traycer Cloud (any host the user is signed into.
 */
export const hostCommunicationGraphCloudFeedCursorSchema = z.object({
  ingestVersion: z.number().int().nonnegative(),
  eventId: z.string().min(1).max(191),
});
export type HostCommunicationGraphCloudFeedCursor = z.infer<
  typeof hostCommunicationGraphCloudFeedCursorSchema
>;

/** One cloud-ingested row on the wire. */
export const hostCommunicationGraphCloudFeedEventSchema = z.object({
  /** The cloud's globally stable identity for this event; opaque to the client. */
  eventId: z.string().min(1).max(191),
  /**
   * Which host originally captured this event - display/navigation metadata, not authorization.
   * A source jump to an offline origin host is disabled, never redirected.
   */
  originHostId: z.string().min(1),
  /** The origin host's own per-host local sequence at capture time. */
  originSequence: z.number().int().nonnegative(),
  /** The cloud's ingestion-order position for this row; half of its cursor. */
  ingestVersion: z.number().int().nonnegative(),
  kind: epicCommunicationGraphEventKindSchema,
  /** Origin host wall clock at capture, epoch millis. */
  capturedAt: z.number().int(),
  senderAgentId: z.string().nullable(),
  receiverAgentId: z.string().nullable(),
  responseId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  expectReply: z.boolean().nullable(),
  messageText: z.string().nullable(),
  noticeReason: z.string().nullable(),
  originKind: epicCommunicationGraphOriginKindSchema.nullable(),
  originChatId: z.string().nullable(),
  originRefId: z.string().nullable(),
  /**
   * True for backlog uploaded by a lane that had not yet caught up when this row was captured; false for a row captured by an already-live lane.
   */
  historicalUpload: z.boolean(),
});
export type HostCommunicationGraphCloudFeedEvent = z.infer<
  typeof hostCommunicationGraphCloudFeedEventSchema
>;

export const hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10 =
  z.object({
    epicId: z.string(),
    /**
     * Highest cursor the client has already applied FOR THE CLOUD FEED, or null for a first open / no retained checkpoint.
     * Required-and-nullable for the same reason as the local contract's `sinceCursor`: "start from the beginning" and "I forgot to send a cursor" must never be the same request on the wire.
     */
    sinceCursor: hostCommunicationGraphCloudFeedCursorSchema.nullable(),
  });
export type HostCommunicationGraphCloudFeedSubscribeOpenRequestV10 = z.infer<
  typeof hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10
>;

export const hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    /**
     * Host-authoritative confirmation that this stream serves the cloud plane.
     * The renderer never derives this verdict from subscription, entitlement, or free-tier state itself.
     */
    z.object({
      kind: z.literal("availability"),
      availability: z.literal("available"),
      ...textFrameFields,
    }),
    /**
     * The first frame of this kind in an available-authority epoch is the bounded initial batch above the retained cursor.
     */
    z.object({
      kind: z.literal("snapshot"),
      epicId: z.string(),
      events: z.array(hostCommunicationGraphCloudFeedEventSchema),
      /**
       * On the initial snapshot, the cloud's headVersion as of the first read: the arrival boundary, exactly like the local contract's `headId`.
       * Never negative; a graph with nothing ingested yet reports 0, not null, because the cloud's version is a counter, not a "last row" pointer.
       */
      headVersion: z.number().int().nonnegative(),
      /** Optional retained-row deletion boundary. Rows below it are obsolete. */
      frontier: z.number().int().nonnegative().optional(),
      ...textFrameFields,
    }),
    /**
     * One row, continuing the same cursor-ascending sequence after the initial snapshot and across any later frontier-bearing snapshots.
     */
    z.object({
      kind: z.literal("event"),
      epicId: z.string(),
      event: hostCommunicationGraphCloudFeedEventSchema,
      ...textFrameFields,
    }),
    /**
     * Explicit proof that every cloud row through `headVersion` has been accounted for, including rows the serving host skipped because this wire version cannot represent them.
     */
    z.object({
      kind: z.literal("caughtUp"),
      epicId: z.string(),
      headVersion: z.number().int().nonnegative(),
      cursor: hostCommunicationGraphCloudFeedCursorSchema.nullable(),
      ...textFrameFields,
    }),
    /**
     * The relay could not currently reach the cloud feed (transient HTTP failure, or the relay has not yet re-authenticated).
     * The client keeps its retained graph and cursor untouched and waits for either a later `event`/`snapshot` frame or a reconnect - never a reason to discard state or fall back to a bootstrap read.
     */
    z.object({
      kind: z.literal("connectionState"),
      connectionState: z.literal("reconnecting"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type HostCommunicationGraphCloudFeedSubscribeServerFrameV10 = z.infer<
  typeof hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10
>;

export const hostCommunicationGraphCloudFeedSubscribeClientFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type HostCommunicationGraphCloudFeedSubscribeClientFrameV10 = z.infer<
  typeof hostCommunicationGraphCloudFeedSubscribeClientFrameSchemaV10
>;

export const hostCommunicationGraphCloudFeedSubscribeV10 =
  defineStreamRpcContract({
    method: "host.communicationGraph.subscribe",
    schemaVersion: { major: 1, minor: 0 } as const,
    openRequestSchema:
      hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10,
    serverFrameSchema:
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10,
    clientFrameSchema:
      hostCommunicationGraphCloudFeedSubscribeClientFrameSchemaV10,
  });
