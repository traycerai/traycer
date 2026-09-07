import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { z } from "zod";

export const checkpointFileOperationSchema = z.enum([
  "edit",
  "create",
  "delete",
]);
export type CheckpointFileOperation = z.infer<
  typeof checkpointFileOperationSchema
>;

const checkpointArtifactKindSchema = getRecordSchema(
  commonRecordRegistry,
  "epic-artifact-kind",
  "latest",
);

/** Tags a manifest entry whose `filePath` is a Traycer artifact `index.md`. */
export const checkpointArtifactTagSchema = z.object({
  artifactId: z.string().nullable(),
  kind: checkpointArtifactKindSchema.nullable(),
  title: z.string().nullable(),
});
export type CheckpointArtifactTag = z.infer<typeof checkpointArtifactTagSchema>;

export const turnCheckpointManifestEntrySchema = z.object({
  filePath: z.string(),
  operation: checkpointFileOperationSchema,
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  undoable: z.boolean(),
  reason: z.string().nullable(),
  // Present + non-null ⇒ this entry is an artifact `index.md` change.
  artifact: checkpointArtifactTagSchema.nullish(),
});
export type TurnCheckpointManifestEntry = z.infer<
  typeof turnCheckpointManifestEntrySchema
>;

/**
 * True when an entry records no actual change to its path - the file was touched during the turn but ended byte-identical to its pre-turn state, so `beforeHash === afterHash`.
 * The `undoable` guard is load-bearing: a denied / binary / not-intercepted edit also carries `beforeHash === afterHash === null`, but it represents a real (unrevertable) change attempt and must stay visible as a.
 */
export function isNoOpCheckpointEntry(
  entry: TurnCheckpointManifestEntry,
): boolean {
  return entry.undoable && entry.beforeHash === entry.afterHash;
}

/**
 * Which checkpoints have a file they touch touched AGAIN by a later checkpoint.
 * It has two callers on two sides of the wire and they must not disagree.
 */
export function overlappingCheckpointIds(
  manifests: ReadonlyArray<TurnCheckpointManifest>,
): ReadonlySet<string> {
  const lastTouchIndexByPath = new Map<string, number>();
  manifests.forEach((manifest, index) => {
    manifest.entries
      .filter((entry) => !isNoOpCheckpointEntry(entry))
      .forEach((entry) => {
        lastTouchIndexByPath.set(entry.filePath, index);
      });
  });
  return new Set(
    manifests.flatMap((manifest, index) => {
      const touchedLater = manifest.entries.some(
        (entry) =>
          !isNoOpCheckpointEntry(entry) &&
          (lastTouchIndexByPath.get(entry.filePath) ?? index) > index,
      );
      return touchedLater ? [manifest.checkpointId] : [];
    }),
  );
}

/**
 * Current `TurnCheckpointManifest` shape version.
 * Writers always emit this value; readers reject manifests whose `schemaVersion` does not match (the restore path treats a mismatch as "cannot restore" rather than silently producing wrong results).
 */
export const TURN_CHECKPOINT_MANIFEST_SCHEMA_VERSION = 1;

export const turnCheckpointManifestSchema = z.object({
  schemaVersion: z.literal(TURN_CHECKPOINT_MANIFEST_SCHEMA_VERSION),
  checkpointId: z.string(),
  capturingUserId: z.string(),
  capturingHostId: z.string(),
  allowedRoots: z.array(z.string()),
  workingDirectory: z.string(),
  capturedAt: z.number(),
  entries: z.array(turnCheckpointManifestEntrySchema),
});
export type TurnCheckpointManifest = z.infer<
  typeof turnCheckpointManifestSchema
>;

export const restoreStartedManifestSchema = z.object({
  checkpointId: z.string(),
  restoringUserId: z.string(),
  restoringHostId: z.string(),
  startedAt: z.number(),
});
export type RestoreStartedManifest = z.infer<
  typeof restoreStartedManifestSchema
>;

export const restoreResultEntrySchema = z.object({
  filePath: z.string(),
  status: z.enum(["restored", "skipped", "failed"]),
  operation: checkpointFileOperationSchema,
  reason: z.string().nullable(),
});
export type RestoreResultEntry = z.infer<typeof restoreResultEntrySchema>;

export const restoreResultManifestSchema = z.object({
  checkpointId: z.string(),
  restoredAt: z.number(),
  results: z.array(restoreResultEntrySchema),
});
export type RestoreResultManifest = z.infer<typeof restoreResultManifestSchema>;
