import {
  evaluateStartupGate,
  listMigrationJournalIdsSync,
  readMigrationJournalSync,
  readMigrationSelectorSync,
} from "@traycer/protocol/config/data-bootstrap-records";
import {
  phaseIsPostActivation,
  phaseIsTerminal,
  rollbackAllowedFrom,
  type MigrationId,
  type MigrationJournal,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  DataRootError,
  dataBootstrapDir,
  defaultDataRoot,
  resolveDataRoot,
  type DataRootResolution,
} from "@traycer/protocol/config/data-root";
import {
  describeDefaultDataRootFinding,
  inspectDefaultDataRoot,
  type DefaultDataRootFinding,
} from "@traycer/protocol/config/data-root-default-check";
import {
  diffSourceAgainstInventory,
  loadContentInventory,
} from "../engine/content-inventory";
import { pointerState } from "../engine/migration-engine";
import {
  locateRecoveryBinaries,
  type RecoveryBinaryCandidate,
} from "../engine/recovery-binary";
import { checkRootIdentity } from "../engine/root-identity";
import { dataRootOperationAvailable } from "./data-availability";
import {
  ok,
  type DataCommandDeps,
  type DataCommandOutcome,
} from "./data-command-types";
import { formatBytes, nextStepLines } from "./data-report";

/**
 * `traycer data status`: where Traycer's data is, whether Traycer may start,
 * any migration and what can be done about it now.
 *
 * Pure reads. No lock (a running migration holds the coordinator lock, and
 * status must still answer then), no journal or bootstrap write, no folder
 * created, no repair: a damaged or torn record is reported as found. Runs
 * outside ordinary admission, so it also answers while a migration barrier is
 * up or the location record is unusable.
 */

type JournalRead =
  | { readonly kind: "valid"; readonly journal: MigrationJournal }
  | {
      readonly kind: "damaged";
      readonly id: MigrationId;
      readonly reason: string;
      readonly hasPreviousRevision: boolean;
    }
  | { readonly kind: "missing"; readonly id: MigrationId }
  | {
      readonly kind: "unreadable";
      readonly id: MigrationId;
      readonly reason: string;
    };

