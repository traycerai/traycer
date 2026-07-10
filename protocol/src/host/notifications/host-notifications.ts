/**
 * `host.notifications.*@1.0` / `@1.1` - host-local notification feed contracts.
 *
 * These contracts are separate from the existing global
 * `notifications.subscribe@1.0` YJS relay. Host notification rows are owned by
 * the authenticated user context on the host side; userId never appears in
 * request parameters.
 *
 * Compatibility: `@1.0` remains registered with only the v1.0 kinds. Host-side
 * resolvers must project newer rows for old subscribers: `agent.stalled` is not
 * visible to `@1.0`, `snapshot` entries are filtered to v1.0 kinds, `upserted`
 * frames for unsupported kinds are dropped, and read-state frames for filtered
 * ids are omitted or reduced to visible ids. `channelEmission` is a `@1.1`
 * side-effect frame only and carries no feed-state semantics.
 */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

export const hostNotificationFilterSchema = z.enum(["all", "unread"]);
export type HostNotificationFilter = z.infer<
  typeof hostNotificationFilterSchema
>;

export const hostNotificationKindSchema = z.enum([
  "agent.stopped",
  "approval.requested",
  "interview.requested",
]);
export type HostNotificationKind = z.infer<typeof hostNotificationKindSchema>;

export const hostNotificationKindV11Schema = z.enum([
  "agent.stopped",
  "agent.stalled",
  "approval.requested",
  "interview.requested",
]);
export type HostNotificationKindV11 = z.infer<
  typeof hostNotificationKindV11Schema
>;

export const hostNotificationOutcomeSchema = z.enum([
  "completed",
  "stopped",
  "errored",
]);
export type HostNotificationOutcome = z.infer<
  typeof hostNotificationOutcomeSchema
>;

export const hostNotificationSeveritySchema = z.enum([
  "info",
  "needs_action",
  "failure",
  "done",
]);
export type HostNotificationSeverity = z.infer<
  typeof hostNotificationSeveritySchema
>;

export const hostNotificationChannelIdSchema = z.enum([
  "renderer",
  "webhook",
  "email",
]);
export type HostNotificationChannelId = z.infer<
  typeof hostNotificationChannelIdSchema
>;

export const hostNotificationPayloadSchema = z.record(z.string(), z.unknown());
export type HostNotificationPayload = z.infer<
  typeof hostNotificationPayloadSchema
>;

export const hostNotificationAgentStoppedPayloadV11Schema = z
  .object({
    outcome: hostNotificationOutcomeSchema,
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .catchall(z.unknown());
export type HostNotificationAgentStoppedPayloadV11 = z.infer<
  typeof hostNotificationAgentStoppedPayloadV11Schema
>;

export const hostNotificationEntrySchema = z.object({
  id: z.string(),
  updatedAt: z.number().int().nonnegative(),
  readAt: z.number().int().nonnegative().nullable(),
  kind: hostNotificationKindSchema,
  sourceRef: z.string().nullable(),
  payload: hostNotificationPayloadSchema,
});
export type HostNotificationEntry = z.infer<
  typeof hostNotificationEntrySchema
>;

const hostNotificationEntryBaseV11Fields = {
  id: z.string(),
  updatedAt: z.number().int().nonnegative(),
  readAt: z.number().int().nonnegative().nullable(),
  sourceRef: z.string().nullable(),
  severity: hostNotificationSeveritySchema,
} as const;

export const hostNotificationEntryV11Schema = z.discriminatedUnion("kind", [
  z.object({
    ...hostNotificationEntryBaseV11Fields,
    kind: z.literal("agent.stopped"),
    outcome: hostNotificationOutcomeSchema,
    payload: hostNotificationAgentStoppedPayloadV11Schema,
  }),
  z.object({
    ...hostNotificationEntryBaseV11Fields,
    kind: z.literal("agent.stalled"),
    outcome: z.null(),
    payload: hostNotificationPayloadSchema,
  }),
  z.object({
    ...hostNotificationEntryBaseV11Fields,
    kind: z.literal("approval.requested"),
    outcome: z.null(),
    payload: hostNotificationPayloadSchema,
  }),
  z.object({
    ...hostNotificationEntryBaseV11Fields,
    kind: z.literal("interview.requested"),
    outcome: z.null(),
    payload: hostNotificationPayloadSchema,
  }),
]);
export type HostNotificationEntryV11 = z.infer<
  typeof hostNotificationEntryV11Schema
>;

export const hostNotificationCursorSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  id: z.string(),
});
export type HostNotificationCursor = z.infer<
  typeof hostNotificationCursorSchema
>;

export const hostNotificationsListRequestSchema = z.object({
  filter: hostNotificationFilterSchema,
  limit: z.number().int().min(1).max(500),
  cursor: hostNotificationCursorSchema.optional(),
});
export type HostNotificationsListRequest = z.infer<
  typeof hostNotificationsListRequestSchema
>;

export const hostNotificationsListResponseSchema = z.object({
  entries: z.array(hostNotificationEntrySchema),
  nextCursor: hostNotificationCursorSchema.nullable(),
});
export type HostNotificationsListResponse = z.infer<
  typeof hostNotificationsListResponseSchema
