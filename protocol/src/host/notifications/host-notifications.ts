/**
 * `host.notifications.list@1.0` - Host-local notification contracts.
 * `host.notifications.list@1.0` and `host.notifications.subscribe@1.0` shipped in host v1.1.7 and are frozen below.
 */
import { z } from "zod";
import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

export const HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP = 500;

export const hostNotificationFilterSchemaV10 = z.enum(["all", "unread"]);
export type HostNotificationFilterV10 = z.infer<
  typeof hostNotificationFilterSchemaV10
>;

/** Every notification kind this build knows, released and unreleased alike. */
export const hostNotificationKindSchema = z.enum([
  "agent.stopped",
  "agent.stalled",
  "workspace.operation.failed",
  "approval.requested",
  "interview.requested",
  "host.operation.finished",
  "browser.human.needed",
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

export const hostNotificationChannelIdSchema = z.enum(["renderer", "email"]);
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
  /**
   * The entity this notification addresses, sourced from the row's durable columns - NOT from the payload.
   * This is the single contract for presence matching, indicator invalidation, and focus consumption: a row whose payload fails the semantic parse still addresses its entity, and a payload cannot claim an entity its row.
   */
  epicId: z.string().min(1).nullable(),
  chatId: z.string().min(1).nullable(),
} as const;

/** The five arms host v1.1.7 shipped. */
const releasedHostNotificationEntryArms = [
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
    kind: z.literal("workspace.operation.failed"),
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
] as const;

/**
 * The RELEASED entry union, shared verbatim by list `@1.0`, list `@2.0`, legacy subscribe `@1.0`, and feed subscribe `@1.0`.
 * Adding an arm therefore requires a new contract version plus a host-side projection that keeps the arm out of every older version's rows, summaries, cursors, and frames - never a post-query filter.
 */
export const hostNotificationEntrySchema = z.discriminatedUnion(
  "kind",
  releasedHostNotificationEntryArms,
);
export type HostNotificationEntry = z.infer<typeof hostNotificationEntrySchema>;

/**
 * Terminal completion of one host-owned operation, addressed to the user rather than to an epic/chat entity.
 */
const hostOperationFinishedEntryArm = z.object({
  ...hostNotificationEntryBaseFields,
  kind: z.literal("host.operation.finished"),
  outcome: hostNotificationOutcomeSchema,
  payload: hostNotificationPayloadSchema,
});

/** Released arms plus `host.operation.finished`; list `@2.1` / feed `@1.1`. */
export const hostNotificationEntrySchemaV21 = z.discriminatedUnion("kind", [
  ...releasedHostNotificationEntryArms,
  hostOperationFinishedEntryArm,
]);
export type HostNotificationEntryV21 = z.infer<
  typeof hostNotificationEntrySchemaV21
>;

/**
 * An agent's browser session hit a step only a person can complete - a login wall, CAPTCHA, MFA challenge, or payment confirmation.
 */
const browserHumanNeededEntryArm = z.object({
  ...hostNotificationEntryBaseFields,
  kind: z.literal("browser.human.needed"),
  outcome: z.null(),
  resolvedAt: z.number().int().nonnegative().nullable(),
  payload: hostNotificationPayloadSchema,
});

/**
 * `@2.1`'s arms plus `browser.human.needed`; list `@2.2` / feed `@1.2` / cloudFeed `@1.1`.
 * A NEW minor rather than a widening of `@2.1`/`@1.1`, because those two lines have shipped: a released client strict-decodes the frame, and zod's within-minor downgrade strips unknown FIELDS but cannot strip an unknown.
 */
export const hostNotificationEntrySchemaV22 = z.discriminatedUnion("kind", [
  ...releasedHostNotificationEntryArms,
  hostOperationFinishedEntryArm,
  browserHumanNeededEntryArm,
]);
export type HostNotificationEntryV22 = z.infer<
  typeof hostNotificationEntrySchemaV22
>;

/** Narrows a `@2.2` entry to the released union. */
export function isReleasedHostNotificationEntry(
  entry: HostNotificationEntryV22,
): entry is HostNotificationEntry {
  return RELEASED_HOST_NOTIFICATION_KINDS.includes(entry.kind);
}

/**
 * Kinds that light the pending-prompt glyph (epic sidebar row / chat indicator / cloud SQL projection) while `resolvedAt` is still `null`.
 */
export const HOST_NOTIFICATION_PENDING_PROMPT_KINDS: readonly HostNotificationKind[] =
  ["approval.requested", "interview.requested", "browser.human.needed"];

/** The kinds every released contract version can carry. FROZEN. */
export const RELEASED_HOST_NOTIFICATION_KINDS: readonly HostNotificationKind[] =
  [
    "agent.stopped",
    "agent.stalled",
    "workspace.operation.failed",
    "approval.requested",
    "interview.requested",
  ];

/** The kinds list `@2.1` / feed `@1.1` carry. FROZEN with those minors. */
export const V21_HOST_NOTIFICATION_KINDS: readonly HostNotificationKind[] = [
  ...RELEASED_HOST_NOTIFICATION_KINDS,
  "host.operation.finished",
];

/** Every kind this build can carry, on the newest version of each surface. */
export const ALL_HOST_NOTIFICATION_KINDS: readonly HostNotificationKind[] = [
  ...V21_HOST_NOTIFICATION_KINDS,
  "browser.human.needed",
];

/** The one negotiated-version → visible-kinds projection. */
export type HostNotificationsSurface =
  | { readonly method: "host.notifications.list" }
  | { readonly method: "host.notifications.feed.subscribe" }
  | { readonly method: "host.notifications.subscribe" }
  | { readonly method: "host.notifications.cloudFeed.subscribe" };

/**
 * Enumerated per SUPPORTED major, never `major > N`.
 * An unknown major therefore falls through to the released set - the only set every contract in this family has ever carried - which fails in the safe direction (a row is withheld, never leaked).
 */
export function visibleHostNotificationKinds(
  surface: HostNotificationsSurface,
  schemaVersion: { readonly major: number; readonly minor: number },
): readonly HostNotificationKind[] {
  switch (surface.method) {
    case "host.notifications.list":
      if (schemaVersion.major === 1) return RELEASED_HOST_NOTIFICATION_KINDS;
      if (schemaVersion.major === 2) {
        if (schemaVersion.minor >= 2) return ALL_HOST_NOTIFICATION_KINDS;
        return schemaVersion.minor === 1
          ? V21_HOST_NOTIFICATION_KINDS
          : RELEASED_HOST_NOTIFICATION_KINDS;
      }
      return RELEASED_HOST_NOTIFICATION_KINDS;
    case "host.notifications.feed.subscribe":
      if (schemaVersion.major === 1) {
        if (schemaVersion.minor >= 2) return ALL_HOST_NOTIFICATION_KINDS;
        return schemaVersion.minor === 1
          ? V21_HOST_NOTIFICATION_KINDS
          : RELEASED_HOST_NOTIFICATION_KINDS;
      }
      return RELEASED_HOST_NOTIFICATION_KINDS;
    // The frozen host-v1.1.7 stream has no successor minor and never will.
    case "host.notifications.subscribe":
      return RELEASED_HOST_NOTIFICATION_KINDS;
    case "host.notifications.cloudFeed.subscribe":
      if (schemaVersion.major === 1) {
        return schemaVersion.minor >= 1
          ? ALL_HOST_NOTIFICATION_KINDS
          : RELEASED_HOST_NOTIFICATION_KINDS;
      }
      return RELEASED_HOST_NOTIFICATION_KINDS;
  }
}

/**
 * Whether the negotiated stream contract declares a `channelEmission` frame.
 * Enumerated per supported (method, major) for the same reason the visibility projection is: an unknown line gets `false`, so a future version that drops the frame - or that this build simply does not know - cannot be.
 */
export function streamCarriesChannelEmissionFrame(
  surface: HostNotificationsSurface,
  schemaVersion: { readonly major: number; readonly minor: number },
): boolean {
  switch (surface.method) {
    // Every installed minor of the feed (`@1.0`, `@1.1`) declares the frame.
    case "host.notifications.feed.subscribe":
      return schemaVersion.major === 1;
    // The frozen released stream declares it at its only version.
    case "host.notifications.subscribe":
      return schemaVersion.major === 1 && schemaVersion.minor === 0;
    // Unary: no frames at all.
    case "host.notifications.list":
      return false;
    // Snapshot/connectionState/pong only, on both installed minors.
    case "host.notifications.cloudFeed.subscribe":
      return false;
  }
}

/** The complement of {@link visibleHostNotificationKinds}. */
export function hiddenHostNotificationKinds(
  surface: HostNotificationsSurface,
  schemaVersion: { readonly major: number; readonly minor: number },
): readonly HostNotificationKind[] {
  const visible = new Set(visibleHostNotificationKinds(surface, schemaVersion));
  return ALL_HOST_NOTIFICATION_KINDS.filter((kind) => !visible.has(kind));
}

export const hostNotificationCursorSchemaV10 = z.object({
  updatedAt: z.number().int().nonnegative(),
  id: z.string(),
});
export type HostNotificationCursorV10 = z.infer<
  typeof hostNotificationCursorSchemaV10
>;

export const hostNotificationsChronologicalCursorSchema = z.object({
  kind: z.literal("chronological"),
  updatedAt: z.number().int().nonnegative(),
  id: z.string(),
});
export type HostNotificationsChronologicalCursor = z.infer<
  typeof hostNotificationsChronologicalCursorSchema
>;

export const hostNotificationsAttentionTierSchema = z.enum([
  "blocking",
  "failure",
]);
export type HostNotificationsAttentionTier = z.infer<
  typeof hostNotificationsAttentionTierSchema
>;

export const hostNotificationsAttentionCursorSchema = z.object({
  kind: z.literal("attention"),
  tier: hostNotificationsAttentionTierSchema,
  updatedAt: z.number().int().nonnegative(),
  id: z.string(),
});
export type HostNotificationsAttentionCursor = z.infer<
  typeof hostNotificationsAttentionCursorSchema
>;

export const hostNotificationsCursorSchema = z.discriminatedUnion("kind", [
  hostNotificationsChronologicalCursorSchema,
  hostNotificationsAttentionCursorSchema,
]);

export const hostNotificationsSummarySchema = z.object({
  unreadCount: z.number().int().nonnegative(),
  attentionCount: z.number().int().nonnegative(),
});
export type HostNotificationsSummary = z.infer<
  typeof hostNotificationsSummarySchema
>;

/** Every exact-removal list on the wire must be duplicate-free: a repeated
 * id would double-apply a deletion in the renderer's normalized replica. */
function nonDuplicateIdArraySchema(min: number) {
  return z
    .array(z.string())
    .min(min)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "removedIds must not contain duplicate ids",
    });
}

