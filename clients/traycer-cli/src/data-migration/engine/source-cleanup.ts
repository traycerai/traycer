import type { BigIntStats } from "node:fs";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { MigrationAdmissionError } from "@traycer/protocol/config/data-migration-admission";
import {
  BootstrapRecordError,
  migrationLocationOf,
  readLocationRecordSync,
  readMigrationJournalSync,
} from "@traycer/protocol/config/data-bootstrap-records";
import {
  canonicalJson,
  type MigrationId,
  type MigrationJournal,
} from "@traycer/protocol/config/data-migration-contracts";
import { dataRootPathsOverlap } from "@traycer/protocol/config/data-root";
import { isErrnoException } from "../../runner/errors";
import { samePath } from "../external-actions/ledger";
import { externalActionStage } from "../external-actions/reconcile";
import {
  contentInventoryPath,
  diffSourceAgainstInventory,
  loadContentInventory,
  migrationEvidenceDir,
  parseInventoryTempName,
  RELOCATION_EVIDENCE_DIRNAME,
  sha256File,
  underRoot,
  type ContentFileEntry,
  type LoadedContentInventory,
} from "./content-inventory";
import {
  isPrefixOfVerifiedFile,
  ownedTempNonces,
  unlinkIfUnchanged,
  removeOwnedTempRecords,
} from "./byte-evidence";
import { withCoordinatorLock } from "./coordinator-lock";
import { isOwnedCopyTemp, parseCopyTemp } from "./copy-engine";
import type { MigrationEngineDeps } from "./engine-deps";
import {
  EngineStop,
  engineBlocker,
  stopped,
  stopWith,
  type EngineBlocker,
  type EngineResult,
} from "./engine-types";
import { JournalSession } from "./journal-session";
import { isProviderPath } from "./provider-roots";
import { checkRootIdentity } from "./root-identity";

/**
 * Explicit source cleanup after activation, and explicit discard of a
 * rolled-back destination. Both delete only what the migration's frozen
 * evidence proves is the migration's to delete, and refuse otherwise.
 *
 * Source cleanup (`cleanupSource`) runs only:
 * - from a process whose data root IS the migration's destination;
 * - while the location pointer is exactly the migration's pointer and the
 *   journal is `activated` (with every activation registration applied),
 *   `complete` or `cleaning`;
 * - on the captured source folder (same device and inode), which overlaps
 *   neither the bootstrap folder nor the destination.
 *
 * Before deleting anything it compares the whole source with the frozen
 * inventory (an added, changed or replaced entry refuses the whole cleanup;
 * a removed one is accepted only when resuming an interrupted cleanup) and
 * requires every remaining provider-native file's destination copy to be
 * byte-identical to the frozen bytes (the source backup is kept when a live
 * provider rewrote its destination copy). Each file is re-verified by
 * metadata and SHA-256 immediately before it is unlinked; a folder is removed
 * only when empty. Bootstrap journals and the destination's evidence are
 * never touched.
 */

function readJournal(bootstrapDir: string, id: MigrationId): MigrationJournal {
  const read = readMigrationJournalSync(bootstrapDir, id);
  if (read.kind === "absent")
    throw stopWith(
      "blocked",
      "journal-missing",
      id,
      "no journal is recorded for this migration",
    );
  if (read.kind === "damaged")
    throw stopWith(
      "damaged",
      "journal-damaged",
      id,
      `the migration's journal is damaged (${read.reason})`,
    );
  return read.record;
}

function pointerIsMigration(
  bootstrapDir: string,
  journal: MigrationJournal,
): boolean {
  const read = readLocationRecordSync(bootstrapDir);
  return (
    read.kind === "valid" &&
    canonicalJson(read.record) === canonicalJson(migrationLocationOf(journal))
  );
}

function sameFileFacts(
  stats: BigIntStats | null,
  entry: ContentFileEntry,
): boolean {
  return (
    stats !== null &&
    stats.isFile() &&
    Number(stats.size) === entry.size &&
    Number(stats.mode & 0o7777n) === entry.mode &&
    String(stats.mtimeNs) === entry.mtimeNs &&
    String(stats.ctimeNs) === entry.ctimeNs &&
    String(stats.dev) === entry.dev &&
    String(stats.ino) === entry.ino
  );
}

