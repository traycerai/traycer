import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { renameWithWindowsRetry } from "./credentials-fs";
import {
  readRegularFileBytesNoFollowSync,
  type RegularFileBytesRead,
} from "./host-update-attempt-fs";
import {
  canonicalJson,
  checkJournalSuccessor,
  migrationIdSchema,
  migrationJournalSchema,
  phaseHoldsStartupBarrier,
  phaseIsPostActivation,
  phaseIsTerminal,
  sha256Digest,
  sha256DigestSchema,
  type MigrationId,
  type MigrationJournal,
} from "./data-migration-contracts";
import {
  DATA_BOOTSTRAP_DIRNAME,
  DATA_LOCATION_RECORD_FILENAME,
  DataRootError,
  dataLocationRecordSchema,
  dataRootPathsOverlap,
  resolveDataRoot,
  validateDataRootSelection,
  type DataLocationRecord,
  type DataRootPlatform,
  type DataRootResolution,
} from "./data-root";

/**
 * Durable records in the fixed bootstrap folder (`~/.traycer-bootstrap`),
 * and the startup gate that reads them.
 *
 * Every record is a FLAT regular file - the bootstrap folder holds no
 * sub-folders or links (`ensurePrivateBootstrapDir` refuses them):
 *
 *   location.json, location.prev.json            root selection (plain JSON,
 *                                                the resolver's format)
 *   migration.json, migration.prev.json          active-journal selector
 *   migration-<id>.json, migration-<id>.prev.json one journal per transaction,
 *                                                kept permanently
 *
 * Replacement: the new bytes go to a unique temp file beside the record,
 * are flushed, and are renamed over it; the current valid bytes are first
 * copied to `<name>.prev.json` the same way. A record is never unlinked
 * before its replacement lands, so a crash at any point leaves the prior or
 * the new valid revision. A damaged, missing-while-its-previous-exists or
 * inconsistent pair is reported, never repaired implicitly: the gate stays
 * closed until explicit recovery restores a revision.
 *
 * The checksum detects damage, not tampering; owner-private ACLs on the
 * folder are the access control.
 */

export const MIGRATION_SELECTOR_BASENAME = "migration";
const LOCATION_BASENAME = "location";
const RECORD_FORMAT = "traycer-bootstrap-record";

export const migrationSelectorSchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(1),
    revision: z.number().int().positive(),
    activeMigrationId: migrationIdSchema.nullable(),
  }),
);
export type MigrationSelector = z.infer<typeof migrationSelectorSchema>;

const envelopeSchema = lazySchema(() =>
  z.strictObject({
    format: z.literal(RECORD_FORMAT),
    version: z.literal(1),
    checksum: sha256DigestSchema,
    body: z.unknown(),
  }),
);

export type BootstrapRecordErrorCode =
  | "record-damaged"
  | "revision-conflict"
  | "transition-refused"
  | "generation-not-advanced"
  | "invalid-record";

/** A refused or failed bootstrap-record operation. Messages carry no paths. */
export class BootstrapRecordError extends Error {
  readonly code: BootstrapRecordErrorCode;
  readonly recordPath: string;

  constructor(
    code: BootstrapRecordErrorCode,
    message: string,
    recordPath: string,
  ) {
    super(message);
    this.name = "BootstrapRecordError";
    this.code = code;
    this.recordPath = recordPath;
  }
}

/**
 * Proof that the caller holds the one serialization every bootstrap-record
 * writer shares: the migration coordinator lock
 * (`data-migration-admission.ts`). The compare-and-set checks below are a
 * second line, not the serialization: each write asserts the lock is still
 * held before it lands.
 */
export interface HeldBootstrapSerialization {
  assertHeld(): void;
}

export function journalBasename(id: MigrationId): string {
  return `${MIGRATION_SELECTOR_BASENAME}-${id}`;
}

function recordPath(bootstrapDir: string, basename: string): string {
  return join(bootstrapDir, `${basename}.json`);
}

function previousRecordPath(bootstrapDir: string, basename: string): string {
  return join(bootstrapDir, `${basename}.prev.json`);
}

// ---- One file ---------------------------------------------------------------

type FileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "damaged"; readonly reason: string }
  | { readonly kind: "valid"; readonly raw: string; readonly body: unknown };

type Decoder = (
  raw: string,
) => { ok: true; body: unknown } | { ok: false; reason: string };

function readRecordFileSync(path: string, decode: Decoder): FileRead {
  let read: RegularFileBytesRead;
  try {
    read = readRegularFileBytesNoFollowSync(path);
  } catch (error) {
    return {
      kind: "damaged",
      reason: `cannot read (${errorCode(error) ?? "unknown error"})`,
    };
  }
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "not-regular") {
    return { kind: "damaged", reason: "not a regular file" };
  }
  const raw = read.bytes.toString("utf8");
  const decoded = decode(raw);
  return decoded.ok
    ? { kind: "valid", raw, body: decoded.body }
    : { kind: "damaged", reason: decoded.reason };
}

function envelopeDecoder<T>(schema: z.ZodType<T>): Decoder {
  return (raw) => {
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(raw));
    } catch {
      return { ok: false, reason: "torn or not a bootstrap record" };
    }
    if (sha256Digest(envelope.body) !== envelope.checksum) {
      return { ok: false, reason: "checksum mismatch" };
    }
    const body = schema.safeParse(envelope.body);
    return body.success
      ? { ok: true, body: body.data }
      : { ok: false, reason: "unsupported or invalid record contents" };
  };
}

const locationDecoder: Decoder = (raw) => {
  try {
    return { ok: true, body: dataLocationRecordSchema.parse(JSON.parse(raw)) };
  } catch {
    return { ok: false, reason: "torn, malformed or from a newer version" };
  }
};

function encodeEnvelope(body: unknown): string {
  return `${JSON.stringify(
    { format: RECORD_FORMAT, version: 1, checksum: sha256Digest(body), body },
    null,
    2,
  )}\n`;
}

// ---- A record with its previous revision ------------------------------------

export type DurableRecordRead<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly record: T; readonly raw: string }
  | {
      readonly kind: "damaged";
      readonly reason: string;
      /** The previous revision, when valid - for explicit recovery only. */
      readonly previous: T | null;
    };

interface RecordFamily<T> {
  readonly decode: Decoder;
  readonly cast: (body: unknown) => T;
  /** Monotonic order of revisions, checked against the previous revision. */
  readonly order: (record: T) => number;
  /**
   * Whether an out-of-order pair is nonetheless legitimate. Only the location
   * record has such a case: a pre-activation rollback restores the lower
   * previous generation, authorized by that migration's own durable journal.
   * Null: every regression is damage.
   */
  readonly regressionAuthorized: ((current: T, previous: T) => boolean) | null;
  /**
   * Whether a missing record beside a previous revision is damage. True for
   * the selector and journals, which are never removed. False for the
   * location record: restoring the implicit default root by rollback removes
   * it, and its absence is cross-checked against the journals by the gate.
   */
  readonly absenceWithPreviousIsDamage: boolean;
}

function readPairSync<T>(
  bootstrapDir: string,
  basename: string,
  family: RecordFamily<T>,
): DurableRecordRead<T> {
  const main = readRecordFileSync(
    recordPath(bootstrapDir, basename),
    family.decode,
  );
  const prev = readRecordFileSync(
    previousRecordPath(bootstrapDir, basename),
    family.decode,
  );
  const previous = prev.kind === "valid" ? family.cast(prev.body) : null;
  if (main.kind === "absent") {
    if (prev.kind === "absent" || !family.absenceWithPreviousIsDamage) {
      return { kind: "absent" };
    }
    // A record is never unlinked, so its absence beside a previous revision
    // is deletion by someone else - not a fresh install.
    return {
      kind: "damaged",
      reason: "missing while its previous revision exists",
      previous,
    };
  }
  if (main.kind === "damaged") {
    return { kind: "damaged", reason: main.reason, previous };
  }
  const record = family.cast(main.body);
  if (prev.kind === "valid") {
    const previousRecord = family.cast(prev.body);
    const current = family.order(record);
    const before = family.order(previousRecord);
    // Equal order with identical bytes is the crash window between saving the
    // previous revision and landing the new one. Anything else out of order
    // is an inconsistency nobody can resolve automatically - unless the
    // family proves it authorized.
    if (
      (before > current || (before === current && prev.raw !== main.raw)) &&
      !(family.regressionAuthorized?.(record, previousRecord) ?? false)
    ) {
      return {
        kind: "damaged",
        reason: "inconsistent with its previous revision",
        previous,
      };
    }
  }
  return { kind: "valid", record, raw: main.raw };
}