export const hostNotificationsListRequestSchemaV10 = z.object({
  filter: hostNotificationFilterSchemaV10,
  limit: z.number().int().min(1).max(500),
  cursor: hostNotificationCursorSchemaV10.optional(),
});
export type HostNotificationsListRequestV10 = z.infer<
  typeof hostNotificationsListRequestSchemaV10
>;

export const hostNotificationsListResponseSchemaV10 = z.object({
  entries: z.array(hostNotificationEntrySchema),
  nextCursor: hostNotificationCursorSchemaV10.nullable(),
});
export type HostNotificationsListResponseV10 = z.infer<
  typeof hostNotificationsListResponseSchemaV10
>;

export const hostNotificationsListRequestSchema = z.discriminatedUnion(
  "filter",
  [
    z.object({
      filter: z.literal("attention"),
      limit: z.number().int().min(1).max(500),
      cursor: hostNotificationsAttentionCursorSchema.optional(),
    }),
    z.object({
      filter: z.literal("recent"),
      limit: z.number().int().min(1).max(500),
      cursor: hostNotificationsChronologicalCursorSchema.optional(),
    }),
    z.object({
      filter: z.literal("unreadRecent"),
      limit: z.number().int().min(1).max(500),
      cursor: hostNotificationsChronologicalCursorSchema.optional(),
    }),
  ],
);
export type HostNotificationsListRequest = z.infer<
  typeof hostNotificationsListRequestSchema
