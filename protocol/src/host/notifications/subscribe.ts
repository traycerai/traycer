/**
 * `notifications.subscribe@1.0` / `@1.1` - versioned streaming-RPC contract for the per-user notifications Y.Doc subscription.
 * Server-only: the GUI reads activity and never publishes it, so there is no matching client frame.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostBusyBreakdownSchema } from "@traycer/protocol/host/status/contracts";

/**
 * Awareness state field under which each host publishes its agent-activity presence for the per-user notification room (`notifications:<userId>`), grouped by epic
 * Shared here so writer and reader cannot drift.
 */
export const AGENT_ACTIVITY_AWARENESS_FIELD = "agentActivityByEpic";

/**
 * Awareness state field under which each host stamps its own `hostId` on the {@link AGENT_ACTIVITY_AWARENESS_FIELD} entry it publishes.
 * Never treat it as a key or a filter.
 */
export const AGENT_ACTIVITY_HOST_ID_AWARENESS_FIELD = "agentActivityHostId";

/**
 * `host.status@1.2` - Awareness state field under which each host publishes its own RUNTIME status - the drain-relevant facts about what it is doing right now
 * Defaulting it to `busySessionCount: 0` would state, in the UI, that ending the update now costs nothing - about a host that never said so.
 */
export const HOST_RUNTIME_STATUS_AWARENESS_FIELD = "hostRuntimeStatus";

/**
 * `host.status@1.2` - Shape-check for one {@link HOST_RUNTIME_STATUS_AWARENESS_FIELD} value.
 * Shared so the publishing host and the reading client cannot drift on a field the stream contract's `major`/`minor` negotiation does not cover.
 */
export const hostRuntimeStatusAwarenessSchema = z.object({
  busy: z.boolean(),
  busySessionCount: z.number().int().nonnegative(),
  updateProgress: z
    .object({
      state: z.enum(["updating", "failed"]),
      error: z.string().nullable(),
    })
    .nullable(),
  busyBreakdown: hostBusyBreakdownSchema.nullable().optional(),
});
export type HostRuntimeStatusAwareness = z.infer<
  typeof hostRuntimeStatusAwarenessSchema
>;

const hostRuntimeStatusAwarenessEntrySchema = z.object({
  [HOST_RUNTIME_STATUS_AWARENESS_FIELD]: hostRuntimeStatusAwarenessSchema,
});

/** Reads one awareness entry's runtime status, or `null` when the entry does not carry a usable one. */
export function readHostRuntimeStatusAwareness(
  entry: unknown,
): HostRuntimeStatusAwareness | null {
  const parsed = hostRuntimeStatusAwarenessEntrySchema.safeParse(entry);
  return parsed.success
    ? parsed.data[HOST_RUNTIME_STATUS_AWARENESS_FIELD]
    : null;
}

export const notificationsSubscribeOpenRequestSchema = z.object({});
export type NotificationsSubscribeOpenRequest = z.infer<
  typeof notificationsSubscribeOpenRequestSchema
>;

const notificationsSnapshotMetaSchema = z.object({
  schemaVersion: z.string(),
});

// ─── Frozen notifications.subscribe@1.0 shape (as shipped) ────────────────
export const notificationsSubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      meta: notificationsSnapshotMetaSchema,
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("update"),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type NotificationsSubscribeServerFrameV10 = z.infer<
  typeof notificationsSubscribeServerFrameSchemaV10
>;

// ─── notifications.subscribe@1.1 - additive: room awareness ───────────────
// Eligibility MUST be gated on the NEGOTIATED minor by the emitting resolver: a @1.0 client must never be sent this frame.
export const notificationsSubscribeServerFrameSchemaV11 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      meta: notificationsSnapshotMetaSchema,
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("update"),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("awareness"),
      hasBinaryPayload: z.literal(true),
    }),
  ],
);
export type NotificationsSubscribeServerFrameV11 = z.infer<
  typeof notificationsSubscribeServerFrameSchemaV11
>;

/** The latest installed shape. Host code builds frames against this. */
export const notificationsSubscribeServerFrameSchema =
  notificationsSubscribeServerFrameSchemaV11;
export type NotificationsSubscribeServerFrame =
  NotificationsSubscribeServerFrameV11;

export const notificationsSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("applyUpdate"),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type NotificationsSubscribeClientFrame = z.infer<
  typeof notificationsSubscribeClientFrameSchema
>;

export const notificationsSubscribeV10 = defineStreamRpcContract({
  method: "notifications.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: notificationsSubscribeOpenRequestSchema,
  serverFrameSchema: notificationsSubscribeServerFrameSchemaV10,
  clientFrameSchema: notificationsSubscribeClientFrameSchema,
});

export const notificationsSubscribeV11 = defineStreamRpcContract({
  method: "notifications.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: notificationsSubscribeOpenRequestSchema,
  serverFrameSchema: notificationsSubscribeServerFrameSchemaV11,
  clientFrameSchema: notificationsSubscribeClientFrameSchema,
});