>;

export const hostNotificationsListResponseV11Schema = z.object({
  entries: z.array(hostNotificationEntryV11Schema),
  nextCursor: hostNotificationCursorSchema.nullable(),
});
export type HostNotificationsListResponseV11 = z.infer<
  typeof hostNotificationsListResponseV11Schema
>;

export const hostNotificationsMarkReadRequestSchema = z.object({
  ids: z.array(z.string()).min(1),
});
export type HostNotificationsMarkReadRequest = z.infer<
  typeof hostNotificationsMarkReadRequestSchema
>;

export const hostNotificationsMarkReadResponseSchema = z.object({});
export type HostNotificationsMarkReadResponse = z.infer<
  typeof hostNotificationsMarkReadResponseSchema
>;

export const hostNotificationsMarkAllReadRequestSchema = z.object({
  beforeUpdatedAt: z.number().int().nonnegative(),
});
export type HostNotificationsMarkAllReadRequest = z.infer<
  typeof hostNotificationsMarkAllReadRequestSchema
>;

export const hostNotificationsMarkAllReadResponseSchema = z.object({});
export type HostNotificationsMarkAllReadResponse = z.infer<
  typeof hostNotificationsMarkAllReadResponseSchema
>;

export const hostNotificationsSubscribeOpenRequestSchema = z.object({
  filter: hostNotificationFilterSchema,
  initialLimit: z.number().int().min(1).max(500),
});
export type HostNotificationsSubscribeOpenRequest = z.infer<
  typeof hostNotificationsSubscribeOpenRequestSchema
>;

export const hostNotificationsSubscribeServerFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      entries: z.array(hostNotificationEntrySchema),
    }),
    z.object({
      kind: z.literal("upserted"),
      ...textFrameFields,
      entry: hostNotificationEntrySchema,
    }),
    z.object({
      kind: z.literal("readStateChanged"),
      ...textFrameFields,
      ids: z.array(z.string()).min(1),
      // Nullable branch is reserved for future mark-unread; v1 only produces timestamps.
      readAt: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type HostNotificationsSubscribeServerFrame = z.infer<
  typeof hostNotificationsSubscribeServerFrameSchema
>;

export const hostNotificationsSubscribeClientFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type HostNotificationsSubscribeClientFrame = z.infer<
  typeof hostNotificationsSubscribeClientFrameSchema
>;

export const hostNotificationsChannelEmissionReasonSchema = z.enum([
  "new",
  "coalesced",
]);
export type HostNotificationsChannelEmissionReason = z.infer<
  typeof hostNotificationsChannelEmissionReasonSchema
>;

export const hostNotificationsPresenceEntitySchema = z.object({
  epicId: z.string().optional(),
  chatId: z.string().optional(),
});
export type HostNotificationsPresenceEntity = z.infer<
  typeof hostNotificationsPresenceEntitySchema
>;

export const hostNotificationsSubscribeServerFrameV11Schema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      entries: z.array(hostNotificationEntryV11Schema),
    }),
    z.object({
      kind: z.literal("upserted"),
      ...textFrameFields,
      entry: hostNotificationEntryV11Schema,
    }),
    z.object({
      kind: z.literal("readStateChanged"),
      ...textFrameFields,
      ids: z.array(z.string()).min(1),
      readAt: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("channelEmission"),
      ...textFrameFields,
      emissionId: z.string(),
      channelId: hostNotificationChannelIdSchema,
      severity: hostNotificationSeveritySchema,
      rows: z.array(hostNotificationEntryV11Schema).min(1),
      reason: hostNotificationsChannelEmissionReasonSchema,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type HostNotificationsSubscribeServerFrameV11 = z.infer<
  typeof hostNotificationsSubscribeServerFrameV11Schema
>;

export const hostNotificationsSubscribeClientFrameV11Schema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("presence"),
      ...textFrameFields,
      windowId: z.string(),
      focused: z.boolean(),
      entity: hostNotificationsPresenceEntitySchema.nullable(),
      at: z.number().int().nonnegative(),
    }),
  ]);
export type HostNotificationsSubscribeClientFrameV11 = z.infer<
  typeof hostNotificationsSubscribeClientFrameV11Schema
>;

export const hostNotificationsChannelMatrixSchema = z.record(
  hostNotificationSeveritySchema,
  z.record(hostNotificationChannelIdSchema, z.boolean()),
);
export type HostNotificationsChannelMatrix = z.infer<
  typeof hostNotificationsChannelMatrixSchema
>;

export const hostNotificationsSecretWriteSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("leaveUnchanged"),
  }),
  z.object({
    kind: z.literal("clear"),
  }),
  z.object({
    kind: z.literal("set"),
    value: z.string().min(1),
  }),
]);
export type HostNotificationsSecretWrite = z.infer<
  typeof hostNotificationsSecretWriteSchema
>;

export const hostNotificationsWebhookSetConfigSchema = z.object({
  url: z.string().url().nullable(),
  signingSecret: hostNotificationsSecretWriteSchema,
});
export type HostNotificationsWebhookSetConfig = z.infer<
  typeof hostNotificationsWebhookSetConfigSchema