>;

export const hostNotificationsListResponseSchema = z.object({
  entries: z.array(hostNotificationEntrySchema),
  nextCursor: hostNotificationsCursorSchema.nullable(),
});
export type HostNotificationsListResponse = z.infer<
  typeof hostNotificationsListResponseSchema
>;

/** `@2.1` response: identical projection, widened entry union. */
export const hostNotificationsListResponseSchemaV21 = z.object({
  entries: z.array(hostNotificationEntrySchemaV21),
  nextCursor: hostNotificationsCursorSchema.nullable(),
});
export type HostNotificationsListResponseV21 = z.infer<
  typeof hostNotificationsListResponseSchemaV21
>;

/** `@2.2` response: identical projection, entry union widened again. */
export const hostNotificationsListResponseSchemaV22 = z.object({
  entries: z.array(hostNotificationEntrySchemaV22),
  nextCursor: hostNotificationsCursorSchema.nullable(),
});
export type HostNotificationsListResponseV22 = z.infer<
  typeof hostNotificationsListResponseSchemaV22
>;

export const hostNotificationsEntityRefSchema = z.object({
  epicId: z.string(),
  chatId: z.string().optional(),
});
export type HostNotificationsEntityRef = z.infer<
  typeof hostNotificationsEntityRefSchema
>;

/**
 * The entity branch is an atomic view-consumption request.
 * `{ epicId, chatId }` consumes those Task-level rows plus the named child, never sibling chats.
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

/**
 * Explicit dismiss of unresolved `needs_action` rows (the blocking Attention tier - approvals/interviews).
 * Rows already resolved (or that were never `needs_action`) are a no-op.
 */
export const hostNotificationsResolveRequestSchema = z.object({
  occurrences: z
    .array(
      z.object({
        id: z.string(),
        updatedAt: z.number().int().nonnegative(),
        sourceRef: z.string().nullable(),
      }),
    )
    .min(1),
});
export type HostNotificationsResolveRequest = z.infer<
  typeof hostNotificationsResolveRequestSchema
>;

export const hostNotificationsResolveResponseSchema = z.object({});
export type HostNotificationsResolveResponse = z.infer<
  typeof hostNotificationsResolveResponseSchema
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

export const hostNotificationsSubscribeOpenRequestSchemaV10 = z.object({
  filter: hostNotificationFilterSchemaV10,
  initialLimit: z.number().int().min(1).max(500),
});
export type HostNotificationsSubscribeOpenRequestV10 = z.infer<
  typeof hostNotificationsSubscribeOpenRequestSchemaV10
>;

export const hostNotificationsSubscribeOpenRequestSchema = z.object({
  initialAttentionLimit: z.number().int().min(1).max(500),
  initialRecentLimit: z.number().int().min(1).max(500),
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

export const hostNotificationsSubscribeServerFrameSchemaV10 =
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
  ]);