async function replacePair<T>(input: {
  readonly bootstrapDir: string;
  readonly held: HeldBootstrapSerialization;
  readonly basename: string;
  readonly family: RecordFamily<T>;
  /** The record the caller read and is replacing; null when creating. */
  readonly expected: T | null;
  /** The new bytes, or null to remove the record (rollback to the implicit default root). */
  readonly nextRaw: string | null;
}): Promise<void> {
  const path = recordPath(input.bootstrapDir, input.basename);
  input.held.assertHeld();
  const current = readPairSync(
    input.bootstrapDir,
    input.basename,
    input.family,
  );
  if (current.kind === "damaged") {
    throw new BootstrapRecordError(
      "record-damaged",
      `a bootstrap record is damaged (${current.reason}); run recovery before changing it`,
      path,
    );
  }
  const currentRecord = current.kind === "valid" ? current.record : null;
  if (canonicalJson(currentRecord) !== canonicalJson(input.expected)) {
    throw new BootstrapRecordError(
      "revision-conflict",
      "a bootstrap record changed since it was read",
      path,
    );
  }
  if (current.kind === "valid") {
    await writeFileAtomic(
      previousRecordPath(input.bootstrapDir, input.basename),
      current.raw,
    );
  }
  input.held.assertHeld();
  if (input.nextRaw === null) {
    // The current bytes are already preserved as the previous revision.
    await rm(path, { force: true });
    await syncDirectory(input.bootstrapDir);
    return;
  }
  await writeFileAtomic(path, input.nextRaw);
}