async function statBig(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    throw error;
  }
}

async function providerPreservationBlockers(
  journal: MigrationJournal,
  inventory: LoadedContentInventory,
  platform: MigrationEngineDeps["platform"],
): Promise<EngineBlocker[]> {
  const blockers: EngineBlocker[] = [];
  for (const entry of inventory.entries) {
    if (
      entry.kind !== "file" ||
      !isProviderPath(entry.path, inventory.header.providerRoots, platform)
    )
      continue;
    // Already removed from the source by an earlier pass: it was checked then.
    if ((await statBig(underRoot(journal.source.path, entry.path))) === null)
      continue;
    const copy = underRoot(journal.destination.path, entry.path);
    const stats = await statBig(copy);
    const intact =
      stats !== null &&
      stats.isFile() &&
      (await sha256File(copy)) === entry.sha256;
    if (!intact) {
      blockers.push(
        engineBlocker(
          "provider-bytes-not-retained",
          entry.path,
          "a provider's file in the destination no longer matches the source backup; the backup is kept",
        ),
      );
      if (blockers.length >= 50) break;
    }
  }
  return blockers;
}

/** Explicit source cleanup for migration `id`, launched from its destination. */
export async function cleanupSource(
  deps: MigrationEngineDeps,
  input: { readonly migrationId: MigrationId },
): Promise<EngineResult> {
  return withCoordinatorLock(deps, async ({ lock, bootstrapDir }) => {
    const journal = readJournal(bootstrapDir, input.migrationId);
    const session = JournalSession.resume({
      bootstrapDir,
      lock,
      probe: deps.probe,
      checkpoint: deps.checkpoint,
      now: deps.now,
      journal,
    });
    try {
      return await runCleanup(deps, session, bootstrapDir);
    } catch (error) {
      if (error instanceof EngineStop)
        return stopped(
          error.reason,
          session.journal,
          error.blockers,
          error.impact,
        );
      if (
        error instanceof MigrationAdmissionError ||
        error instanceof BootstrapRecordError
      ) {
        const damaged = error.code === "record-damaged";
        return stopped(
          damaged ? "damaged" : "conflict",
          session.journal,
          [engineBlocker(`cleanup-${error.code}`, null, error.message)],
          null,
        );
      }
      throw error;
    }
  });
}

