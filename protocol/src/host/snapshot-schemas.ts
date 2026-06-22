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

/**
 * Lazy before/after fetch for a single `file_change` block's snapshot diff. The
 * block stores only the content-addressed `beforeHash`/`afterHash`; the GUI
 * calls this on expand to read the decoded contents out of the on-disk
 * SnapshotStore and synthesize the unified patch. A `null` hash means that side
 * doesn't exist (create ⇒ no before, delete ⇒ no after). `reason` carries the
 * same `fileEditReason` codes as the block when content can't be served
 * (`blob_missing`/`too_large`/`binary`); `snapshot` when contents are present.
 */
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
