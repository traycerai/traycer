import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { providerProfileAccentColorSchema } from "./provider-schemas";
import {
  profileCopyAttemptSchema,
  profileCopyHostIdSchema,
  profileCopyIdSchema,
  profileCopyOutcomeSchema,
  profileCopyPreviewResponseSchema,
  profileCopyProviderSchema,
  profileCopySourceProfileIdSchema,
} from "./profile-copy-schemas";

/** The source checks the current profile count before preparing a selection. */
export const PROFILE_SYNC_MAX_ITEMS = 512;
/** Match the source's durable history and rule capacities. */
export const PROFILE_SYNC_MAX_BATCHES = 100;
export const PROFILE_SYNC_MAX_RULES = 64;

export const profileSyncSettingsSchema = lazySchema(() =>
  z.strictObject({
    name: z.string().min(1).max(128),
    color: providerProfileAccentColorSchema,
    enabled: z.boolean(),
  }),
);
export type ProfileSyncSettings = z.infer<typeof profileSyncSettingsSchema>;
export const profileSyncScopeSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z.strictObject({
      kind: z.literal("selected"),
      providers: z
        .array(profileCopyProviderSchema)
        .min(1)
        .max(4)
        .refine((v) => new Set(v).size === v.length),
    }),
  ]),
);
export type ProfileSyncScope = z.infer<typeof profileSyncScopeSchema>;
export const profileSyncSelectionSchema = lazySchema(() =>
  z
    .strictObject({
      sourceHostId: profileCopyHostIdSchema,
      scope: profileSyncScopeSchema,
      destinationHostIds: z
        .array(profileCopyHostIdSchema)
        .min(1)
        .max(16)
        .refine((v) => new Set(v).size === v.length),
    })
    .refine((v) => !v.destinationHostIds.includes(v.sourceHostId)),
);
export type ProfileSyncSelection = z.infer<typeof profileSyncSelectionSchema>;
export const profileSyncSourceRequestSchema = lazySchema(() =>
  z.strictObject({ sourceHostId: profileCopyHostIdSchema }),
);
export const profileSyncItemSchema = lazySchema(() =>
  z
    .strictObject({
      providerId: profileCopyProviderSchema,
      sourceProfileId: profileCopySourceProfileIdSchema,
      name: z.string().max(128),
      destinationHostId: profileCopyHostIdSchema,
      operationId: profileCopyIdSchema,
      preview: profileCopyPreviewResponseSchema.nullable(),
      outcome: profileCopyOutcomeSchema.nullable(),
      state: z.enum([
        "ready",
        "queued",
        "copying",
        "synced",
        "already-present",
        "needs-action",
        "conflict",
        "paused",
        "unavailable",
        "update-required",
        "unconfirmed",
        "source-removed",
      ]),
      sourceSettings: profileSyncSettingsSchema,
      sourceIdentityStamp: z.string().regex(/^[a-f0-9]{64}$/),
      identityChanged: z.boolean(),
      destinationSettings: profileSyncSettingsSchema.nullable(),
      baseline: profileSyncSettingsSchema.nullable(),
    })
    .refine(
      (item) =>
        item.outcome === null ||
        (item.outcome.attempt.providerId === item.providerId &&
          item.outcome.attempt.sourceProfileId === item.sourceProfileId &&
          item.outcome.attempt.destinationHostId === item.destinationHostId &&
          item.outcome.attempt.operationId === item.operationId),
      { message: "Copy outcome must match its sync item" },
    )
    .refine(
      (item) =>
        item.preview === null ||
        (item.preview.source.providerId === item.providerId &&
          item.preview.source.sourceProfileId === item.sourceProfileId &&
          item.preview.destinations.some(
            (destination) =>
              destination.destinationHostId === item.destinationHostId,
          )),
      { message: "Copy preview must match its sync item" },
    )
    .refine(
      (item) => item.state !== "conflict" || item.destinationSettings !== null,
      { message: "Conflict items must include destination settings" },
    )
    .refine(
      (item) =>
        item.state !== "needs-action" ||
        item.outcome !== null ||
        item.identityChanged,
      {
        message:
          "Needs-action items must include a copy outcome or source identity change",
      },
    ),
);
export type ProfileSyncItem = z.infer<typeof profileSyncItemSchema>;
function uniqueOperations(items: readonly ProfileSyncItem[]): boolean {
  return new Set(items.map((item) => item.operationId)).size === items.length;
}
function uniqueAttempts(items: readonly ProfileSyncItem[]): boolean {
  const attempts = items.flatMap((item) =>
    item.outcome === null ? [] : [item.outcome.attempt.attemptId],
  );
  return new Set(attempts).size === attempts.length;
}
function uniqueTransfers(items: readonly ProfileSyncItem[]): boolean {
  return (
    new Set(
      items.map((item) =>
        JSON.stringify([
          item.providerId,
          item.sourceProfileId,
          item.destinationHostId,
        ]),
      ),
    ).size === items.length
  );
}
export const profileSyncPreviewSchema = lazySchema(() =>
  z
    .strictObject({
      selection: profileSyncSelectionSchema,
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      items: z.array(profileSyncItemSchema).max(PROFILE_SYNC_MAX_ITEMS),
    })
    .refine(
      (preview) =>
        preview.items.every(
          (item) =>
            itemMatchesSource(item, preview.selection.sourceHostId) &&
            preview.selection.destinationHostIds.includes(
              item.destinationHostId,
            ) &&
            (preview.selection.scope.kind === "all" ||
              preview.selection.scope.providers.includes(item.providerId)),
        ),
      { message: "Sync items must match the preview selection" },
    )
    .refine((preview) => uniqueOperations(preview.items), {
      message: "Sync operation IDs must be unique within a preview",
    })
    .refine((preview) => uniqueTransfers(preview.items), {
      message: "Sync transfers must be unique within a preview",
    })
    .refine((preview) => uniqueAttempts(preview.items), {
      message: "Sync attempt IDs must be unique within a preview",
    })
    .refine(
      (preview) =>
        preview.items.every(
          (item) =>
            !item.identityChanged ||
            !["ready", "synced", "queued", "copying"].includes(item.state),
        ),
      { message: "Source identity changes cannot be startable in a preview" },
    ),
);
export type ProfileSyncPreview = z.infer<typeof profileSyncPreviewSchema>;
export const profileSyncStartSchema = lazySchema(() =>
  z.strictObject({
    selection: profileSyncSelectionSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    batchId: profileCopyIdSchema,
  }),
);
export const profileSyncBatchSchema = lazySchema(() =>
  z
    .strictObject({
      batchId: profileCopyIdSchema,
      sourceHostId: profileCopyHostIdSchema,
      createdAt: z.number().int().nonnegative(),
      automatic: z.boolean(),
      items: z.array(profileSyncItemSchema).max(PROFILE_SYNC_MAX_ITEMS),
    })
    .refine(
      (batch) =>
        batch.items.every((item) =>
          itemMatchesSource(item, batch.sourceHostId),
        ),
      {
        message: "Sync items must match the batch source",
      },
    )
    .refine((batch) => uniqueOperations(batch.items), {
      message: "Sync operation IDs must be unique within a batch",
    })
    .refine((batch) => uniqueTransfers(batch.items), {
      message: "Sync transfers must be unique within a batch",
    })
    .refine((batch) => uniqueAttempts(batch.items), {
      message: "Sync attempt IDs must be unique within a batch",
    }),
);
export type ProfileSyncBatch = z.infer<typeof profileSyncBatchSchema>;
export const profileSyncRuleSchema = lazySchema(() =>
  z
    .strictObject({
      ruleId: profileCopyIdSchema,
      sourceHostId: profileCopyHostIdSchema,
      destinationHostId: profileCopyHostIdSchema,
      scope: profileSyncScopeSchema,
      paused: z.boolean(),
      revision: z.number().int().nonnegative(),
      lastCheckedAt: z.number().int().nonnegative().nullable(),
      batchId: profileCopyIdSchema.nullable(),
      status: z.enum(["waiting", "active", "needs-action", "paused"]),
    })
    .refine((rule) => rule.sourceHostId !== rule.destinationHostId, {
      message: "Sync rules must target another host",
    }),
);
export type ProfileSyncRule = z.infer<typeof profileSyncRuleSchema>;
export const profileSyncListSchema = lazySchema(() =>
  z
    .strictObject({
      batches: z.array(profileSyncBatchSchema).max(PROFILE_SYNC_MAX_BATCHES),
      rules: z.array(profileSyncRuleSchema).max(PROFILE_SYNC_MAX_RULES),
    })
    .refine(
      (list) =>
        new Set(list.batches.map((batch) => batch.batchId)).size ===
        list.batches.length,
      { message: "Sync batch IDs must be unique within a list" },
    )
    .refine(
      (list) =>
        new Set(list.rules.map((rule) => rule.ruleId)).size ===
        list.rules.length,
      { message: "Sync rule IDs must be unique within a list" },
    )
    .refine(
      (list) =>
        new Set(list.rules.map((rule) => rule.destinationHostId)).size ===
        list.rules.length,
      { message: "Sync rule destinations must be unique within a list" },
    ),
);
export type ProfileSyncList = z.infer<typeof profileSyncListSchema>;