async function runCleanup(
  deps: MigrationEngineDeps,
  session: JournalSession,
  bootstrapDir: string,
): Promise<EngineResult> {
  const journal = session.journal;
  if (
    journal.phase === "complete" &&
    journal.cleanupProgress?.finished === true
  )
    return { kind: "done", journal };
  if (
    journal.phase !== "activated" &&
    journal.phase !== "complete" &&
    journal.phase !== "cleaning"
  ) {
    throw stopWith(
      "blocked",
      "cleanup-not-activated",
      journal.id,
      "the source can be cleaned up only after the migration activated",
    );
  }
  if (
    journal.phase === "activated" &&
    journal.actions.some(
      (action) =>
        externalActionStage(action) === "activate" &&
        action.state !== "applied",
    )
  ) {
    throw stopWith(
      "blocked",
      "cleanup-activation-unfinished",
      journal.id,
      "finish the migration's activation (recover) before cleaning up",
    );
  }
  if (!pointerIsMigration(bootstrapDir, journal)) {
    throw stopWith(
      "conflict",
      "cleanup-pointer",
      null,
      "the data location is not this migration's destination",
    );
  }
  if (
    !samePath(deps.processDataRoot(), journal.destination.path, deps.platform)
  ) {
    throw stopWith(
      "blocked",
      "cleanup-not-from-destination",
      null,
      "run cleanup from Traycer using the new data folder",
    );
  }
  for (const other of [bootstrapDir, journal.destination.path]) {
    if (dataRootPathsOverlap(journal.source.path, other, deps.platform)) {
      throw stopWith(
        "conflict",
        "cleanup-overlap",
        journal.source.path,
        "the source overlaps a folder cleanup must never delete",
      );
    }
  }
  const destination = await checkRootIdentity(journal.destination);
  if (destination.kind !== "same") {
    throw stopWith(
      "conflict",
      "destination-replaced",
      journal.destination.path,
      "the destination is not the folder this migration recorded",
    );
  }
  const source = await checkRootIdentity(journal.source);
  if (source.kind === "changed") {
    throw stopWith(
      "conflict",
      "source-replaced",
      journal.source.path,
      "the source folder is not the folder this migration recorded",
    );
  }
  const progress = journal.cleanupProgress ?? {
    removedEntries: 0,
    removedBytes: 0,
    finished: false,
  };
  if (source.kind === "missing") {
    if (journal.phase !== "cleaning") {
      throw stopWith(
        "failed",
        "source-missing",
        journal.source.path,
        "the source folder is not available",
      );
    }
    // The last pass removed the root itself before recording completion.
    const done = await session.advance({
      phase: "complete",
      cleanupProgress: { ...progress, finished: true },
    });
    return { kind: "done", journal: done };
  }
  if (journal.copyManifest === null)
    throw stopWith(
      "damaged",
      "copy-manifest-missing",
      journal.id,
      "the journal records no source inventory",
    );
  const inventory = await loadContentInventory({
    destinationRoot: journal.destination.path,
    migrationId: journal.id,
    digest: journal.copyManifest.digest,
  });
  const resuming = journal.phase === "cleaning";
  const differences = (
    await diffSourceAgainstInventory({
      sourceRoot: journal.source.path,
      inventory,
      limit: 50,
      signal: deps.signal,
    })
  ).filter((difference) => !(resuming && difference.change === "removed"));
  if (differences.length > 0) {
    throw new EngineStop(
      "conflict",
      differences.map((difference) =>
        engineBlocker(
          `source-${difference.change}`,
          difference.path,
          "the source changed after the migration; cleanup deletes nothing it did not copy",
        ),
      ),
      null,
    );
  }
  const provider = await providerPreservationBlockers(
    journal,
    inventory,
    deps.platform,
  );
  if (provider.length > 0) throw new EngineStop("blocked", provider, null);
  if (!resuming)
    await session.advance({ phase: "cleaning", cleanupProgress: progress });

  let removedEntries = progress.removedEntries;
  let removedBytes = progress.removedBytes;
  let sincePersist = 0;
  const persist = async (): Promise<void> => {
    const current = session.journal.cleanupProgress;
    if (current !== null && current.removedEntries === removedEntries) return;
    await session.advance({
      cleanupProgress: { removedEntries, removedBytes, finished: false },
    });
  };
  // Children before their folder: the inventory lists every folder first.
  for (const entry of [...inventory.entries].reverse()) {
    if (deps.signal.aborted) {
      await persist();
      throw stopWith(
        "failed",
        "cancelled",
        null,
        "cleanup was cancelled; run it again to continue",
      );
    }
    const path = underRoot(journal.source.path, entry.path);
    if (entry.kind === "dir") {
      try {
        await rmdir(path);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") continue;
        if (
          isErrnoException(error) &&
          (error.code === "ENOTEMPTY" || error.code === "EEXIST")
        ) {
          await persist();
          throw stopWith(
            "conflict",
            "source-added",
            entry.path,
            "a source folder holds an entry the migration did not copy",
          );
        }
        throw error;
      }
    } else {
      const stats = await statBig(path);
      if (stats === null) continue;
      if (
        !sameFileFacts(stats, entry) ||
        (await sha256File(path)) !== entry.sha256
      ) {
        await persist();
        throw stopWith(
          "conflict",
          "source-modified",
          entry.path,
          "a source file changed; cleanup stopped before deleting it",
        );
      }
      await deps.checkpoint("before-cleanup-delete");
      // Re-read after the hash: a write into bytes the hash had already read
      // leaves the digest equal, but never the metadata.
      const current = await statBig(path);
      if (current === null) continue;
      if (!sameFileFacts(current, entry)) {
        await persist();
        throw stopWith(
          "conflict",
          "source-modified",
          entry.path,
          "a source file changed; cleanup stopped before deleting it",
        );
      }
      await unlink(path);
      await deps.checkpoint("after-cleanup-delete");
      removedBytes += entry.size;
    }
    removedEntries += 1;
    sincePersist += 1;
    deps.progress({
      kind: "cleanup",
      removedEntries,
      totalEntries: inventory.entries.length,
    });
    if (sincePersist >= 500) {
      sincePersist = 0;
      await persist();
    }
  }
  await persist();
  if ((await checkRootIdentity(journal.source)).kind === "same") {
    try {
      await rmdir(journal.source.path);
    } catch (error) {
      if (
        isErrnoException(error) &&
        (error.code === "ENOTEMPTY" || error.code === "EEXIST")
      ) {
        throw stopWith(
          "conflict",
          "source-added",
          journal.source.path,
          "the source folder holds an entry the migration did not copy",
        );
      }
      throw error;
    }
  }
  const done = await session.advance({
    phase: "complete",
    cleanupProgress: { removedEntries, removedBytes, finished: true },
  });
  return { kind: "done", journal: done };
}

