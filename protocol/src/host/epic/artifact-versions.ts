import { z } from "zod";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const artifactVersionProvenanceKindSchema = z.enum([
  "agent",
  "user_session",
  "multiple_agents",
  "external",
  "system",
  "remote_merge",
  "restore",
  "revive",
  "delete",
  "clobber",
]);

export const artifactVersionAgentReferenceSchema = z
  .object({
    chatId: z.string().min(1),
    turnId: z.string().min(1),
    harnessId: z.string().min(1),
    chatTitle: z.string().nullable(),
  })
  .strict();
export type ArtifactVersionAgentReference = z.infer<
  typeof artifactVersionAgentReferenceSchema
>;

export const artifactVersionProvenanceSchema = z.discriminatedUnion("kind", [
  artifactVersionAgentReferenceSchema.extend({ kind: z.literal("agent") }),
  z
    .object({
      kind: z.literal("user_session"),
      userId: z.string().min(1),
      hostId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("multiple_agents"),
      agents: z.array(artifactVersionAgentReferenceSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      attemptedAgentWrites: z.array(artifactVersionAgentReferenceSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      trigger: z.string().nullable(),
      originalActorHint: z.string().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("remote_merge") }).strict(),
  z
    .object({
      kind: z.literal("restore"),
      restoredFromObservationId: z.string().min(1).nullable(),
      targetHash: hashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("revive"),
      deletionEventId: z.string().min(1).nullable(),
      targetHash: hashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      deleteOpId: z.string().min(1).nullable(),
      actorKind: artifactVersionProvenanceKindSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("clobber"),
      source: z.string().nullable(),
    })
    .strict(),
]);
export type ArtifactVersionProvenance = z.infer<
  typeof artifactVersionProvenanceSchema
>;

export const artifactVersionsListRequestSchema = z.object({
  epicId: z.string().min(1),
  artifactId: z.string().min(1),
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ArtifactVersionsListRequest = z.infer<
  typeof artifactVersionsListRequestSchema
>;

export const artifactVersionObservationEntrySchema = z.object({
  observationId: z.string().min(1),
  contentHash: hashSchema,
  serializerVersion: z.number().int().positive(),
  parentContentHash: hashSchema.nullable(),
  provenance: artifactVersionProvenanceSchema,
  captureStreamId: z.string().min(1),
  localSeq: z.number().int().positive(),
  capturedAt: z.number().int().nonnegative(),
  available: z.boolean(),
  degraded: z.boolean(),
});
export type ArtifactVersionObservationEntry = z.infer<
  typeof artifactVersionObservationEntrySchema
>;

export const artifactVersionsListResponseSchema = z.object({
  entries: z.array(artifactVersionObservationEntrySchema),
  nextCursor: z.string().min(1).nullable(),
});
export type ArtifactVersionsListResponse = z.infer<
  typeof artifactVersionsListResponseSchema
>;

export const artifactVersionsGetBlobRequestSchema = z.object({
  epicId: z.string().min(1),
  artifactId: z.string().min(1),
  observationId: z.string().min(1),
});
export type ArtifactVersionsGetBlobRequest = z.infer<
  typeof artifactVersionsGetBlobRequestSchema
>;

export const artifactVersionsGetBlobResponseSchema = z.object({
  contentHash: hashSchema,
  markdown: z.string(),
});
export type ArtifactVersionsGetBlobResponse = z.infer<
  typeof artifactVersionsGetBlobResponseSchema
>;

export const artifactVersionsRestoreRequestSchema = z.object({
  epicId: z.string().min(1),
  artifactId: z.string().min(1),
  targetObservationId: z.string().min(1),
  mode: z.enum(["preflight", "execute"]),
  expectedCurrentHash: hashSchema.optional(),
  force: z.boolean().optional(),
  bodyOnly: z.boolean().optional(),
});
export type ArtifactVersionsRestoreRequest = z.infer<
  typeof artifactVersionsRestoreRequestSchema
>;

export const artifactVersionsRestoreResponseSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("preflight"),
      imagesMissing: z.array(hashSchema),
      threadCount: z.number().int().nonnegative(),
      currentHash: hashSchema,
    }),
    z.object({
      kind: z.literal("outcome"),
      status: z.enum(["clean", "renormalized", "degraded"]),
      orphanedThreads: z.number().int().nonnegative().optional(),
      newObservationId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("conflict"),
      currentHash: hashSchema,
    }),
    z.object({
      kind: z.literal("unavailable"),
      reason: z.enum([
        "storage_full",
        "journal_cap",
        "target_not_found",
        "missing_blob",
        "artifact_not_live",
        "kind_mismatch",
        "body_unavailable",
        "missing_images",
      ]),
    }),
  ],
);
export type ArtifactVersionsRestoreResponse = z.infer<
  typeof artifactVersionsRestoreResponseSchema
>;

export const deletedArtifactsListRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type DeletedArtifactsListRequest = z.infer<
  typeof deletedArtifactsListRequestSchema
>;

