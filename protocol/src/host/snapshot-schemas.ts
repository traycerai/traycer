import { z } from "zod";
import { fileEditReasonSchema } from "@traycer/protocol/persistence/epic/content-blocks";

export const snapshotsGetLocalStorageSizeRequestSchema = z.object({});
export const snapshotsGetLocalStorageSizeResponseSchema = z.object({
  bytes: z.number().int().nonnegative(),
});
export type SnapshotsGetLocalStorageSizeRequest = z.infer<
  typeof snapshotsGetLocalStorageSizeRequestSchema
>;
export type SnapshotsGetLocalStorageSizeResponse = z.infer<
  typeof snapshotsGetLocalStorageSizeResponseSchema
>;

export const snapshotsClearLocalSnapshotsRequestSchema = z.object({});
export const snapshotsClearLocalSnapshotsResponseSchema = z.object({
  clearedBytes: z.number().int().nonnegative(),
});
export type SnapshotsClearLocalSnapshotsRequest = z.infer<
  typeof snapshotsClearLocalSnapshotsRequestSchema
>;
export type SnapshotsClearLocalSnapshotsResponse = z.infer<
  typeof snapshotsClearLocalSnapshotsResponseSchema
>;

/** Lazy before/after fetch for a single `file_change` block's snapshot diff. */
export const snapshotsReadSnapshotDiffRequestSchema = z.object({
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
});
export const snapshotsReadSnapshotDiffResponseSchema = z.object({
  beforeContent: z.string().nullable(),
  afterContent: z.string().nullable(),
  reason: fileEditReasonSchema,
});
export type SnapshotsReadSnapshotDiffRequest = z.infer<
  typeof snapshotsReadSnapshotDiffRequestSchema
>;
export type SnapshotsReadSnapshotDiffResponse = z.infer<
  typeof snapshotsReadSnapshotDiffResponseSchema
>;