// ---- Rolled-back destination ---------------------------------------------------

/**
 * Remove a rolled-back migration's destination leftovers. A file is deleted
 * only on evidence that deleting it loses nothing and that it is the
 * migration's (never on a name or a timestamp alone):
 * - a copy at an inventory path whose bytes still equal the frozen source
 *   bytes (the inventory is pinned by the journal's digest);
 * - an interrupted copy temp proven by `isOwnedCopyTemp` (a nonce the
 *   migration recorded before creating it, one temp per nonce, bytes that are
 *   a prefix of a file still hashing to the frozen digest);
 * - in the evidence folder: an interrupted inventory temp proven the same way
 *   against the pinned inventory, then the pinned inventory itself and the
 *   nonce records, last, once nothing else was retained.
 * Everything else stays and is reported with a blocker naming why: a repaired
 * store or its sidecars and the session impact record and receipt files (no
 * exact record of their on-disk bytes exists: a receipt's `outputDigest`
 * covers the store's logical output, not its file), a copy that no longer
 * equals the frozen bytes, an unproven temp, any unknown entry, and evidence
 * that no pinned inventory accounts for. The destination folder itself is
 * removed only when then empty and still the captured folder. No journal
 * revision is written: the operation is idempotent, an interrupted run is
 * resumed by running it again, and the retained evidence is its own record.
 */
export async function discardRolledBackDestination(
  deps: MigrationEngineDeps,
  input: { readonly migrationId: MigrationId },
): Promise<EngineResult> {
  return withCoordinatorLock(deps, async ({ bootstrapDir }) => {
    const journal = readJournal(bootstrapDir, input.migrationId);
    if (journal.phase !== "rolled-back") {
      throw stopWith(
        "blocked",
        "discard-not-rolled-back",
        journal.id,
        "only a rolled-back migration's destination can be discarded",
      );
    }
    if (
      pointerIsMigration(bootstrapDir, journal) ||
      samePath(deps.processDataRoot(), journal.destination.path, deps.platform)
    ) {
      throw stopWith(
        "conflict",
        "discard-destination-in-use",
        null,
        "the destination is the data folder in use",
      );
    }
    const identity = await checkRootIdentity(journal.destination);
    if (identity.kind === "missing") return { kind: "done", journal };
    if (identity.kind === "changed") {
      throw stopWith(
        "conflict",
        "destination-replaced",
        journal.destination.path,
        "the destination is not the folder this migration recorded",
      );
    }
    const retained = await discardContents(journal, deps.nodePlatform);
    if (retained.length > 0)
      return stopped("blocked", journal, retained.slice(0, 50), null);
    return { kind: "done", journal };
  });
}

type DestinationFile = { readonly relative: string; readonly absolute: string };

async function pinnedInventory(
  journal: MigrationJournal,
): Promise<LoadedContentInventory | null> {
  if (journal.copyManifest === null) return null;
  try {
    return await loadContentInventory({
      destinationRoot: journal.destination.path,
      migrationId: journal.id,
      digest: journal.copyManifest.digest,
    });
  } catch (error) {
    if (error instanceof EngineStop) return null;
    throw error;
  }
}