export type HostNotificationsSubscribeServerFrameV10 = z.infer<
  typeof hostNotificationsSubscribeServerFrameSchemaV10
>;

export const hostNotificationsSubscribeServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      attention: z.object({
        entries: z.array(hostNotificationEntrySchema),
        nextCursor: hostNotificationsAttentionCursorSchema.nullable(),
      }),
      recent: z.object({
        entries: z.array(hostNotificationEntrySchema),
        nextCursor: hostNotificationsChronologicalCursorSchema.nullable(),
      }),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("upserted"),
      ...textFrameFields,
      entry: hostNotificationEntrySchema,
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
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
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      // Removal-only lifecycle frame: emitted when a mutation prunes rows and no changed row survives retention, so there is no upsert/ read-state payload to carry.
      kind: z.literal("removed"),
      ...textFrameFields,
      removedIds: nonDuplicateIdArraySchema(1),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("cleared"),
      ...textFrameFields,
      beforeUpdatedAt: z.number().int().nonnegative(),
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
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

/**
 * Feed `@1.1` server frames: the released `@1.0` union with every entry- carrying slot widened to `hostNotificationEntrySchemaV21`.
 * The released shape above must stay byte-identical forever, and a shared builder would let a future edit here silently rewrite it - the same reason `@1.0`'s own frames are spelled out separately from the legacy `V10`.
 */
export const hostNotificationsSubscribeServerFrameSchemaV11 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      attention: z.object({
        entries: z.array(hostNotificationEntrySchemaV21),
        nextCursor: hostNotificationsAttentionCursorSchema.nullable(),
      }),
      recent: z.object({
        entries: z.array(hostNotificationEntrySchemaV21),
        nextCursor: hostNotificationsChronologicalCursorSchema.nullable(),
      }),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("upserted"),
      ...textFrameFields,
      entry: hostNotificationEntrySchemaV21,
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("readStateChanged"),
      ...textFrameFields,
      ids: z.array(z.string()).min(1),
      entityRefs: z.array(hostNotificationsEntityRefSchema),
      readAt: z.number().int().nonnegative().nullable(),
      resolvedAt: z.number().int().nonnegative().nullable(),
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("removed"),
      ...textFrameFields,
      removedIds: nonDuplicateIdArraySchema(1),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("cleared"),
      ...textFrameFields,
      beforeUpdatedAt: z.number().int().nonnegative(),
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("channelEmission"),
      ...textFrameFields,
      emissionId: z.string(),
      channelId: hostNotificationChannelIdSchema,
      severity: hostNotificationSeveritySchema,
      rows: z.array(hostNotificationEntrySchemaV21).min(1),
      reason: hostNotificationsChannelEmissionReasonSchema,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type HostNotificationsSubscribeServerFrameV11 = z.infer<
  typeof hostNotificationsSubscribeServerFrameSchemaV11
>;

/**
 * Feed `@1.2` server frames: the `@1.1` union with every entry-carrying slot widened to `hostNotificationEntrySchemaV22`.
 * Written out in full for the same reason `@1.1` is: `@1.1` has now shipped and must stay byte-identical forever, so it cannot be a base a later edit silently rewrites.
 */
export const hostNotificationsSubscribeServerFrameSchemaV12 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      attention: z.object({
        entries: z.array(hostNotificationEntrySchemaV22),
        nextCursor: hostNotificationsAttentionCursorSchema.nullable(),
      }),
      recent: z.object({
        entries: z.array(hostNotificationEntrySchemaV22),
        nextCursor: hostNotificationsChronologicalCursorSchema.nullable(),
      }),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("upserted"),
      ...textFrameFields,
      entry: hostNotificationEntrySchemaV22,
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("readStateChanged"),
      ...textFrameFields,
      ids: z.array(z.string()).min(1),
      entityRefs: z.array(hostNotificationsEntityRefSchema),
      readAt: z.number().int().nonnegative().nullable(),
      resolvedAt: z.number().int().nonnegative().nullable(),
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("removed"),
      ...textFrameFields,
      removedIds: nonDuplicateIdArraySchema(1),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("cleared"),
      ...textFrameFields,
      beforeUpdatedAt: z.number().int().nonnegative(),
      removedIds: nonDuplicateIdArraySchema(0),
      summary: hostNotificationsSummarySchema,
    }),
    z.object({
      kind: z.literal("channelEmission"),
      ...textFrameFields,
      emissionId: z.string(),
      channelId: hostNotificationChannelIdSchema,
      severity: hostNotificationSeveritySchema,
      rows: z.array(hostNotificationEntrySchemaV22).min(1),
      reason: hostNotificationsChannelEmissionReasonSchema,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type HostNotificationsSubscribeServerFrameV12 = z.infer<
  typeof hostNotificationsSubscribeServerFrameSchemaV12
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

/** Released `indicatorState@1.0` entity flags. FROZEN. */
export const hostNotificationsIndicatorStateSchemaV10 = z.object({
  pendingApproval: z.boolean(),
  pendingInterview: z.boolean(),
  unreadFailure: z.boolean(),
  unreadDone: z.boolean(),
});
export type HostNotificationsIndicatorStateV10 = z.infer<
  typeof hostNotificationsIndicatorStateSchemaV10
>;

/** `indicatorState@1.1`: pending fork truth is independent of feed read state. */
export const hostNotificationsIndicatorStateSchema =
  hostNotificationsIndicatorStateSchemaV10.extend({
    pendingFork: z.boolean(),
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

/** Released `indicatorState@1.0` response. FROZEN. */
export const hostNotificationsIndicatorStateResponseSchemaV10 = z.object({
  epics: z.record(z.string(), hostNotificationsIndicatorStateSchemaV10),
  chats: z.record(z.string(), hostNotificationsIndicatorStateSchemaV10),
});
export type HostNotificationsIndicatorStateResponseV10 = z.infer<
  typeof hostNotificationsIndicatorStateResponseSchemaV10
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
    email: hostNotificationsEmailSetConfigSchema,
  }),
});
export type HostNotificationsSetConfigRequest = z.infer<
  typeof hostNotificationsSetConfigRequestSchema
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
    email: hostNotificationsEmailConfigStateSchema,
  }),
});
export type HostNotificationsConfigResponse = z.infer<
  typeof hostNotificationsConfigResponseSchema