export const deletedArtifactEntrySchema = z.object({
  artifactId: z.string().min(1),
  title: z.string().nullable(),
  deletedAt: z.number().int().nonnegative(),
  versionCount: z.number().int().nonnegative(),
  lastContentHash: hashSchema.nullable(),
  lastObservationId: z.string().min(1).nullable(),
  unrestorable: z.enum(["missing_scalars", "missing_blob"]).nullable(),
});
export type DeletedArtifactEntry = z.infer<typeof deletedArtifactEntrySchema>;

export const deletedArtifactsListResponseSchema = z.object({
  entries: z.array(deletedArtifactEntrySchema),
});
export type DeletedArtifactsListResponse = z.infer<
  typeof deletedArtifactsListResponseSchema
>;

export const deletedArtifactsReviveRequestSchema = z.object({
  epicId: z.string().min(1),
  artifactId: z.string().min(1),
});
export type DeletedArtifactsReviveRequest = z.infer<
  typeof deletedArtifactsReviveRequestSchema
>;

export const deletedArtifactsReviveResponseSchema = z.object({
  artifactId: z.string().min(1),
  status: z.enum(["clean", "renormalized", "degraded"]),
  newObservationId: z.string().min(1),
  contentHash: hashSchema,
  folderName: z.string().min(1),
  parentId: z.string().nullable(),
  parentMissing: z.boolean(),
  artifactRoomId: z.string().nullable(),
});
export type DeletedArtifactsReviveResponse = z.infer<
  typeof deletedArtifactsReviveResponseSchema
>;

export const MAX_ARTIFACT_VERSION_RETENTION_DAYS = 3650;
export const MAX_ARTIFACT_VERSIONS_PER_ARTIFACT = 10_000;
export const MAX_ARTIFACT_VERSION_BYTES_PER_ARTIFACT = 1024 * 1024 * 1024;

export const artifactVersionSettingsSchema = z.object({
  enabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(MAX_ARTIFACT_VERSION_RETENTION_DAYS),
  maxVersionsPerArtifact: z
    .number()
    .int()
    .min(1)
    .max(MAX_ARTIFACT_VERSIONS_PER_ARTIFACT),
  maxBytesPerArtifact: z
    .number()
    .int()
    .min(1)
    .max(MAX_ARTIFACT_VERSION_BYTES_PER_ARTIFACT),
});
export type ArtifactVersionSettings = z.infer<
  typeof artifactVersionSettingsSchema
>;

export const artifactVersionStorageSummarySchema = z.object({
  referencedBytes: z.number().int().nonnegative(),
  reclaimableBytes: z.number().int().nonnegative(),
});
export type ArtifactVersionStorageSummary = z.infer<
  typeof artifactVersionStorageSummarySchema
>;

export const artifactVersionSettingsEffectsSchema = z.object({
  captureStopped: z.boolean(),
  captureResumed: z.boolean(),
  driftEpicIds: z.array(z.string()),
  observationsPruned: z.number().int().nonnegative(),
  contentRowsPruned: z.number().int().nonnegative(),
  blobsDeleted: z.number().int().nonnegative(),
  bytesDeleted: z.number().int().nonnegative(),
});
export type ArtifactVersionSettingsEffects = z.infer<
  typeof artifactVersionSettingsEffectsSchema
>;

export const artifactVersionSettingsGetRequestSchema = z.object({});
export type ArtifactVersionSettingsGetRequest = z.infer<
  typeof artifactVersionSettingsGetRequestSchema
>;

export const artifactVersionSettingsGetResponseSchema = z.object({
  settings: artifactVersionSettingsSchema,
  storage: artifactVersionStorageSummarySchema,
});
export type ArtifactVersionSettingsGetResponse = z.infer<
  typeof artifactVersionSettingsGetResponseSchema
>;

export const artifactVersionSettingsSetEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});
export type ArtifactVersionSettingsSetEnabledRequest = z.infer<
  typeof artifactVersionSettingsSetEnabledRequestSchema
>;

export const artifactVersionSettingsSetRetentionPolicyRequestSchema =
  artifactVersionSettingsSchema.pick({
    retentionDays: true,
    maxVersionsPerArtifact: true,
    maxBytesPerArtifact: true,
  });
export type ArtifactVersionSettingsSetRetentionPolicyRequest = z.infer<
  typeof artifactVersionSettingsSetRetentionPolicyRequestSchema
>;

export const artifactVersionSettingsClearHistoryRequestSchema = z.object({});
export type ArtifactVersionSettingsClearHistoryRequest = z.infer<
  typeof artifactVersionSettingsClearHistoryRequestSchema
>;

export const artifactVersionSettingsCommandResponseSchema = z.object({
  settings: artifactVersionSettingsSchema,
  storage: artifactVersionStorageSummarySchema,
  effects: artifactVersionSettingsEffectsSchema,
});
export type ArtifactVersionSettingsCommandResponse = z.infer<
  typeof artifactVersionSettingsCommandResponseSchema
>;