/** Collect every non-folder entry and every folder (children first), outside the evidence folder. */
async function walkDestination(
  root: string,
  evidence: string,
): Promise<{
  readonly files: readonly DestinationFile[];
  readonly dirs: readonly string[];
}> {
  const files: DestinationFile[] = [];
  const dirs: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const dir = relative.length === 0 ? root : underRoot(root, relative);
    for (const name of (await readdir(dir)).sort()) {
      const child = relative.length === 0 ? name : `${relative}/${name}`;
      if (child === evidence) continue;
      const absolute = underRoot(root, child);
      const stats = await lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await visit(child);
        dirs.push(child);
      } else {
        files.push({ relative: child, absolute });
      }
    }
  };
  await visit("");
  return { files, dirs };
}

async function removeEmptyDir(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      !isErrnoException(error) ||
      (error.code !== "ENOENT" &&
        error.code !== "ENOTEMPTY" &&
        error.code !== "EEXIST")
    )
      throw error;
  }
}

/** The file's metadata as read before hashing it, when its bytes equal the frozen bytes; otherwise null. */
async function frozenStats(
  path: string,
  entry: ContentFileEntry,
): Promise<BigIntStats | null> {
  const stats = await statBig(path);
  return stats !== null &&
    stats.isFile() &&
    Number(stats.size) === entry.size &&
    (await sha256File(path)) === entry.sha256
    ? stats
    : null;
}

