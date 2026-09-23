import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const checkpointFileOperationSchema = lazySchema(() =>
  z.enum(["edit", "create", "delete"]),
);
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
export const checkpointArtifactTagSchema = lazySchema(() =>
  z.object({
    artifactId: z.string().nullable(),
    kind: checkpointArtifactKindSchema.nullable(),
    title: z.string().nullable(),
  }),
);
export type CheckpointArtifactTag = z.infer<typeof checkpointArtifactTagSchema>;

export const turnCheckpointManifestEntrySchema = lazySchema(() =>
  z.object({
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
  }),
);
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
 * Which checkpoints have a file they touch touched AGAIN by a later checkpoint.
 *
 * Drives the restore dialog's "files modified in later turns will also be
 * rewound" warning, which is the note this module's `isNoOpCheckpointEntry`
 * doc lists among the consumers that must apply one rule uniformly.
 *
 * ## Why it is here and not beside its consumer
 *
 * It has two callers on two sides of the wire and they must not disagree. The
 * renderer derived it from the events it holds, which on the windowed line is
 * whatever subset happens to be hydrated - a span without the LATER
 * checkpoints concludes `false` and the warning silently disappears from a
 * destructive dialog. So the projection now computes it over whole history and
 * carries the answer per row (`TranscriptRowContext.hasLaterOverlappingChanges`),
 * and the renderer keeps its own derivation only for the legacy line where
 * `events` really is the whole log. Two derivations of one rule is exactly the
 * drift this file already exists to prevent; one function, two callers.
 *
 * @param manifests Every checkpoint manifest in the range being judged, in
 * capture order. Order is the whole input - "later" means "later in this
 * array" - so a caller passing a partial or unsorted set gets a partial or
 * wrong answer, which is the bug above.
 */
export function overlappingCheckpointIds(
  manifests: ReadonlyArray<TurnCheckpointManifest>,
): ReadonlySet<string> {
  return overlappingCheckpointKeys(
    manifests.map((manifest) => ({
      key: manifest.checkpointId,
      paths: checkpointChangePaths(manifest),
    })),
  );
}

/**
 * The paths a checkpoint really changed: its entries' paths without the
 * no-op ones, each once, in entry order.
 *
 * Only real changes drive the overlap note. A no-op entry is not part of the
 * turn's change set and is not restored, so an overlap with one would make the
 * cumulative warning misleading.
 */
export function checkpointChangePaths(
  manifest: TurnCheckpointManifest,
): string[] {
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (!isNoOpCheckpointEntry(entry)) paths.add(entry.filePath);
  }
  return [...paths];
}

/**
 * The overlap rule itself, over each checkpoint's {@link checkpointChangePaths}.
 * {@link overlappingCheckpointIds} is this over whole manifests; a store that
 * keeps only the paths calls it directly, so the rule has one definition
 * whichever form the checkpoints are held in.
 *
 * A checkpoint overlaps iff a path it changed is changed again by a LATER one.
 * Record, per path, the index of the last checkpoint that changes it; a
 * checkpoint then overlaps iff any of its paths has a later last index. One
 * forward pass plus one scan, rather than the quadratic pairwise comparison
 * this started as.
 *
 * The answer for a checkpoint depends on its own paths and, for each of them,
 * on the LAST checkpoint that changes it and nothing else. So a caller may pass
 * any subset that holds the checkpoints it asks about plus the last changer of
 * each of their paths, in their true relative order, and gets the whole-set
 * answer for those checkpoints. That is what lets a store judge a few turns
 * without loading every checkpoint in the chat.
 *
 * @param checkpoints In capture order; "later" means later in this array.
 */
export function overlappingCheckpointKeys<K>(
  checkpoints: ReadonlyArray<{
    readonly key: K;
    readonly paths: ReadonlyArray<string>;
  }>,
): ReadonlySet<K> {
  const lastTouchIndexByPath = new Map<string, number>();
  checkpoints.forEach((checkpoint, index) => {
    for (const path of checkpoint.paths) lastTouchIndexByPath.set(path, index);
  });
  return new Set(
    checkpoints.flatMap((checkpoint, index) => {
      const touchedLater = checkpoint.paths.some(
        (path) => (lastTouchIndexByPath.get(path) ?? index) > index,
      );
      return touchedLater ? [checkpoint.key] : [];
    }),
  );
}

