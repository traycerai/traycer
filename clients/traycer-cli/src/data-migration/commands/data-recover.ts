import {
  readMigrationJournalSync,
  readMigrationSelectorSync,
} from "@traycer/protocol/config/data-bootstrap-records";
import {
  phaseIsTerminal,
  rollbackAllowedFrom,
  type MigrationJournal,
  type Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";
import { dataBootstrapDir } from "@traycer/protocol/config/data-root";
import { CLI_ERROR_CODES } from "../../runner/errors";
import {
  restoreDamagedRecord,
  resumeMigration,
  rollbackMigration,
} from "../engine/migration-engine";
import {
  confirmOrRefuse,
  failed,
  ok,
  type DataCommandDeps,
  type DataCommandOutcome,
} from "./data-command-types";
import { engineProgressReporter, settleMigrationRun } from "./data-migrate";
import { stoppedOutcome } from "./data-report";

/**
 * `traycer data recover [--rollback | --restore-record]`: finish an
 * interrupted migration from its recorded phase.
 *
 * - default: continue it - forward, or, when a rollback was already
 *   requested, finish that rollback;
 * - `--rollback`: put everything back in the old folder. The engine refuses
 *   it from `activated` on: the new folder is then authoritative and the old
 *   one is only a backup, whatever has or has not been written since;
 * - `--restore-record`: put back the last good revision of a damaged
 *   migration record, only where the engine proves that is safe.
 *
 * Acts only on the migration the bootstrap records name; it never starts one
 * and never runs outside the engine's own identity and phase checks, so it
 * needs no availability gate and stays usable whenever a migration exists.
 */

type ActiveRead =
  | { readonly kind: "none" }
  | { readonly kind: "journal"; readonly journal: MigrationJournal }
  | { readonly kind: "damaged-selector" }
  | { readonly kind: "damaged-journal"; readonly id: MigrationJournal["id"] }
  | { readonly kind: "missing-journal"; readonly id: MigrationJournal["id"] };

function readActive(bootstrapDir: string): ActiveRead {
  const selector = readMigrationSelectorSync(bootstrapDir);
  if (selector.kind === "damaged") return { kind: "damaged-selector" };
  const id =
    selector.kind === "valid" ? selector.record.activeMigrationId : null;
  if (id === null) return { kind: "none" };
  const journal = readMigrationJournalSync(bootstrapDir, id);
  if (journal.kind === "damaged") return { kind: "damaged-journal", id };
  if (journal.kind === "absent") return { kind: "missing-journal", id };
  return { kind: "journal", journal: journal.record };
}

export async function dataRecover(
  deps: DataCommandDeps,
  input: {
    readonly rollback: boolean;
    readonly restoreRecord: boolean;
    readonly yes: boolean;
    readonly acceptSessionImpact: Sha256Digest | null;
  },
): Promise<DataCommandOutcome> {
  if (input.rollback && input.restoreRecord) {
    return failed(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
      "use either --rollback or --restore-record",
      null,
      [],
    );
  }
  const active = readActive(dataBootstrapDir(deps.homeDir));
  const engine = deps.engine({
    signal: deps.signal,
    progress: engineProgressReporter(deps.io),
  });

  if (input.restoreRecord) {
    if (
      active.kind !== "damaged-selector" &&
      active.kind !== "damaged-journal"
    ) {
      return failed(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
        "no damaged migration record to restore",
        null,
        [],
      );
    }
    const what =
      active.kind === "damaged-selector"
        ? "the migration selector record"
        : `the journal of migration ${active.id}`;
    const refusal = await confirmOrRefuse(
      deps,
      input.yes,
      [`Restore the last good revision of ${what}.`],
      "Restore it?",
    );
    if (refusal !== null) return refusal;
    const result = await restoreDamagedRecord(
      engine,
      active.kind === "damaged-selector"
        ? { kind: "selector" }
        : { kind: "journal", id: active.id },
    );
    if (result.kind === "stopped") return stoppedOutcome(result, []);
    return ok({ migrationId: result.journal.id, phase: result.journal.phase }, [
      `Restored ${what}. Migration ${result.journal.id} is at ${result.journal.phase}; run \`traycer data status\`.`,
    ]);
  }

  if (
    active.kind === "damaged-selector" ||
    active.kind === "damaged-journal" ||
    active.kind === "missing-journal"
  ) {
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      active.kind === "missing-journal"
        ? "the active migration's journal is missing; Traycer will not guess its state. Run `traycer data status`."
        : "a migration record is damaged; run `traycer data recover --restore-record`, or `traycer data status` for details",
      { record: active.kind },
      [],
    );
  }
  if (active.kind === "none" || phaseIsTerminal(active.journal.phase)) {
    return ok({ migrationId: null }, ["No data migration needs recovery."]);
  }
  const journal = active.journal;
  if (
    input.rollback &&
    journal.phase !== "rollback-requested" &&
    !rollbackAllowedFrom(journal.phase)
  ) {
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      "this move can no longer be rolled back: Traycer already uses the new folder, and the old one is only a backup",
      { migrationId: journal.id, phase: journal.phase },
      journal.phase === "activated"
        ? ["Next:", "  traycer data recover   finish the move"]
        : [],
    );
  }
  const plan =
    input.rollback || journal.phase === "rollback-requested"
      ? journal.phase === "planned"
        ? `Roll back the planned move to ${journal.destination.path}. Nothing has been copied and the old folder has not been written; the destination folder it created is removed if still empty, and its record stays in ~/.traycer-bootstrap.`
        : `Put everything back in ${journal.source.path}, undoing the move to ${journal.destination.path}.`
      : `Continue the move from ${journal.source.path} to ${journal.destination.path} (now at: ${journal.phase}).`;
  const refusal = await confirmOrRefuse(
    deps,
    input.yes,
    [`Migration ${journal.id}`, plan],
    "Go ahead?",
  );
  if (refusal !== null) return refusal;
  // Same contract as `migrate`: only an ordinary interactive run prompts.
  const prompt = deps.io.interactive && !input.yes;
  const result = input.rollback
    ? await rollbackMigration(engine)
    : await resumeMigration(engine, {
        acceptedSessionImpactDigest: input.acceptSessionImpact,
        reviewImpact: prompt,
      });
  return settleMigrationRun(deps, engine, result, { prompt, fromStart: false });
}