>;

export const hostNotificationsListV10 = defineRpcContract({
  method: "host.notifications.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsListRequestSchemaV10,
  responseSchema: hostNotificationsListResponseSchemaV10,
});

export const hostNotificationsListV20 = defineRpcContract({
  method: "host.notifications.list",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: hostNotificationsListRequestSchema,
  responseSchema: hostNotificationsListResponseSchema,
});

export const hostNotificationsListV21 = defineRpcContract({
  method: "host.notifications.list",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: hostNotificationsListRequestSchema,
  responseSchema: hostNotificationsListResponseSchemaV21,
});

export const hostNotificationsListV22 = defineRpcContract({
  method: "host.notifications.list",
  schemaVersion: { major: 2, minor: 2 } as const,
  requestSchema: hostNotificationsListRequestSchema,
  responseSchema: hostNotificationsListResponseSchemaV22,
});

export const hostNotificationsListUpgradeV10ToV20 = defineUpgradePath<
  typeof hostNotificationsListV10,
  typeof hostNotificationsListV20
>({
  from: hostNotificationsListV10.schemaVersion,
  to: hostNotificationsListV20.schemaVersion,
  upgradeRequest: (request) => ({
    filter: request.filter === "all" ? "recent" : "unreadRecent",
    limit: request.limit,
    ...(request.cursor === undefined
      ? {}
      : { cursor: { kind: "chronological" as const, ...request.cursor } }),
  }),
  upgradeResponse: (response) => ({
    entries: response.entries,
    nextCursor:
      response.nextCursor === null
        ? null
        : { kind: "chronological" as const, ...response.nextCursor },
  }),
});

/**
 * Request-identical, response-widening. The `@2.0` entry union is a strict
 * subset of `@2.1`'s, so every `@2.0` response is already a valid `@2.1` one.
 */
export const hostNotificationsListUpgradeV20ToV21 = defineUpgradePath<
  typeof hostNotificationsListV20,
  typeof hostNotificationsListV21