async function discardContents(
  journal: MigrationJournal,
  platform: NodeJS.Platform,
): Promise<EngineBlocker[]> {
  const root = journal.destination.path;
  const evidenceRelative = `${RELOCATION_EVIDENCE_DIRNAME}/migrations/${journal.id}`;
  const receiptsDir = `${RELOCATION_EVIDENCE_DIRNAME}/receipts/${journal.id}/`;
  const repairedKeys = new Set<string>();
  for (const receipt of journal.adapterReceipts) {
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      repairedKeys.add(`${receipt.storeKey}${suffix}`);
  }
  // Read before the digest proof below, so the pinned inventory is deleted
  // last only while it is still the file that proof read.
  const inventoryBefore = await statBig(contentInventoryPath(root, journal.id));
  const inventory = await pinnedInventory(journal);
  const frozen = new Map<string, ContentFileEntry>();
  for (const entry of inventory?.entries ?? [])
    if (entry.kind === "file") frozen.set(entry.path, entry);
  const evidenceDir = migrationEvidenceDir(root, journal.id);
  const nonces = await ownedTempNonces(evidenceDir);
  const retained: EngineBlocker[] = [];
  const retain = (code: string, path: string, message: string): void => {
    retained.push(engineBlocker(code, path, message));
  };

  const { files, dirs } = await walkDestination(root, evidenceRelative);
  const tempsPerNonce = new Map<string, number>();
  for (const file of files) {
    const temp = parseCopyTemp(file.relative, journal.id);
    if (temp !== null)
      tempsPerNonce.set(temp.nonce, (tempsPerNonce.get(temp.nonce) ?? 0) + 1);
  }
  // Temps before the finals they may be proven against.
  const temps: {
    readonly file: DestinationFile;
    readonly stats: BigIntStats;
  }[] = [];
  const finals: DestinationFile[] = [];
  for (const file of files) {
    const temp = parseCopyTemp(file.relative, journal.id);
    const owner = temp === null ? undefined : frozen.get(temp.file);
    if (temp === null || owner === undefined) {
      finals.push(file);
      continue;
    }
    // Read before the proof, so a write during it is seen at the unlink.
    const before = await statBig(file.absolute);
    if (before === null) continue;
    let proven = false;
    if (tempsPerNonce.get(temp.nonce) === 1) {
      for (const reference of [
        underRoot(journal.source.path, temp.file),
        underRoot(root, temp.file),
      ]) {
        proven = await isOwnedCopyTemp({
          tempPath: file.absolute,
          sourceFile: reference,
          entry: owner,
          nonceRecorded: nonces.has(temp.nonce),
          platform,
        });
        if (proven) break;
      }
    }
    if (proven) temps.push({ file, stats: before });
    else
      retain(
        "discard-temp-unproven",
        file.relative,
        "left in place: a copy temp this migration cannot prove it wrote",
      );
  }
  for (const { file, stats } of temps) {
    if ((await unlinkIfUnchanged(file.absolute, stats)) === "changed") {
      retain(
        "discard-temp-unproven",
        file.relative,
        "left in place: a copy temp this migration cannot prove it wrote",
      );
    }
  }
  for (const file of finals) {
    const entry = frozen.get(file.relative);
    const frozenCopy =
      entry === undefined ? null : await frozenStats(file.absolute, entry);
    if (frozenCopy !== null) {
      if ((await unlinkIfUnchanged(file.absolute, frozenCopy)) === "changed") {
        retain(
          "discard-modified",
          file.relative,
          "left in place: the file no longer equals the bytes the migration copied",
        );
      }
    } else if (repairedKeys.has(file.relative)) {
      retain(
        "discard-repaired-store",
        file.relative,
        "left in place: a repaired store has no exact record of its bytes to prove it unchanged",
      );
    } else if (file.relative.startsWith(receiptsDir)) {
      retain(
        "discard-receipt",
        file.relative,
        "left in place: a repair receipt has no exact record of its bytes to prove it unchanged",
      );
    } else if (entry !== undefined) {
      retain(
        "discard-modified",
        file.relative,
        "left in place: the file no longer equals the bytes the migration copied",
      );
    } else {
      retain(
        "discard-unknown",
        file.relative,
        "left in place: the migration did not create this file",
      );
    }
  }
  for (const dir of dirs) await removeEmptyDir(underRoot(root, dir));
  if (retained.length > 0) return retained;

  // The evidence folder last: it is the account of what may be deleted.
  let evidenceNames: string[] = [];
  try {
    evidenceNames = await readdir(evidenceDir);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  if (
    evidenceNames.length > 0 &&
    (inventory === null || journal.copyManifest === null)
  ) {
    return [
      engineBlocker(
        "discard-evidence-unpinned",
        evidenceRelative,
        "left in place: no inventory recorded in the journal accounts for this evidence",
      ),
    ];
  }
  const inventoryFile = contentInventoryPath(root, journal.id);
  const pinnedHex =
    journal.copyManifest === null
      ? ""
      : journal.copyManifest.digest.replace(/^sha256:/u, "");
  for (const name of evidenceNames) {
    if (name === basename(inventoryFile) || name === "owned-temps") continue;
    const nonce = parseInventoryTempName(name);
    const before = await statBig(join(evidenceDir, name));
    if (before === null) continue;
    const proven =
      nonce !== null &&
      nonces.has(nonce) &&
      (await isPrefixOfVerifiedFile({
        candidate: join(evidenceDir, name),
        reference: inventoryFile,
        referenceSha256: pinnedHex,
        platform,
      }));
    if (
      !proven ||
      (await unlinkIfUnchanged(join(evidenceDir, name), before)) === "changed"
    )
      retain(
        "discard-evidence-unknown",
        `${evidenceRelative}/${name}`,
        "left in place: the migration cannot prove it wrote this evidence file",
      );
  }
  if (retained.length > 0) return retained;
  const inventoryKept =
    inventoryBefore === null
      ? (await statBig(inventoryFile)) !== null
      : (await unlinkIfUnchanged(inventoryFile, inventoryBefore)) === "changed";
  if (inventoryKept) {
    return [
      engineBlocker(
        "discard-evidence-unknown",
        `${evidenceRelative}/${basename(inventoryFile)}`,
        "left in place: the inventory changed after the migration proved it",
      ),
    ];
  }
  await removeOwnedTempRecords(evidenceDir, nonces);
  for (const dir of [
    evidenceDir,
    join(root, RELOCATION_EVIDENCE_DIRNAME, "migrations"),
    join(root, RELOCATION_EVIDENCE_DIRNAME),
  ]) {
    await removeEmptyDir(dir);
  }
  if (
    (await checkRootIdentity(journal.destination)).kind === "same" &&
    (await readdir(root)).length === 0
  ) {
    await rmdir(root);
  }
  return [];
}
