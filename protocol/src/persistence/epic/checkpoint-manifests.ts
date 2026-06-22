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

/**
 * Tags a manifest entry whose `filePath` is a Traycer artifact `index.md`. The
 * presence of this tag (non-null) is what marks an entry as an artifact change:
 * the renderer shows it as a titled artifact row (click → open / diff) instead
 * of a raw file path, and the bulk-revert opt-out filters on it. Resolved at
 * turn-end manifest finalization via the storage mapping; `artifactId`/`kind`/
 * `title` are all null when the id is not yet minted (a just-created artifact
 * whose EpicFileSync ingest has not completed) - the entry is still an artifact
 * for revert/grouping, the GUI just falls back to a generic label until the id
 * resolves. The GUI re-resolves the live title from the open-epic projection by
 * `artifactId`; `title` here is only the fallback.
 */
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
  // Present + non-null ⇒ this entry is an artifact `index.md` change. Optional
  // (`.nullish()`) so manifests persisted before artifacts entered the
  // checkpoint flow parse cleanly (the field is absent → undefined → "not an
  // artifact"), and so the many manifest-entry constructors don't each have to
  // spell out `artifact: null`. Read it with a falsy check (`!entry.artifact`).
  artifact: checkpointArtifactTagSchema.nullish(),
});
export type TurnCheckpointManifestEntry = z.infer<
  typeof turnCheckpointManifestEntrySchema
>;

/**
 * True when an entry records no actual change to its path — the file was touched
 * during the turn but ended byte-identical to its pre-turn state, so
 * `beforeHash === afterHash`. Two shapes qualify:
 *   - a net-zero edit (`{beforeHash: X, afterHash: X}`): edited then reverted,
 *     or an idempotent rewrite, within the turn.
 *   - a created-then-deleted file (`{beforeHash: null, afterHash: null}` with
 *     `undoable: true`): created and removed within the same turn.
 *
 * Restoring such an entry is a guaranteed no-op, and the turn did not actually
 * change the file. The per-turn "Changes" group already hides these on the file
 * side (it merges repeated edits per path and drops equal-hash endpoints); this
 * predicate lets every OTHER manifest consumer — the Undo modal, the per-turn
 * restore plan, the revert-on-edit checks, the artifact rows, the
 * later-overlap note — apply the same rule uniformly (including to artifacts),
 * so what is shown, counted, and restored stays in lockstep.
 *
 * The `undoable` guard is load-bearing: a denied / binary / not-intercepted
 * edit also carries `beforeHash === afterHash === null`, but it represents a
 * real (unrevertable) change attempt and must stay visible as a "Skipped" row.
 * Those entries are `undoable: false`, so they are NOT treated as no-ops here.
 */
export function isNoOpCheckpointEntry(
  entry: TurnCheckpointManifestEntry,
): boolean {
  return entry.undoable && entry.beforeHash === entry.afterHash;
}

/**
 * Current `TurnCheckpointManifest` shape version. Bumped whenever the
 * manifest payload changes in a non-backwards-compatible way. Writers
 * always emit this value; readers reject manifests whose `schemaVersion`
 * does not match (the restore path treats a mismatch as "cannot restore"
 * rather than silently producing wrong results).
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
export type RestoreResultManifest = z.infer<
  typeof restoreResultManifestSchema
>;