>({
  from: hostNotificationsListV20.schemaVersion,
  to: hostNotificationsListV21.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/** Request-identical, response-widening, exactly like `@2.0` -> `@2.1`. */
export const hostNotificationsListUpgradeV21ToV22 = defineUpgradePath<
  typeof hostNotificationsListV21,
  typeof hostNotificationsListV22
>({
  from: hostNotificationsListV21.schemaVersion,
  to: hostNotificationsListV22.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const hostNotificationsListDowngradeV22ToV10 = defineDowngradePath<
  typeof hostNotificationsListV22,
  typeof hostNotificationsListV10
>({
  from: hostNotificationsListV22.schemaVersion,
  to: hostNotificationsListV10.schemaVersion,
  downgradeRequest: (request) => {
    if (request.filter === "attention") {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "The attention projection has no representation in host.notifications.list@1.0",
        },
      };
    }
    const { cursor, ...rest } = request;
    return {
      ok: true,
      value: {
        ...rest,
        filter:
          request.filter === "recent" ? ("all" as const) : ("unread" as const),
        ...(cursor === undefined
          ? {}
          : { cursor: { updatedAt: cursor.updatedAt, id: cursor.id } }),
      },
    };
  },
  // `entries` is narrowed rather than passed through.
  // It exists because the bridge must be TOTAL over its declared input: if a future read path ever forgets the projection, a short page beats an unrepresentable arm reaching a v1.1.7 client.
  downgradeResponse: (response) => ({
    ok: true,
    value: {
      entries: response.entries.filter(isReleasedHostNotificationEntry),
      nextCursor:
        response.nextCursor === null
          ? null
          : {
              updatedAt: response.nextCursor.updatedAt,
              id: response.nextCursor.id,
            },
    },
  }),
});

export const hostNotificationsMarkRead = defineRpcContract({
  method: "host.notifications.markRead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsMarkReadRequestSchema,
  responseSchema: hostNotificationsMarkReadResponseSchema,
});

export const hostNotificationsResolve = defineRpcContract({
  method: "host.notifications.resolve",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsResolveRequestSchema,
  responseSchema: hostNotificationsResolveResponseSchema,
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

export const hostNotificationsSubscribeV10 = defineStreamRpcContract({
  method: "host.notifications.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostNotificationsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostNotificationsSubscribeServerFrameSchemaV10,
  clientFrameSchema: hostNotificationsSubscribeClientFrameSchema,
});

export const hostNotificationsFeedSubscribeV10 = defineStreamRpcContract({
  method: "host.notifications.feed.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostNotificationsSubscribeOpenRequestSchema,
  serverFrameSchema: hostNotificationsSubscribeServerFrameSchema,
  clientFrameSchema: hostNotificationsSubscribeClientFrameSchema,
});

/**
 * Cloud-backed feed.
 * A row's identity is its `entryId`: a reopened approval is a DIFFERENT entry, never an edit of the one it replaces, so there is no occurrence token to guard a mutation with and no idempotency key to protect a set-once.
 */
export const hostNotificationsCloudFeedRowSchema = z.object({
  /**
   * The occurrence's identity, minted by the producing host and never reused.
   * OPAQUE to the client: it is a key, never something to parse or order by.
   */
  entryId: z.string().min(1).max(191),
  /**
   * Which machine this happened on.
   * DISPLAY AND NAVIGATION metadata only - mutations address the entry, never the host, so a row from an offline or retired host is still fully actionable in the feed.
   */
  originHostId: z.string().min(1),
  /** The grouping key (the former semantic id, `approval.requested:<chatId>`), demoted from identity. */
  coalesceKey: z.string().min(1).max(191),
  entry: hostNotificationEntrySchema,
  /** Snapshotted by the producing host at creation. Accepted staleness: a
   * later rename does not rewrite an immutable entry. */
  presentation: z.object({
    epicTitle: z.string().nullable(),
    chatTitle: z.string().nullable(),
  }),
});
export type HostNotificationsCloudFeedRow = z.infer<
  typeof hostNotificationsCloudFeedRowSchema
>;

export const hostNotificationsCloudFeedSummarySchema = z.object({
  totalCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  attentionCount: z.number().int().nonnegative(),
});
export type HostNotificationsCloudFeedSummary = z.infer<
  typeof hostNotificationsCloudFeedSummarySchema
>;

export const hostNotificationsCloudFeedSubscribeOpenRequestSchemaV10 = z.object(
  {},
);
export type HostNotificationsCloudFeedSubscribeOpenRequestV10 = z.infer<
  typeof hostNotificationsCloudFeedSubscribeOpenRequestSchemaV10
>;

/**
 * SNAPSHOT-ONLY.
 * Every `snapshot` frame is the complete visible feed at one `version`, so a client never reconstructs state from a sequence of deltas and a dropped or duplicated frame costs nothing.
 */
export const hostNotificationsCloudFeedSubscribeServerFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      connectionState: z.literal("connected"),
      version: z.number().int().nonnegative(),
      rows: z.array(hostNotificationsCloudFeedRowSchema),
      summary: hostNotificationsCloudFeedSummarySchema,
    }),
    z.object({
      kind: z.literal("connectionState"),
      ...textFrameFields,
      connectionState: z.literal("reconnecting"),
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type HostNotificationsCloudFeedSubscribeServerFrameV10 = z.infer<
  typeof hostNotificationsCloudFeedSubscribeServerFrameSchemaV10
>;

export const hostNotificationsCloudFeedSubscribeClientFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ping"), ...textFrameFields }),
  ]);
export type HostNotificationsCloudFeedSubscribeClientFrameV10 = z.infer<
  typeof hostNotificationsCloudFeedSubscribeClientFrameSchemaV10
>;

export const hostNotificationsCloudFeedSubscribeV10 = defineStreamRpcContract({
  method: "host.notifications.cloudFeed.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostNotificationsCloudFeedSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostNotificationsCloudFeedSubscribeServerFrameSchemaV10,
  clientFrameSchema: hostNotificationsCloudFeedSubscribeClientFrameSchemaV10,
});

/**
 * Additive minor of the cloud feed row: identical envelope, entry slot widened to the widest union (`@2.2`) so a `host.operation.finished` or parked-browser occurrence is representable.
 * It grows in place rather than taking a `@1.2` of its own because this minor has not shipped - `released-baseline-compat` is the authority on which lines are frozen.
 */
export const hostNotificationsCloudFeedRowSchemaV11 = z.object({
  ...hostNotificationsCloudFeedRowSchema.shape,
  entry: hostNotificationEntrySchemaV22,
});
export type HostNotificationsCloudFeedRowV11 = z.infer<
  typeof hostNotificationsCloudFeedRowSchemaV11
>;

export const hostNotificationsCloudFeedSubscribeServerFrameSchemaV11 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      connectionState: z.literal("connected"),
      version: z.number().int().nonnegative(),
      rows: z.array(hostNotificationsCloudFeedRowSchemaV11),
      summary: hostNotificationsCloudFeedSummarySchema,
    }),
    z.object({
      kind: z.literal("connectionState"),
      ...textFrameFields,
      connectionState: z.literal("reconnecting"),
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type HostNotificationsCloudFeedSubscribeServerFrameV11 = z.infer<
  typeof hostNotificationsCloudFeedSubscribeServerFrameSchemaV11
>;

/** Additive minor: same open request and client frames, widened entry union. */
export const hostNotificationsCloudFeedSubscribeV11 = defineStreamRpcContract({
  method: "host.notifications.cloudFeed.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: hostNotificationsCloudFeedSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostNotificationsCloudFeedSubscribeServerFrameSchemaV11,
  clientFrameSchema: hostNotificationsCloudFeedSubscribeClientFrameSchemaV10,
});

/**
 * The whole of a per-entry mutation: WHICH entry.
 * A marker is set once and merged by "first time it happened", so the write is idempotent by construction - retry it, duplicate it, race it, and the result is the same.
 */
export const hostNotificationsCloudFeedEntryRequestSchema = z.object({
  entryId: z.string().min(1).max(191),
});
export type HostNotificationsCloudFeedEntryRequest = z.infer<
  typeof hostNotificationsCloudFeedEntryRequestSchema
>;

/** Clear everything the user was LOOKING AT. */
export const hostNotificationsCloudFeedClearAllRequestSchema = z.object({
  observedVersion: z.number().int().nonnegative().nullable(),
});
export type HostNotificationsCloudFeedClearAllRequest = z.infer<
  typeof hostNotificationsCloudFeedClearAllRequestSchema
>;

/** Mark every notification read in the cloud snapshot the user was looking at. */
export const hostNotificationsCloudFeedMarkAllReadRequestSchema =
  hostNotificationsCloudFeedClearAllRequestSchema;
export type HostNotificationsCloudFeedMarkAllReadRequest = z.infer<
  typeof hostNotificationsCloudFeedMarkAllReadRequestSchema
>;

export const hostNotificationsCloudFeedMutationResponseSchema = z
  .object({
    status: z.enum(["applied", "unavailable"]),
    /** The feed version after the mutation; `null` when unavailable. */
    version: z.number().int().nonnegative().nullable(),
  })
  .superRefine((value, context) => {
    if ((value.status === "applied") === (value.version !== null)) return;
    context.addIssue({
      code: "custom",
      path: ["version"],
      message: "version must be non-null exactly when status is applied",
    });
  });
export type HostNotificationsCloudFeedMutationResponse = z.infer<
  typeof hostNotificationsCloudFeedMutationResponseSchema
>;

/** The atomic bulk operation is additive. */
export const hostNotificationsCloudFeedMarkAllReadResponseSchema = z
  .object({
    status: z.enum(["applied", "unavailable", "unsupported"]),
    /** The feed version after the mutation; `null` when it was not applied. */
    version: z.number().int().nonnegative().nullable(),
  })
  .superRefine((value, context) => {
    if ((value.status === "applied") === (value.version !== null)) return;
    context.addIssue({
      code: "custom",
      path: ["version"],
      message: "version must be non-null exactly when status is applied",
    });
  });
export type HostNotificationsCloudFeedMarkAllReadResponse = z.infer<
  typeof hostNotificationsCloudFeedMarkAllReadResponseSchema
>;

export const hostNotificationsCloudFeedMarkRead = defineRpcContract({
  method: "host.notifications.cloudFeed.markRead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsCloudFeedEntryRequestSchema,
  responseSchema: hostNotificationsCloudFeedMutationResponseSchema,
});

export const hostNotificationsCloudFeedResolve = defineRpcContract({
  method: "host.notifications.cloudFeed.resolve",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsCloudFeedEntryRequestSchema,
  responseSchema: hostNotificationsCloudFeedMutationResponseSchema,
});

export const hostNotificationsCloudFeedClear = defineRpcContract({
  method: "host.notifications.cloudFeed.clear",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsCloudFeedEntryRequestSchema,
  responseSchema: hostNotificationsCloudFeedMutationResponseSchema,
});

export const hostNotificationsCloudFeedMarkAllRead = defineRpcContract({
  method: "host.notifications.cloudFeed.markAllRead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsCloudFeedMarkAllReadRequestSchema,
  responseSchema: hostNotificationsCloudFeedMarkAllReadResponseSchema,
});

export const hostNotificationsCloudFeedClearAll = defineRpcContract({
  method: "host.notifications.cloudFeed.clearAll",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsCloudFeedClearAllRequestSchema,
  responseSchema: hostNotificationsCloudFeedMutationResponseSchema,
});

/** Additive minor: same open request and client frames, widened entry union. */
export const hostNotificationsFeedSubscribeV11 = defineStreamRpcContract({
  method: "host.notifications.feed.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: hostNotificationsSubscribeOpenRequestSchema,
  serverFrameSchema: hostNotificationsSubscribeServerFrameSchemaV11,
  clientFrameSchema: hostNotificationsSubscribeClientFrameSchema,
});

/** Additive minor: same open request and client frames, widened entry union. */
export const hostNotificationsFeedSubscribeV12 = defineStreamRpcContract({
  method: "host.notifications.feed.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: hostNotificationsSubscribeOpenRequestSchema,
  serverFrameSchema: hostNotificationsSubscribeServerFrameSchemaV12,
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

export const hostNotificationsIndicatorStateV10 = defineRpcContract({
  method: "host.notifications.indicatorState",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostNotificationsIndicatorStateRequestSchema,
  responseSchema: hostNotificationsIndicatorStateResponseSchemaV10,
});

export const hostNotificationsIndicatorState = defineRpcContract({
  method: "host.notifications.indicatorState",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostNotificationsIndicatorStateRequestSchema,
  responseSchema: hostNotificationsIndicatorStateResponseSchema,
});

/** A v1.0 peer predates fork indicators. */
export const hostNotificationsIndicatorStateUpgradeV10ToV11 = defineUpgradePath<
  typeof hostNotificationsIndicatorStateV10,
  typeof hostNotificationsIndicatorState
>({
  from: hostNotificationsIndicatorStateV10.schemaVersion,
  to: hostNotificationsIndicatorState.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    epics: addPendingForkDefault(response.epics),
    chats: addPendingForkDefault(response.chats),
  }),
});

function addPendingForkDefault(
  states: Readonly<Record<string, HostNotificationsIndicatorStateV10>>,
): Record<string, HostNotificationsIndicatorState> {
  return Object.fromEntries(
    Object.entries(states).map(([id, state]) => [
      id,
      { ...state, pendingFork: false },
    ]),
  );
}

/**
 * `host.notificationHooks.*@1.0` - status, test, and whole-file save surface for the host's notification hooks.
 * Header VALUES never appear here - only hook identity, filters, and a redacted last-result summary.
 */
export const notificationHookLastResultSchema = z
  .object({
    at: z.number(),
    ok: z.boolean(),
    detail: z.string(),
  })
  .strict();
export type NotificationHookLastResult = z.infer<
  typeof notificationHookLastResultSchema
>;

/**
 * One hook exactly as the config file holds it.
 * Env values are read only on the host at delivery time and never cross this wire.
 */
export const notificationHookConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).nullable(),
    enabled: z.boolean(),
    /** `null` = every severity. */
    severities: z.array(hostNotificationSeveritySchema).min(1).nullable(),
    action: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("http"),
          url: z.string().min(1),
          headers: z.record(z.string().min(1), z.string()),
        })
        .strict(),
      z
        .object({
          type: z.literal("command"),
          command: z.string().min(1),
          args: z.array(z.string()),
        })
        .strict(),
    ]),
  })
  .strict();