/**
 * Each turn's LAST checkpoint, in the order the turns first wrote one.
 *
 * A turn can write more than one `checkpoint.captured`. A closing session
 * writes the helper edits confirmed after the latest turn's checkpoint into a
 * second one for that turn: the first one's entries plus the new ones, under a
 * new checkpoint id. The later one supersedes the earlier. A turn is restored
 * and rendered from its last manifest, and every rule that weighs checkpoints
 * against each other has to count that one only. Counting both makes the
 * earlier read as "touched later" by its own replacement, and the restore
 * dialog then warns about later turns that do not exist.
 *
 * This is the one selection shared by every such reader, for the same reason
 * `overlappingCheckpointIds` is shared: two selections of the current manifest
 * are two answers to the same question.
 *
 * **Select first, parse after.** Every caller passes the RAW events and parses
 * only what this returns. Parsing first and selecting after looks equivalent
 * and is not: a rewrite whose manifest this reader cannot parse is dropped
 * before it can supersede anything, and the predecessor it replaced is
 * retained - so the reader answers from entries the writer has already
 * replaced. A rewrite carries the predecessor's entries PLUS the ones
 * confirmed after it, so that stale answer is SHORT, and a short answer to the
 * overlap rule CLEARS a warning the current manifest would have raised.
 *
 * `Map` keeps a key at its first insertion when it is set again, so each turn
 * holds the position of its first checkpoint and the content of its last.
 *
 * @param checkpoints Every checkpoint in the range, in event-log order.
 * @param turnKeyOf The turn a checkpoint belongs to; for a raw event, see
 * {@link checkpointEventTurnKey}.
 */
export function latestCheckpointPerTurn<T>(
  checkpoints: ReadonlyArray<T>,
  turnKeyOf: (checkpoint: T) => string,
): T[] {
  const byTurn = new Map<string, T>();
  for (const checkpoint of checkpoints) {
    byTurn.set(turnKeyOf(checkpoint), checkpoint);
  }
  return [...byTurn.values()];
}

/**
 * The turn key {@link latestCheckpointPerTurn} groups a `checkpoint.captured`
 * event by. The host always stamps the turn; an event without one supersedes
 * nothing and is superseded by nothing, so it is keyed by itself.
 *
 * BOTH kinds are namespaced, so the two spaces cannot meet: an unprefixed turn
 * id would collide with the fallback key of any event whose id equals it, and
 * a turn id that literally reads `event:<something>` would collide with the
 * fallback for `<something>`. Either collision silently drops one of the two
 * checkpoints. Nothing persists or transports this key - it lives inside one
 * `latestCheckpointPerTurn` call - so the prefixes cost nothing.
 */
export function checkpointEventTurnKey(event: {
  readonly turnId: string | null;
  readonly eventId: string;
}): string {
  return event.turnId === null
    ? `event:${event.eventId}`
    : `turn:${event.turnId}`;
}

/**
 * Current `TurnCheckpointManifest` shape version. Bumped whenever the
 * manifest payload changes in a non-backwards-compatible way. Writers
 * always emit this value; readers reject manifests whose `schemaVersion`
 * does not match (the restore path treats a mismatch as "cannot restore"
 * rather than silently producing wrong results).
 */
export const TURN_CHECKPOINT_MANIFEST_SCHEMA_VERSION = 1;

export const turnCheckpointManifestSchema = lazySchema(() =>
  z.object({
    schemaVersion: z.literal(TURN_CHECKPOINT_MANIFEST_SCHEMA_VERSION),
    checkpointId: z.string(),
    capturingUserId: z.string(),
    capturingHostId: z.string(),
    allowedRoots: z.array(z.string()),
    workingDirectory: z.string(),
    capturedAt: z.number(),
    entries: z.array(turnCheckpointManifestEntrySchema),
  }),
);
export type TurnCheckpointManifest = z.infer<
  typeof turnCheckpointManifestSchema
>;

export const restoreStartedManifestSchema = lazySchema(() =>
  z.object({
    checkpointId: z.string(),
    restoringUserId: z.string(),
    restoringHostId: z.string(),
    startedAt: z.number(),
  }),
);
export type RestoreStartedManifest = z.infer<
  typeof restoreStartedManifestSchema
>;

export const restoreResultEntrySchema = lazySchema(() =>
  z.object({
    filePath: z.string(),
    status: z.enum(["restored", "skipped", "failed"]),
    operation: checkpointFileOperationSchema,
    reason: z.string().nullable(),
  }),
);
export type RestoreResultEntry = z.infer<typeof restoreResultEntrySchema>;

export const restoreResultManifestSchema = lazySchema(() =>
  z.object({
    checkpointId: z.string(),
    restoredAt: z.number(),
    results: z.array(restoreResultEntrySchema),
  }),
);
export type RestoreResultManifest = z.infer<typeof restoreResultManifestSchema>;