/**
 * Write `data` to `path` by temp-flush-rename in the same folder. The record
 * being replaced is never unlinked first; a failure removes only the temp.
 * POSIX also flushes the folder so the rename itself is durable.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithWindowsRetry(tmp, path, 0);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await syncDirectory(join(path, ".."));
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ---- Selector and journals --------------------------------------------------

const selectorFamily: RecordFamily<MigrationSelector> = {
  absenceWithPreviousIsDamage: true,
  decode: envelopeDecoder(migrationSelectorSchema),
  cast: (body) => migrationSelectorSchema.parse(body),
  order: (record) => record.revision,
  regressionAuthorized: null,
};

const journalFamily: RecordFamily<MigrationJournal> = {
  absenceWithPreviousIsDamage: true,
  decode: envelopeDecoder(migrationJournalSchema),
  cast: (body) => migrationJournalSchema.parse(body),
  order: (record) => record.revision,
  regressionAuthorized: null,
};

export function readMigrationSelectorSync(
  bootstrapDir: string,
): DurableRecordRead<MigrationSelector> {
  return readPairSync(
    bootstrapDir,
    MIGRATION_SELECTOR_BASENAME,
    selectorFamily,
  );
}

export function readMigrationJournalSync(
  bootstrapDir: string,
  id: MigrationId,
): DurableRecordRead<MigrationJournal> {
  const read = readPairSync(bootstrapDir, journalBasename(id), journalFamily);
  if (read.kind === "valid" && read.record.id !== id) {
    return {
      kind: "damaged",
      reason: "names a different transaction",
      previous: null,
    };
  }
  return read;
}

/** Every transaction id with a journal file, in name order. */
export function listMigrationJournalIdsSync(
  bootstrapDir: string,
): MigrationId[] {
  let names: string[];
  try {
    names = readdirSync(bootstrapDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const ids: MigrationId[] = [];
  for (const name of names.sort()) {
    const match = /^migration-(m-[a-z0-9-]+)\.json$/u.exec(name);
    if (match === null) continue;
    const id = migrationIdSchema.safeParse(match[1]);
    if (id.success) ids.push(id.data);
  }
  return ids;
}

export async function writeMigrationSelector(
  bootstrapDir: string,
  held: HeldBootstrapSerialization,
  expected: MigrationSelector | null,
  next: MigrationSelector,
): Promise<void> {
  const path = recordPath(bootstrapDir, MIGRATION_SELECTOR_BASENAME);
  if (next.revision !== (expected?.revision ?? 0) + 1) {
    throw new BootstrapRecordError(
      "revision-conflict",
      "the selector revision must advance by one",
      path,
    );
  }
  await replacePair({
    bootstrapDir,
    held,
    basename: MIGRATION_SELECTOR_BASENAME,
    family: selectorFamily,
    expected,
    nextRaw: encodeEnvelope(migrationSelectorSchema.parse(next)),
  });
}

/**
 * Persist `next` as the successor of `expected` (null for revision 1),
 * enforcing the phase table and activation boundary
 * (`checkJournalSuccessor`). Journals are never deleted.
 */
export async function writeMigrationJournal(
  bootstrapDir: string,
  held: HeldBootstrapSerialization,
  expected: MigrationJournal | null,
  next: MigrationJournal,
): Promise<void> {
  const basename = journalBasename(next.id);
  const refusal = checkJournalSuccessor(
    expected,
    migrationJournalSchema.parse(next),
  );
  if (refusal !== null) {
    throw new BootstrapRecordError(
      "transition-refused",
      `${refusal.code}: ${refusal.message}`,
      recordPath(bootstrapDir, basename),
    );
  }
  await replacePair({
    bootstrapDir,
    held,
    basename,
    family: journalFamily,
    expected,
    nextRaw: encodeEnvelope(next),
  });
}

/**
 * Explicit recovery of a damaged record from its valid previous revision.
 * Never called implicitly: the startup gate reports damage and stays closed.
 */
export async function restorePreviousRecordRevision(
  bootstrapDir: string,
  held: HeldBootstrapSerialization,
  target:
    | { readonly kind: "selector" }
    | { readonly kind: "journal"; readonly id: MigrationId },
): Promise<void> {
  if (target.kind === "selector") {
    // The damaged selector may have named a newer transaction than the
    // previous one does; restoring it would silently drop that transaction's
    // barrier. Only restore when no other journal could be that transaction:
    // every one is readable and either terminal or a never-barriered plan.
    const previous = readMigrationSelectorSync(bootstrapDir);
    const previousActive =
      previous.kind === "damaged"
        ? (previous.previous?.activeMigrationId ?? null)
        : null;
    for (const id of listMigrationJournalIdsSync(bootstrapDir)) {
      if (id === previousActive) continue;
      const journal = readMigrationJournalSync(bootstrapDir, id);
      if (
        journal.kind !== "valid" ||
        !(
          phaseIsTerminal(journal.record.phase) ||
          journal.record.phase === "planned"
        )
      ) {
        throw new BootstrapRecordError(
          "transition-refused",
          "another migration may have been active; the damaged selector cannot be restored from its previous revision",
          recordPath(bootstrapDir, MIGRATION_SELECTOR_BASENAME),
        );
      }
    }
    await restorePrevious(
      bootstrapDir,
      held,
      MIGRATION_SELECTOR_BASENAME,
      selectorFamily,
    );
    return;
  }
  const basename = journalBasename(target.id);
  const current = readPairSync(bootstrapDir, basename, journalFamily);
  // The damaged revision cannot be read, so what it recorded is unknown. The
  // successor of `switched` may be `activated` - the irreversible boundary -
  // and restoring `switched` would erase that evidence and re-open rollback.
  // That case stays blocked for forward-only diagnosis.
  if (current.kind === "damaged" && current.previous?.phase === "switched") {
    throw new BootstrapRecordError(
      "transition-refused",
      "the damaged journal revision may have recorded activation; it cannot be restored from the revision before it",
      recordPath(bootstrapDir, basename),
    );
  }
  await restorePrevious(bootstrapDir, held, basename, journalFamily);
}

async function restorePrevious<T>(
  bootstrapDir: string,
  held: HeldBootstrapSerialization,
  basename: string,
  family: RecordFamily<T>,
): Promise<void> {
  const path = recordPath(bootstrapDir, basename);
  const current = readPairSync(bootstrapDir, basename, family);
  if (current.kind !== "damaged" || current.previous === null) {
    throw new BootstrapRecordError(
      "invalid-record",
      "only a damaged record with a valid previous revision can be restored",
      path,
    );
  }
  const prev = readRecordFileSync(
    previousRecordPath(bootstrapDir, basename),
    family.decode,
  );
  if (prev.kind !== "valid") {
    throw new BootstrapRecordError(
      "record-damaged",
      "the previous revision changed",
      path,
    );
  }
  held.assertHeld();
  await writeFileAtomic(path, prev.raw);
}

// ---- Location record --------------------------------------------------------

function locationFamilyFor(
  bootstrapDir: string,
): RecordFamily<DataLocationRecord> {
  return {
    absenceWithPreviousIsDamage: false,
    decode: locationDecoder,
    cast: (body) => dataLocationRecordSchema.parse(body),
    order: (record) => record.generation,
    regressionAuthorized: (current, previous) =>
      rollbackAuthorizesRegression(bootstrapDir, current, previous),
  };
}

/**
 * A lower generation in `location.json` than in `location.prev.json` is
 * legitimate only as the outcome of `restoreLocationForRollback`: the
 * previous pointer is exactly some migration's pointer, and that migration's
 * durable journal is rolling back (or rolled back) to exactly the current
 * record. Any other regression is damage and fails closed.
 */
function rollbackAuthorizesRegression(
  bootstrapDir: string,
  current: DataLocationRecord,
  previous: DataLocationRecord,
): boolean {
  if (previous.migrationId === null) return false;
  const journal = readMigrationJournalSync(bootstrapDir, previous.migrationId);
  if (journal.kind !== "valid") return false;
  const record = journal.record;
  return (
    (record.phase === "rollback-requested" || record.phase === "rolled-back") &&
    sameLocation(previous, migrationLocationOf(record)) &&
    sameLocation(current, record.previousLocation)
  );
}

export function readLocationRecordSync(
  bootstrapDir: string,
): DurableRecordRead<DataLocationRecord> {
  return readPairSync(
    bootstrapDir,
    LOCATION_BASENAME,
    locationFamilyFor(bootstrapDir),
  );
}

/**
 * The three location transitions, each explicitly authorized; there is no
 * general-purpose location writer.
 *
 * - {@link initializeLocationRecord}: a fresh selection (`data init`) where
 *   none exists - generation 1, no migration.
 * - {@link switchLocationForMigration}: `switching` replaces exactly the
 *   journal's previous location with its new pointer.
 * - {@link restoreLocationForRollback}: `rollback-requested` from `switching`
 *   or `switched` puts back exactly the journal's previous location - which
 *   lowers the generation, or removes the record for the implicit default
 *   root. Refused from every other phase, so never after activation.
 *
 * Each is idempotent: finding the target already in place is success,
 * finding anything but the expected source or target refuses.
 */
export async function initializeLocationRecord(input: {
  readonly bootstrapDir: string;
  readonly held: HeldBootstrapSerialization;
  readonly platform: DataRootPlatform;
  readonly root: string;
}): Promise<DataLocationRecord> {
  const next: DataLocationRecord = {
    version: 1,
    generation: 1,
    root: input.root,
    migrationId: null,
  };
  assertValidLocation(input.bootstrapDir, input.platform, next);
  const selector = readMigrationSelectorSync(input.bootstrapDir);
  if (selector.kind !== "absent") {
    throw new BootstrapRecordError(
      "transition-refused",
      "a data folder can only be initialized on an installation with no migration history",
      join(input.bootstrapDir, DATA_LOCATION_RECORD_FILENAME),
    );
  }
  await replaceLocation(input.bootstrapDir, input.held, null, next);
  return next;
}

export async function switchLocationForMigration(input: {
  readonly bootstrapDir: string;
  readonly held: HeldBootstrapSerialization;
  readonly platform: DataRootPlatform;
  readonly journal: MigrationJournal;
}): Promise<void> {
  const { journal } = input;
  requirePhase(
    input.bootstrapDir,
    journal,
    journal.phase === "switching",
    "switching",
  );
  const target = migrationLocationOf(journal);
  assertValidLocation(input.bootstrapDir, input.platform, target);
  const current = currentLocation(input.bootstrapDir);
  if (sameLocation(current, target)) return;
  // Above the retained previous pointer too: after a rollback to the default
  // root, `location.prev.json` still holds the rolled-back generation.
  const retained = readRecordFileSync(
    previousRecordPath(input.bootstrapDir, LOCATION_BASENAME),
    locationDecoder,
  );
  const floor = Math.max(
    current?.generation ?? 0,
    retained.kind === "valid"
      ? dataLocationRecordSchema.parse(retained.body).generation
      : 0,
  );
  if (target.generation <= floor) {
    throw new BootstrapRecordError(
      "generation-not-advanced",
      "a migration's location must advance the generation",
      join(input.bootstrapDir, DATA_LOCATION_RECORD_FILENAME),
    );
  }
  await replaceLocation(
    input.bootstrapDir,
    input.held,
    journal.previousLocation,
    target,
  );
}

export async function restoreLocationForRollback(input: {
  readonly bootstrapDir: string;
  readonly held: HeldBootstrapSerialization;
  readonly journal: MigrationJournal;
}): Promise<void> {
  const { journal } = input;
  requirePhase(
    input.bootstrapDir,
    journal,
    journal.phase === "rollback-requested" &&
      (journal.rollbackFromPhase === "switching" ||
        journal.rollbackFromPhase === "switched"),
    "rollback-requested from switching or switched",
  );
  const current = currentLocation(input.bootstrapDir);
  if (sameLocation(current, journal.previousLocation)) return;
  await replaceLocation(
    input.bootstrapDir,
    input.held,
    migrationLocationOf(journal),
    journal.previousLocation,
  );
}

/** The exact pointer a migration selects. */
export function migrationLocationOf(
  journal: MigrationJournal,
): DataLocationRecord {
  return {
    version: 1,
    generation: journal.nextGeneration,
    root: journal.destination.path,
    migrationId: journal.id,
  };
}

function requirePhase(
  bootstrapDir: string,
  journal: MigrationJournal,
  allowed: boolean,
  expected: string,
): void {
  const recorded = readMigrationJournalSync(bootstrapDir, journal.id);
  if (
    !allowed ||
    recorded.kind !== "valid" ||
    canonicalJson(recorded.record) !== canonicalJson(journal)
  ) {
    throw new BootstrapRecordError(
      "transition-refused",
      `this location change requires the durable journal in ${expected}`,
      join(bootstrapDir, DATA_LOCATION_RECORD_FILENAME),
    );
  }
}

function currentLocation(bootstrapDir: string): DataLocationRecord | null {
  const read = readLocationRecordSync(bootstrapDir);
  if (read.kind === "damaged") {
    throw new BootstrapRecordError(
      "record-damaged",
      `the location record is damaged (${read.reason}); run recovery before changing it`,
      join(bootstrapDir, DATA_LOCATION_RECORD_FILENAME),
    );
  }
  return read.kind === "valid" ? read.record : null;
}

function sameLocation(
  left: DataLocationRecord | null,
  right: DataLocationRecord | null,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertValidLocation(
  bootstrapDir: string,
  platform: DataRootPlatform,
  next: DataLocationRecord,
): void {
  const check = validateDataRootSelection(next.root, platform);
  if (
    !dataLocationRecordSchema.safeParse(next).success ||
    !check.ok ||
    check.root !== next.root ||
    dataRootPathsOverlap(next.root, bootstrapDir, platform)
  ) {
    throw new BootstrapRecordError(
      "invalid-record",
      "the location names an invalid data folder",
      join(bootstrapDir, DATA_LOCATION_RECORD_FILENAME),
    );
  }
}

async function replaceLocation(
  bootstrapDir: string,
  held: HeldBootstrapSerialization,
  expected: DataLocationRecord | null,
  next: DataLocationRecord | null,
): Promise<void> {
  await replacePair({
    bootstrapDir,
    held,
    basename: LOCATION_BASENAME,
    family: locationFamilyFor(bootstrapDir),
    expected,
    nextRaw: next === null ? null : `${JSON.stringify(next)}\n`,
  });
}

// ---- Startup gate -----------------------------------------------------------

export type StartupGateBlockCode =
  | "location-unreadable"
  | "location-changed"
  | "selector-damaged"
  | "journal-missing"
  | "journal-damaged"
  | "journal-mismatch"
  | "migration-in-progress";

export type StartupGateDecision =
  | {
      readonly kind: "open";
      /** The location generation this start is bound to; null for the implicit default root. */
      readonly generation: number | null;
    }
  | {
      readonly kind: "blocked";
      readonly code: StartupGateBlockCode;
      /** User-facing; carries no path. */
      readonly message: string;
      readonly migrationId: MigrationId | null;
    };

/**
 * Whether a normal Desktop, CLI-mutation, host or service start may open
 * runtime state now. Read-only and synchronous.
 *
 * Opens only when the location record and the journals agree on: a normal
 * installation with no migration evidence; an activated/cleaning/complete
 * generation; or a rolled-back transaction whose previous location is
 * exactly what is selected. A location naming a migration whose journal is
 * missing or damaged fails closed - a destination pointer alone never grants
 * startup. `processResolution`, when given, is the resolution this process
 * already derived its paths from; a different selection now means the root
 * changed under it and it must restart.
 */
/**
 * What the gate needs. Plain data (structured-clone safe), so a worker thread
 * that launches processes for an admitted process can evaluate the gate
 * itself at its own launch boundary.
 */
export type StartupGateInput = {
  readonly homeDir: string;
  readonly platform: DataRootPlatform;
  readonly processResolution: DataRootResolution | null;
};

export function evaluateStartupGate(
  input: StartupGateInput,
): StartupGateDecision {
  let resolution: DataRootResolution;
  try {
    resolution = resolveDataRoot(input.homeDir, input.platform);
  } catch (error) {
    if (!(error instanceof DataRootError)) throw error;
    return blocked("location-unreadable", error.message, null);
  }
  if (
    input.processResolution !== null &&
    canonicalJson(selectionOf(input.processResolution)) !==
      canonicalJson(selectionOf(resolution))
  ) {
    return blocked(
      "location-changed",
      "Traycer's data location changed while this process was running. Restart Traycer.",
      null,
    );
  }
  const bootstrapDir = resolution.bootstrapDir;
  const location = resolution.kind === "configured" ? resolution.record : null;
  const generation = location?.generation ?? null;

  const selector = readMigrationSelectorSync(bootstrapDir);
  if (selector.kind === "damaged") {
    return blocked(
      "selector-damaged",
      `Traycer's data migration record is damaged (${selector.reason}). Run \`traycer data recover\`.`,
      null,
    );
  }
  const activeId =
    selector.kind === "valid" ? selector.record.activeMigrationId : null;
  if (activeId !== null) {
    const journal = readMigrationJournalSync(bootstrapDir, activeId);
    const failure = journalFailure(journal, activeId);
    if (failure !== null) return failure;
    if (journal.kind !== "valid")
      return blocked("journal-missing", missingJournalMessage, activeId);
    const active = journal.record;
    if (phaseHoldsStartupBarrier(active.phase)) {
      return blocked(
        "migration-in-progress",
        "A Traycer data migration is in progress. Wait for it to finish, or run `traycer data status` / `traycer data recover`.",
        activeId,
      );
    }
    if (active.phase === "rolled-back") {
      if (canonicalJson(active.previousLocation) !== canonicalJson(location)) {
        return blocked("journal-mismatch", mismatchMessage, activeId);
      }
    } else if (phaseIsPostActivation(active.phase)) {
      if (location?.migrationId !== activeId) {
        return blocked("journal-mismatch", mismatchMessage, activeId);
      }
    }
  }
  if (location !== null && location.migrationId !== null) {
    const journal = readMigrationJournalSync(
      bootstrapDir,
      location.migrationId,
    );
    const failure = journalFailure(journal, location.migrationId);
    if (failure !== null) return failure;
    if (journal.kind !== "valid") {
      return blocked(
        "journal-missing",
        missingJournalMessage,
        location.migrationId,
      );
    }
    const evidence = journal.record;
    if (
      !phaseIsPostActivation(evidence.phase) ||
      evidence.nextGeneration !== location.generation ||
      evidence.destination.path !== location.root
    ) {
      return blocked(
        phaseHoldsStartupBarrier(evidence.phase)
          ? "migration-in-progress"
          : "journal-mismatch",
        phaseHoldsStartupBarrier(evidence.phase)
          ? "A Traycer data migration is in progress. Run `traycer data status` / `traycer data recover`."
          : mismatchMessage,
        location.migrationId,
      );
    }
  }
  return { kind: "open", generation };
}

/**
 * The exact bytes of every bootstrap record an open gate decision depends on
 * (`location.json` and every `migration*.json`), plus their names. Plain data
 * for another realm: a launch boundary that cannot import this module (the
 * spawn broker's worker loads with node builtins only) re-reads these files
 * and refuses on ANY difference - a barrier cannot go up without changing
 * one of them. Null when the gate is not open, or the records changed while
 * being captured.
 */
export type StartupGateEvidence = {
  readonly bootstrapDir: string;
  /** `STARTUP_GATE_EVIDENCE_FILE.source`, so the re-reader lists the same names. */
  readonly namePattern: string;
  readonly files: readonly {
    readonly name: string;
    readonly content: string;
  }[];
};

export const STARTUP_GATE_EVIDENCE_FILE =
  /^(?:location|migration(?:-m-[a-z0-9-]+)?)\.json$/u;

export function captureStartupGateEvidence(
  input: StartupGateInput,
): StartupGateEvidence | null {
  const bootstrapDir = dataBootstrapDirOf(input);
  const before = readEvidenceFiles(bootstrapDir);
  if (before === null || evaluateStartupGate(input).kind !== "open")
    return null;
  const after = readEvidenceFiles(bootstrapDir);
  return after !== null && canonicalJson(before) === canonicalJson(after)
    ? {
        bootstrapDir,
        namePattern: STARTUP_GATE_EVIDENCE_FILE.source,
        files: after,
      }
    : null;
}

function dataBootstrapDirOf(input: StartupGateInput): string {
  return (
    input.processResolution?.bootstrapDir ??
    join(input.homeDir, DATA_BOOTSTRAP_DIRNAME)
  );
}

/**
 * Strict: only a genuinely absent bootstrap folder (lstat ENOENT) reads as no
 * files. A folder that is a link or not a directory, an entry that is not a
 * regular file, or any read failure - including an entry vanishing between
 * listing and reading - is null: nothing can be vouched for.
 */
function readEvidenceFiles(
  bootstrapDir: string,
): StartupGateEvidence["files"] | null {
  try {
    const stats = lstatSync(bootstrapDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
  } catch (error) {
    return errorCode(error) === "ENOENT" ? [] : null;
  }
  const files: { name: string; content: string }[] = [];
  try {
    for (const name of readdirSync(bootstrapDir).sort()) {
      if (!STARTUP_GATE_EVIDENCE_FILE.test(name)) continue;
      const read = readRegularFileBytesNoFollowSync(join(bootstrapDir, name));
      if (read.kind !== "bytes") return null;
      files.push({ name, content: read.bytes.toString("utf8") });
    }
  } catch {
    return null;
  }
  return files;
}

const missingJournalMessage =
  "Traycer's data location names a migration whose record is missing. Traycer will not start without it; run `traycer data recover`.";
const mismatchMessage =
  "Traycer's data location and its migration record disagree. Run `traycer data recover`.";

function journalFailure(
  journal: DurableRecordRead<MigrationJournal>,
  id: MigrationId,
): StartupGateDecision | null {
  if (journal.kind === "absent")
    return blocked("journal-missing", missingJournalMessage, id);
  if (journal.kind === "damaged") {
    return blocked(
      "journal-damaged",
      `Traycer's data migration record is damaged (${journal.reason}). Run \`traycer data recover\`.`,
      id,
    );
  }
  return null;
}

function selectionOf(resolution: DataRootResolution): unknown {
  return resolution.kind === "default"
    ? { kind: "default", root: resolution.root }
    : { kind: "configured", record: resolution.record };
}

function blocked(
  code: StartupGateBlockCode,
  message: string,
  migrationId: MigrationId | null,
): StartupGateDecision {
  return { kind: "blocked", code, message, migrationId };
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}
