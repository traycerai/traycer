/**
 * `host.notifications.*@1.0` - host-local notification feed contracts.
 *
 * The notifications surface was never released. Its one flat version therefore
 * carries the complete feed, stream, and indicator shapes; the unary methods
 * advertise through the optional-capabilities channel rather than the released
 * RPC floor.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

export const HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP = 500;

export const hostNotificationFilterSchema = z.enum(["all", "unread"]);
export type HostNotificationFilter = z.infer<
  typeof hostNotificationFilterSchema
>;

export const hostNotificationKindSchema = z.enum([
  "agent.stopped",
  "agent.stalled",
  "approval.requested",
  "interview.requested",
]);
export type HostNotificationKind = z.infer<typeof hostNotificationKindSchema>;

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

export const hostNotificationAgentStoppedPayloadSchema = z
  .object({
    outcome: hostNotificationOutcomeSchema,
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .catchall(z.unknown());
export type HostNotificationAgentStoppedPayload = z.infer<
  typeof hostNotificationAgentStoppedPayloadSchema
>;

const hostNotificationEntryBaseFields = {
  id: z.string(),
  updatedAt: z.number().int().nonnegative(),
  readAt: z.number().int().nonnegative().nullable(),
  sourceRef: z.string().nullable(),
  severity: hostNotificationSeveritySchema,
} as const;

export const hostNotificationEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    ...hostNotificationEntryBaseFields,
    kind: z.literal("agent.stopped"),
    outcome: hostNotificationOutcomeSchema,
    payload: hostNotificationAgentStoppedPayloadSchema,
  }),
  z.object({
    ...hostNotificationEntryBaseFields,
    kind: z.literal("agent.stalled"),
    outcome: z.literal("errored"),
    payload: hostNotificationPayloadSchema,
  }),
  z.object({
    ...hostNotificationEntryBaseFields,
    kind: z.literal("approval.requested"),
    outcome: z.null(),
    resolvedAt: z.number().int().nonnegative().nullable(),
    payload: hostNotificationPayloadSchema,
  }),
  z.object({
    ...hostNotificationEntryBaseFields,
    kind: z.literal("interview.requested"),
    outcome: z.null(),
    resolvedAt: z.number().int().nonnegative().nullable(),
    payload: hostNotificationPayloadSchema,
  }),
]);
export type HostNotificationEntry = z.infer<typeof hostNotificationEntrySchema>;

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

export const hostNotificationsEntityRefSchema = z.object({
  epicId: z.string(),
  chatId: z.string().optional(),
});
export type HostNotificationsEntityRef = z.infer<
  typeof hostNotificationsEntityRefSchema
>;

/**
 * The entity branch is an atomic view-consumption request. Hosts must only
 * mark unread `done`/`failure` rows in the named entity: `{ epicId }` means
 * epic-level (`chatId IS NULL`) rows only, never every chat in that epic.
 */
export const hostNotificationsMarkReadRequestSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ids"),
      ids: z.array(z.string()).min(1),
    }),
    z.object({
      kind: z.literal("entity"),
      entity: hostNotificationsEntityRefSchema,
    }),
  ],
);
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

export const hostNotificationsClearAllRequestSchema = z.object({
  beforeUpdatedAt: z.number().int().nonnegative(),
});
export type HostNotificationsClearAllRequest = z.infer<
  typeof hostNotificationsClearAllRequestSchema
>;

export const hostNotificationsClearAllResponseSchema = z.object({});
export type HostNotificationsClearAllResponse = z.infer<
  typeof hostNotificationsClearAllResponseSchema
>;

export const hostNotificationsSubscribeOpenRequestSchema = z.object({
  filter: hostNotificationFilterSchema,
  initialLimit: z.number().int().min(1).max(500),
});
export type HostNotificationsSubscribeOpenRequest = z.infer<
  typeof hostNotificationsSubscribeOpenRequestSchema
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

export const hostNotificationsSubscribeServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
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
      // Supplementary targeted-invalidation hints. Legacy/entity-less rows
      // legitimately emit an empty set; ids and state timestamps are canonical.
      entityRefs: z.array(hostNotificationsEntityRefSchema),
      readAt: z.number().int().nonnegative().nullable(),
      resolvedAt: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("cleared"),
      ...textFrameFields,
      beforeUpdatedAt: z.number().int().nonnegative(),
    }),
    z.object({
      kind: z.literal("channelEmission"),
      ...textFrameFields,
      emissionId: z.string(),
      channelId: hostNotificationChannelIdSchema,
      severity: hostNotificationSeveritySchema,
      rows: z.array(hostNotificationEntrySchema).min(1),
      reason: hostNotificationsChannelEmissionReasonSchema,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ],
);
export type HostNotificationsSubscribeServerFrame = z.infer<
  typeof hostNotificationsSubscribeServerFrameSchema
>;

export const hostNotificationsSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
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
  ],
);
export type HostNotificationsSubscribeClientFrame = z.infer<
  typeof hostNotificationsSubscribeClientFrameSchema
>;

export const hostNotificationsIndicatorStateSchema = z.object({
  pendingPrompt: z.boolean(),
  unreadFailure: z.boolean(),
  unreadDone: z.boolean(),
});
export type HostNotificationsIndicatorState = z.infer<
  typeof hostNotificationsIndicatorStateSchema
>;

export const hostNotificationsIndicatorStateRequestSchema = z.object({
  epicIds: z.array(z.string()).max(HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP),
  chatIds: z.array(z.string()).max(HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP),
});
export type HostNotificationsIndicatorStateRequest = z.infer<
  typeof hostNotificationsIndicatorStateRequestSchema
>;

export const hostNotificationsIndicatorStateResponseSchema = z.object({
  epics: z.record(z.string(), hostNotificationsIndicatorStateSchema),
  chats: z.record(z.string(), hostNotificationsIndicatorStateSchema),
});
export type HostNotificationsIndicatorStateResponse = z.infer<
  typeof hostNotificationsIndicatorStateResponseSchema
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

export const hostNotificationsList = defineRpcContract({
  method: "host.notifications.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsListRequestSchema,
  responseSchema: hostNotificationsListResponseSchema,
});

export const hostNotificationsMarkRead = defineRpcContract({
  method: "host.notifications.markRead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsMarkReadRequestSchema,
  responseSchema: hostNotificationsMarkReadResponseSchema,
});

export const hostNotificationsMarkAllRead = defineRpcContract({
  method: "host.notifications.markAllRead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsMarkAllReadRequestSchema,
  responseSchema: hostNotificationsMarkAllReadResponseSchema,
});

export const hostNotificationsClearAll = defineRpcContract({
  method: "host.notifications.clearAll",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsClearAllRequestSchema,
  responseSchema: hostNotificationsClearAllResponseSchema,
});

export const hostNotificationsSubscribe = defineStreamRpcContract({
  method: "host.notifications.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostNotificationsSubscribeOpenRequestSchema,
  serverFrameSchema: hostNotificationsSubscribeServerFrameSchema,
  clientFrameSchema: hostNotificationsSubscribeClientFrameSchema,
});

export const hostNotificationsGetConfig = defineRpcContract({
  method: "host.notifications.getConfig",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsConfigRequestSchema,
  responseSchema: hostNotificationsConfigResponseSchema,
});

export const hostNotificationsSetConfig = defineRpcContract({
  method: "host.notifications.setConfig",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsSetConfigRequestSchema,
  responseSchema: hostNotificationsConfigResponseSchema,
});

export const hostNotificationsIndicatorState = defineRpcContract({
  method: "host.notifications.indicatorState",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsIndicatorStateRequestSchema,
  responseSchema: hostNotificationsIndicatorStateResponseSchema,
});
