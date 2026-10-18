import { lstatSync, readdirSync, statSync } from "node:fs";
import {
  listMigrationJournalIdsSync,
  readMigrationJournalSync,
} from "./data-bootstrap-records";
import {
  phaseIsPostActivation,
  phaseIsTerminal,
  type MigrationId,
  type MigrationJournal,
} from "./data-migration-contracts";
import {
  dataRootPathsOverlap,
  defaultDataRoot,
  type DataRootPlatform,
  type DataRootResolution,
} from "./data-root";

/**
 * A populated default data folder (`<home>/.traycer`) beside a configured one.
 *
 * After a migration away from the default folder, the old folder stays as a
 * backup until `traycer data cleanup`. Anything else populated there - most
 * likely an older Traycer version that ignores the location record and booted
 * the default folder, minting a second installation - is unexpected. Neither
 * case is merged, moved or deleted; this only tells the user.
 *
 * Bounded and read-only, so Desktop and the CLI can run it at every start:
 * one `lstat` and one `readdir` of the default folder and a read of the
 * bootstrap journals. A retained backup is recognised by authoritative
 * identity evidence only - the folder's device and inode equal the source
 * the migration journal captured - not by its contents; `traycer data status`
 * additionally compares the backup with the migration's frozen inventory.
 */
export type DefaultDataRootFinding =
  /** The default folder is in use, absent, empty, or part of a migration still in progress. */
  | { readonly kind: "none" }
  /** The backup a migration left behind; it is removed only by `traycer data cleanup`. */
  | {
      readonly kind: "retained-backup";
      readonly path: string;
      readonly migrationId: MigrationId;
    }
  | {
      readonly kind: "unexpected";
      readonly path: string;
      /**
       * `no-migration`: no migration ever left this folder. `replaced`: a
       * migration's backup is not the folder now at that path. `cleaned-up`:
       * the backup was deleted and the folder was populated again since.
       */
      readonly reason: "no-migration" | "replaced" | "cleaned-up";
      readonly migrationId: MigrationId | null;
    };

const NONE: DefaultDataRootFinding = { kind: "none" };

export function inspectDefaultDataRoot(input: {
  readonly homeDir: string;
  readonly platform: DataRootPlatform;
  readonly resolution: DataRootResolution;
}): DefaultDataRootFinding {
  if (input.resolution.kind !== "configured") return NONE;
  const path = defaultDataRoot(input.homeDir);
  if (dataRootPathsOverlap(path, input.resolution.root, input.platform)) {
    return NONE;
  }
  if (!populated(path)) return NONE;
  const journals = readJournals(input.resolution.bootstrapDir);
  // A move still under way names the default folder as its live source.
  if (
    journals.some(
      (journal) =>
        !phaseIsTerminal(journal.phase) &&
        !phaseIsPostActivation(journal.phase) &&
        dataRootPathsOverlap(journal.source.path, path, input.platform),
    )
  ) {
    return NONE;
  }
  const left = journals.filter(
    (journal) =>
      phaseIsPostActivation(journal.phase) && journal.source.path === path,
  );
  if (left.length === 0) {
    return {
      kind: "unexpected",
      path,
      reason: "no-migration",
      migrationId: null,
    };
  }
  const identity = folderIdentity(path);
  for (const journal of left) {
    if (
      identity !== null &&
      journal.source.volumeId === identity.volumeId &&
      journal.source.directoryId === identity.directoryId &&
      journal.cleanupProgress?.finished !== true
    ) {
      return { kind: "retained-backup", path, migrationId: journal.id };
    }
  }
  const latest = left[left.length - 1];
  return {
    kind: "unexpected",
    path,
    reason:
      latest?.cleanupProgress?.finished === true ? "cleaned-up" : "replaced",
    migrationId: latest?.id ?? null,
  };
}

/** One line for a startup warning; carries the folder path, so never log it above DEBUG. */
export function describeDefaultDataRootFinding(
  finding: DefaultDataRootFinding,
): string | null {
  switch (finding.kind) {
    case "none":
      return null;
    case "retained-backup":
      return `Traycer's old data folder ${finding.path} is still kept as a backup of your last move. Once Traycer works from its new folder, remove it with \`traycer data cleanup ${finding.migrationId}\`. Do not open it with an older Traycer version.`;
    case "unexpected":
      return `Traycer found data in its default folder ${finding.path}, but uses another folder. It may have been created by an older Traycer version, which can repeat queued or scheduled work. Traycer has not changed either folder; run \`traycer data status\` for details.`;
  }
}

function populated(path: string): boolean {
  try {
    const stats = lstatSync(path);
    // A link or file where the folder belongs is not Traycer's own state, but
    // it is still something the user should hear about.
    if (!stats.isDirectory()) return true;
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function folderIdentity(
  path: string,
): { readonly volumeId: string; readonly directoryId: string } | null {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
    return { volumeId: String(stats.dev), directoryId: String(stats.ino) };
  } catch {
    return null;
  }
}

/** Valid journals in name order; damaged or unreadable ones are skipped (status reports them). */
function readJournals(bootstrapDir: string): MigrationJournal[] {
  let ids: MigrationId[];
  try {
    statSync(bootstrapDir);
    ids = listMigrationJournalIdsSync(bootstrapDir);
  } catch {
    return [];
  }
  const journals: MigrationJournal[] = [];
  for (const id of ids) {
    try {
      const read = readMigrationJournalSync(bootstrapDir, id);
      if (read.kind === "valid") journals.push(read.record);
    } catch {
      // Diagnostic only: an unreadable journal never decides anything here.
    }
  }
  return journals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