>;

export const hostNotificationsEmailSetConfigSchema = z.object({
  host: z.string().nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  user: z.string().nullable(),
  password: hostNotificationsSecretWriteSchema,
  from: z.string().nullable(),
});
export type HostNotificationsEmailSetConfig = z.infer<
  typeof hostNotificationsEmailSetConfigSchema
>;

export const hostNotificationsConfigRequestSchema = z.object({});
export type HostNotificationsConfigRequest = z.infer<
  typeof hostNotificationsConfigRequestSchema
>;

export const hostNotificationsSetConfigRequestSchema = z.object({
  matrix: hostNotificationsChannelMatrixSchema,
  channels: z.object({
    renderer: z.object({}),
    webhook: hostNotificationsWebhookSetConfigSchema,
    email: hostNotificationsEmailSetConfigSchema,
  }),
});
export type HostNotificationsSetConfigRequest = z.infer<
  typeof hostNotificationsSetConfigRequestSchema
>;

export const hostNotificationsWebhookConfigStateSchema = z.object({
  url: z.string().url().nullable(),
  credentialConfigured: z.boolean(),
  lastError: z.string().nullable(),
});
export type HostNotificationsWebhookConfigState = z.infer<
  typeof hostNotificationsWebhookConfigStateSchema
>;

export const hostNotificationsEmailConfigStateSchema = z.object({
  host: z.string().nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  user: z.string().nullable(),
  from: z.string().nullable(),
  credentialConfigured: z.boolean(),
  lastError: z.string().nullable(),
});
export type HostNotificationsEmailConfigState = z.infer<
  typeof hostNotificationsEmailConfigStateSchema
>;

export const hostNotificationsConfigResponseSchema = z.object({
  matrix: hostNotificationsChannelMatrixSchema,
  channels: z.object({
    renderer: z.object({
      lastError: z.string().nullable(),
    }),
    webhook: hostNotificationsWebhookConfigStateSchema,
    email: hostNotificationsEmailConfigStateSchema,
  }),
});
export type HostNotificationsConfigResponse = z.infer<
  typeof hostNotificationsConfigResponseSchema
>;

export const hostNotificationsListV10 = defineRpcContract({
  method: "host.notifications.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsListRequestSchema,
  responseSchema: hostNotificationsListResponseSchema,
});

export const hostNotificationsListV11 = defineRpcContract({
  method: "host.notifications.list",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostNotificationsListRequestSchema,
  responseSchema: hostNotificationsListResponseV11Schema,
});

export const hostNotificationsListUpgradeV10ToV11 = defineUpgradePath<
  typeof hostNotificationsListV10,
  typeof hostNotificationsListV11
>({
  from: hostNotificationsListV10.schemaVersion,
  to: hostNotificationsListV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    entries: response.entries.map((entry) => {
      if (entry.kind === "agent.stopped") {
        return {
          id: entry.id,
          updatedAt: entry.updatedAt,
          readAt: entry.readAt,
          kind: entry.kind,
          sourceRef: entry.sourceRef,
          payload: {
            ...entry.payload,
            outcome: "completed" as const,
          },
          severity: "done" as const,
          outcome: "completed" as const,
        };
      }

      return {
        id: entry.id,
        updatedAt: entry.updatedAt,
        readAt: entry.readAt,
        kind: entry.kind,
        sourceRef: entry.sourceRef,
        payload: entry.payload,
        severity: "needs_action" as const,
        outcome: null,
      };
    }),
    nextCursor: response.nextCursor,
  }),
});

export const hostNotificationsMarkReadV10 = defineRpcContract({
  method: "host.notifications.markRead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsMarkReadRequestSchema,
  responseSchema: hostNotificationsMarkReadResponseSchema,
});

export const hostNotificationsMarkAllReadV10 = defineRpcContract({
  method: "host.notifications.markAllRead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsMarkAllReadRequestSchema,
  responseSchema: hostNotificationsMarkAllReadResponseSchema,
});

export const hostNotificationsSubscribeV10 = defineStreamRpcContract({
  method: "host.notifications.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostNotificationsSubscribeOpenRequestSchema,
  serverFrameSchema: hostNotificationsSubscribeServerFrameSchema,
  clientFrameSchema: hostNotificationsSubscribeClientFrameSchema,
});

export const hostNotificationsSubscribeV11 = defineStreamRpcContract({
  method: "host.notifications.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: hostNotificationsSubscribeOpenRequestSchema,
  serverFrameSchema: hostNotificationsSubscribeServerFrameV11Schema,
  clientFrameSchema: hostNotificationsSubscribeClientFrameV11Schema,
});

export const hostNotificationsGetConfigV10 = defineRpcContract({
  method: "host.notifications.getConfig",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsConfigRequestSchema,
  responseSchema: hostNotificationsConfigResponseSchema,
});

export const hostNotificationsSetConfigV10 = defineRpcContract({
  method: "host.notifications.setConfig",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsSetConfigRequestSchema,
  responseSchema: hostNotificationsConfigResponseSchema,
});