function readJournal(bootstrapDir: string, id: MigrationId): JournalRead {
  try {
    const read = readMigrationJournalSync(bootstrapDir, id);
    if (read.kind === "valid") return { kind: "valid", journal: read.record };
    if (read.kind === "absent") return { kind: "missing", id };
    return {
      kind: "damaged",
      id,
      reason: read.reason,
      hasPreviousRevision: read.previous !== null,
    };
  } catch (error) {
    return {
      kind: "unreadable",
      id,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

type BackupState =
  | "unchanged"
  | "changed"
  | "missing"
  | "replaced"
  | "unverifiable";

/** Whether a retained source still equals what the migration froze (metadata walk; no hashing). */
async function backupState(
  journal: MigrationJournal,
  signal: AbortSignal,
): Promise<BackupState> {
  const identity = await checkRootIdentity(journal.source).catch(() => null);
  if (identity === null) return "unverifiable";
  if (identity.kind === "missing") return "missing";
  if (identity.kind === "changed") return "replaced";
  if (journal.copyManifest === null) return "unverifiable";
  try {
    const inventory = await loadContentInventory({
      destinationRoot: journal.destination.path,
      migrationId: journal.id,
      digest: journal.copyManifest.digest,
    });
    const differences = await diffSourceAgainstInventory({
      sourceRoot: journal.source.path,
      inventory,
      limit: 1,
      signal,
    });
    return differences.length === 0 ? "unchanged" : "changed";
  } catch {
    return "unverifiable";
  }
}

const BACKUP_TEXT: Record<BackupState, string> = {
  unchanged: "unchanged since the move",
  changed:
    "CHANGED since the move - an older Traycer version may have run from it and repeated queued or scheduled work. Do not open it with an older version",
  missing: "no longer there",
  replaced:
    "replaced by a different folder at the same path; Traycer will not delete it",
  unverifiable: "could not be compared with the move's record",
};

async function coordinatorRunning(
  deps: DataCommandDeps,
  journal: MigrationJournal,
): Promise<boolean | null> {
  if (journal.coordinator === null) return false;
  try {
    const verdict = await deps.probe.verdict(
      journal.coordinator.pid,
      journal.coordinator.startIdentity,
    );
    return verdict === "alive-same"
      ? true
      : verdict === "indeterminate"
        ? null
        : false;
  } catch {
    return null;
  }
}

export async function dataStatus(
  deps: DataCommandDeps,
): Promise<DataCommandOutcome> {
  const bootstrapDir = dataBootstrapDir(deps.homeDir);
  const text: string[] = [];
  const data: Record<string, unknown> = {};

  let resolution: DataRootResolution | null = null;
  try {
    resolution = resolveDataRoot(deps.homeDir, deps.platform);
    data.location = {
      kind: resolution.kind,
      root: resolution.root,
      generation:
        resolution.kind === "configured" ? resolution.record.generation : null,
      migrationId:
        resolution.kind === "configured" ? resolution.record.migrationId : null,
    };
    text.push(
      `Data folder: ${resolution.root}${resolution.kind === "default" ? " (default)" : ""}`,
    );
  } catch (error) {
    if (!(error instanceof DataRootError)) throw error;
    data.location = {
      kind: "error",
      code: error.code,
      root: error.root,
      message: error.message,
    };
    text.push(`Data folder: unusable [${error.code}]`, `  ${error.message}`);
    if (error.code === "root-unavailable" && error.root !== null) {
      text.push(
        `  Reconnect the drive or restore access to ${error.root}, then start Traycer again.`,
      );
    } else if (error.code === "record-malformed") {
      text.push(
        "  If a newer Traycer version wrote it, use that version. Traycer will not overwrite it.",
      );
    }
  }
  text.push(`Location record folder: ${bootstrapDir}`);

  try {
    const gate = evaluateStartupGate({
      homeDir: deps.homeDir,
      platform: deps.platform,
      processResolution: null,
    });
    data.startup =
      gate.kind === "open"
        ? { kind: "open" }
        : { kind: "blocked", code: gate.code, message: gate.message };
    text.push(
      gate.kind === "open"
        ? "Traycer can start: yes"
        : `Traycer can start: no [${gate.code}]`,
    );
    if (gate.kind === "blocked") text.push(`  ${gate.message}`);
  } catch (error) {
    // Undecidable is reported, never guessed: startup itself fails closed here.
    data.startup = {
      kind: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
    text.push(
      "Traycer can start: cannot be determined (its bootstrap records could not be read)",
    );
  }

  let activeId: MigrationId | null = null;
  try {
    const selector = readMigrationSelectorSync(bootstrapDir);
    if (selector.kind === "damaged") {
      data.selector = {
        kind: "damaged",
        reason: selector.reason,
        hasPreviousRevision: selector.previous !== null,
      };
      text.push(`Migration record: damaged (${selector.reason})`);
      if (selector.previous !== null) {
        text.push(
          "Next:",
          "  traycer data recover --restore-record   restore its last good revision, if that is provably safe",
        );
      }
    } else {
      activeId =
        selector.kind === "valid" ? selector.record.activeMigrationId : null;
      data.selector = { kind: selector.kind, activeMigrationId: activeId };
    }
  } catch (error) {
    data.selector = {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
    text.push("Migration record: unreadable");
  }

  let ids: MigrationId[] = [];
  try {
    ids = listMigrationJournalIdsSync(bootstrapDir);
  } catch {
    ids = [];
  }
  const reads = ids.map((id) => readJournal(bootstrapDir, id));
  const migrations: Record<string, unknown>[] = [];
  for (const read of reads) {
    if (read.kind !== "valid") {
      migrations.push({
        id: read.id,
        kind: read.kind,
        reason: read.kind === "missing" ? null : read.reason,
      });
      if (read.id === activeId || read.kind === "damaged") {
        text.push(
          `Migration ${read.id}: journal ${read.kind}${read.kind === "missing" ? "" : ` (${read.reason})`}`,
        );
        if (read.kind === "damaged" && read.hasPreviousRevision) {
          text.push(
            "Next:",
            "  traycer data recover --restore-record   restore its last good revision, if that is provably safe",
          );
        }
      }
      continue;
    }
    const journal = read.journal;
    const entry: Record<string, unknown> = {
      id: journal.id,
      kind: "valid",
      phase: journal.phase,
      active: journal.id === activeId,
      source: journal.source.path,
      destination: journal.destination.path,
      rollbackAllowed:
        journal.phase === "rollback-requested" ||
        rollbackAllowedFrom(journal.phase),
    };
    const relevant =
      journal.id === activeId ||
      !phaseIsTerminal(journal.phase) ||
      (journal.phase === "complete" &&
        journal.cleanupProgress?.finished !== true) ||
      journal.phase === "rolled-back";
    if (!relevant) {
      migrations.push(entry);
      continue;
    }
    if (journal.phase === "rolled-back") {
      const leftover = await checkRootIdentity(journal.destination).catch(
        () => null,
      );
      // A discarded or never-allocated destination needs nothing more.
      if (leftover === null || leftover.kind !== "same") {
        entry.destinationLeftover = leftover?.kind ?? "unverifiable";
        migrations.push(entry);
        continue;
      }
      entry.destinationLeftover = "present";
    }
    text.push(
      `Migration ${journal.id}: ${journal.phase}`,
      `  from ${journal.source.path}`,
      `  to   ${journal.destination.path}`,
    );
    try {
      entry.pointer = pointerState(bootstrapDir, journal);
    } catch {
      entry.pointer = "damaged";
    }
    if (entry.pointer === "other") {
      text.push(
        "  The location record names neither folder of this move; Traycer will not overwrite it.",
      );
    }
    if (!phaseIsTerminal(journal.phase) && journal.phase !== "cleaning") {
      const running = await coordinatorRunning(deps, journal);
      entry.coordinatorRunning = running;
      if (running === true)
        text.push("  A Traycer data command is working on it right now.");
      if (running === null)
        text.push(
          "  Whether the command that started it is still running cannot be determined.",
        );
    }
    if (
      phaseIsPostActivation(journal.phase) &&
      journal.cleanupProgress?.finished !== true
    ) {
      const state = await backupState(journal, deps.signal);
      entry.backup = state;
      if (journal.copyManifest !== null)
        entry.backupBytes = journal.copyManifest.byteCount;
      text.push(
        `  Old folder kept as a backup${journal.copyManifest === null ? "" : ` (${formatBytes(journal.copyManifest.byteCount)})`}: ${BACKUP_TEXT[state]}.`,
      );
    }
    if (!phaseIsTerminal(journal.phase)) {
      const candidates: readonly RecoveryBinaryCandidate[] =
        await locateRecoveryBinaries({
          journal,
          platform: deps.platform,
        }).catch(() => []);
      entry.recoveryBinaries = candidates;
      const compatible = candidates.filter((candidate) => candidate.compatible);
      if (compatible.length > 0) {
        text.push(
          "  Traycer CLI copies that can continue it:",
          ...compatible.map((candidate) => `    ${candidate.path}`),
        );
      }
    }
    const next = nextStepLines(journal);
    if (next.length > 0) text.push("Next:", ...next);
    migrations.push(entry);
  }
  data.migrations = migrations;

  let finding: DefaultDataRootFinding = { kind: "none" };
  if (resolution !== null) {
    try {
      finding = inspectDefaultDataRoot({
        homeDir: deps.homeDir,
        platform: deps.platform,
        resolution,
      });
    } catch {
      finding = { kind: "none" };
    }
  }
  data.defaultFolder = { path: defaultDataRoot(deps.homeDir), finding };
  // A retained backup is already described with its migration above.
  if (finding.kind === "unexpected") {
    const line = describeDefaultDataRootFinding(finding);
    if (line !== null) text.push(`Warning: ${line}`);
  }

  data.available = {
    init: dataRootOperationAvailable(deps.availability, deps.platform, "init"),
    migrate: dataRootOperationAvailable(
      deps.availability,
      deps.platform,
      "migrate",
    ),
  };
  return ok(data, text);
}