function itemMatchesSource(
  item: ProfileSyncItem,
  sourceHostId: string,
): boolean {
  return (
    item.destinationHostId !== sourceHostId &&
    (item.outcome === null ||
      item.outcome.attempt.sourceHostId === sourceHostId) &&
    (item.preview === null || item.preview.source.sourceHostId === sourceHostId)
  );
}
export const profileSyncSaveRuleSchema = lazySchema(() =>
  z
    .strictObject({
      ruleId: profileCopyIdSchema,
      sourceHostId: profileCopyHostIdSchema,
      destinationHostId: profileCopyHostIdSchema,
      scope: profileSyncScopeSchema,
      paused: z.boolean(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .refine((v) => v.sourceHostId !== v.destinationHostId),
);
export type ProfileSyncSaveRule = z.infer<typeof profileSyncSaveRuleSchema>;
export const profileSyncStopRuleSchema = lazySchema(() =>
  z.strictObject({
    sourceHostId: profileCopyHostIdSchema,
    ruleId: profileCopyIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
);
export const profileSyncResolveSchema = lazySchema(() =>
  z.strictObject({
    sourceHostId: profileCopyHostIdSchema,
    batchId: profileCopyIdSchema,
    operationId: profileCopyIdSchema,
    action: z.enum(["keep-destination", "use-source", "check"]),
    expectedDestination: profileSyncSettingsSchema.nullable(),
  }),
);
export type ProfileSyncResolve = z.infer<typeof profileSyncResolveSchema>;
export const profileSyncApplySchema = lazySchema(() =>
  z.strictObject({
    attempt: profileCopyAttemptSchema,
    desired: profileSyncSettingsSchema,
    expected: profileSyncSettingsSchema.nullable(),
    inspectOnly: z.boolean(),
  }),
);
export type ProfileSyncApply = z.infer<typeof profileSyncApplySchema>;
export const profileSyncApplyResultSchema = lazySchema(() =>
  z.strictObject({
    state: z.enum(["synced", "conflict", "unlinked", "removed", "pending"]),
    current: profileSyncSettingsSchema.nullable(),
  }),
);
export type ProfileSyncApplyResult = z.infer<
  typeof profileSyncApplyResultSchema
>;