export type NotificationHookConfig = z.infer<
  typeof notificationHookConfigSchema
>;

export const notificationHookStatusEntrySchema = notificationHookConfigSchema
  .extend({
    lastResult: notificationHookLastResultSchema.nullable(),
  })
  .strict();
export type NotificationHookStatusEntry = z.infer<
  typeof notificationHookStatusEntrySchema
>;

export const notificationHooksSaveRequestSchema = z
  .object({ hooks: z.array(notificationHookConfigSchema) })
  .strict();
export type NotificationHooksSaveRequest = z.infer<
  typeof notificationHooksSaveRequestSchema
>;

export const notificationHooksStatusRequestSchema = z.object({}).strict();
export type NotificationHooksStatusRequest = z.infer<
  typeof notificationHooksStatusRequestSchema
>;

export const notificationHooksStatusResponseSchema = z
  .object({
    configPath: z.string().min(1),
    configError: z.string().nullable(),
    hooks: z.array(notificationHookStatusEntrySchema),
  })
  .strict();
export type NotificationHooksStatusResponse = z.infer<
  typeof notificationHooksStatusResponseSchema
>;

export const notificationHooksTestRequestSchema = z
  .object({ hookId: z.string().min(1) })
  .strict();
export type NotificationHooksTestRequest = z.infer<
  typeof notificationHooksTestRequestSchema
>;

export const notificationHooksTestResponseSchema = z
  .object({
    outcome: z.enum(["ok", "failed", "not-found", "disabled"]),
    detail: z.string(),
  })
  .strict();
export type NotificationHooksTestResponse = z.infer<
  typeof notificationHooksTestResponseSchema
>;

export const hostNotificationHooksStatus = defineRpcContract({
  method: "host.notificationHooks.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: notificationHooksStatusRequestSchema,
  responseSchema: notificationHooksStatusResponseSchema,
});

export const hostNotificationHooksTest = defineRpcContract({
  method: "host.notificationHooks.test",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: notificationHooksTestRequestSchema,
  responseSchema: notificationHooksTestResponseSchema,
});

/** Rewrites the whole hooks file from the given list and returns the fresh status. */
export const hostNotificationHooksSave = defineRpcContract({
  method: "host.notificationHooks.save",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: notificationHooksSaveRequestSchema,
  responseSchema: notificationHooksStatusResponseSchema,
});
