import { readMigrationJournalSync } from "@traycer/protocol/config/data-bootstrap-records";
import {
  migrationIdSchema,
  phaseIsPostActivation,
  type MigrationJournal,
} from "@traycer/protocol/config/data-migration-contracts";
import { dataBootstrapDir } from "@traycer/protocol/config/data-root";
import { CLI_ERROR_CODES } from "../../runner/errors";
import {
  cleanupSource,
  discardRolledBackDestination,
} from "../engine/source-cleanup";
import {
  confirmOrRefuse,
  failed,
  ok,
  type DataCommandDeps,
  type DataCommandOutcome,
} from "./data-command-types";
import { engineProgressReporter, pathPresence } from "./data-migrate";
import { formatBytes, stoppedOutcome } from "./data-report";

/**
 * `traycer data cleanup <migration-id>`: permanently delete the copy of the
 * data a migration no longer uses. Which copy depends on how it ended, and the
 * prompt names it with its path and the phase:
 *
 * - after the move took effect (`activated`, `complete`, `cleaning`): the OLD
 *   folder, the backup the move kept. Run from Traycer using the new folder.
 *   The engine deletes only what the move's frozen inventory proves is the
 *   backup's own unchanged content, keeps every provider file it cannot
 *   verify is preserved in the new folder, refuses on anything added or
 *   changed, and never touches the new folder or `~/.traycer-bootstrap`
 *   (its records are kept permanently).
 * - after a rollback (`rolled-back`): the NEW folder's unused partial copy.
 *   Your data stayed in, and is still used from, the old folder.
 *
 * Nothing is deleted without `--yes` or an answer at the prompt. Ungated: it
 * acts only on a migration that exists, under the engine's identity and
 * phase checks.
 */
export async function dataCleanup(
  deps: DataCommandDeps,
  input: { readonly migrationId: string; readonly yes: boolean },
): Promise<DataCommandOutcome> {
  const parsed = migrationIdSchema.safeParse(input.migrationId);
  if (!parsed.success) {
    return failed(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
      "that is not a migration id (see `traycer data status`)",
      null,
      [],
    );
  }
  const id = parsed.data;
  const read = readMigrationJournalSync(dataBootstrapDir(deps.homeDir), id);
  if (read.kind === "absent") {
    return failed(
      CLI_ERROR_CODES.NOT_FOUND,
      `no migration ${id} is recorded on this machine`,
      null,
      [],
    );
  }
  if (read.kind === "damaged") {
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      "this migration's record is damaged; nothing can be deleted for it. Run `traycer data status`.",
      { migrationId: id },
      [],
    );
  }
  const journal = read.record;
  const gone = await alreadyDeletedSide(journal);
  if (gone === "unreachable") {
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      `Traycer cannot reach ${journal.destination.path}; reconnect its drive and run \`traycer data cleanup ${id}\` again. Nothing was deleted.`,
      { migrationId: id, phase: journal.phase },
      [],
    );
  }
  if (gone !== null) {
    const path =
      gone === "source" ? journal.source.path : journal.destination.path;
    return ok(
      {
        migrationId: id,
        deleted: gone,
        path,
        phase: journal.phase,
        alreadyDeleted: true,
      },
      [
        gone === "source"
          ? `The old folder ${path} was already deleted.`
          : `The unused copy ${path} was already deleted. Traycer keeps using ${journal.source.path}.`,
      ],
    );
  }
  const plan = cleanupPlan(journal);
  if (plan === null) {
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      `migration ${id} is at ${journal.phase}; there is nothing to clean up until it is finished or rolled back (see \`traycer data recover\`)`,
      { migrationId: id, phase: journal.phase },
      [],
    );
  }
  const refusal = await confirmOrRefuse(
    deps,
    input.yes,
    plan.lines,
    plan.question,
  );
  if (refusal !== null) return refusal;
  const engine = deps.engine({
    signal: deps.signal,
    progress: engineProgressReporter(deps.io),
  });
  const result =
    plan.side === "source"
      ? await cleanupSource(engine, { migrationId: id })
      : await discardRolledBackDestination(engine, { migrationId: id });
  if (result.kind === "stopped") {
    if (plan.side === "source") {
      return stoppedOutcome(result, [
        `Cleanup of ${plan.path} stopped. What it already deleted is recorded; \`traycer data cleanup ${id}\` continues from there once the problem below is resolved.`,
      ]);
    }
    // Only files left in place (not a refusal such as the folder being in
    // use again) make the folder safe to finish by hand.
    const onlyKeptFiles = result.blockers.every(
      (blocker) =>
        blocker.code.startsWith("discard-") &&
        !DISCARD_REFUSALS.has(blocker.code),
    );
    return stoppedOutcome(result, [
      onlyKeptFiles
        ? `Cleanup of ${plan.path} deleted what it could prove is the move's own copy and kept the files below. Traycer does not use ${plan.path}; once you have checked them, you can delete that folder yourself.`
        : `Cleanup of ${plan.path} stopped.`,
    ]);
  }
  const data = {
    migrationId: id,
    deleted: plan.side,
    path: plan.path,
    phase: result.journal.phase,
    alreadyDeleted: false,
  };
  return ok(
    data,
    plan.side === "source"
      ? [
          `Deleted the old folder ${plan.path}.`,
          "Traycer keeps the migration's records in ~/.traycer-bootstrap.",
        ]
      : [
          `Deleted the unused copy ${plan.path}. Traycer keeps using ${journal.source.path}.`,
        ],
  );
}

/** Discard stops that refuse the whole operation rather than keep individual files. */
const DISCARD_REFUSALS: ReadonlySet<string> = new Set([
  "discard-not-rolled-back",
  "discard-destination-in-use",
]);

/**
 * The side an earlier cleanup already deleted, so a re-run has nothing left
 * to do; "unreachable" when the rolled-back copy's presence cannot be proven
 * either way (an offline drive answers ENOENT too).
 */
async function alreadyDeletedSide(
  journal: MigrationJournal,
): Promise<"source" | "destination" | "unreachable" | null> {
  if (
    journal.phase === "complete" &&
    journal.cleanupProgress?.finished === true
  )
    return "source";
  if (journal.phase === "rolled-back") {
    const presence = await pathPresence(journal.destination.path);
    if (presence === "absent") return "destination";
    if (presence === "unknown") return "unreachable";
  }
  return null;
}

type CleanupPlan = {
  readonly side: "source" | "destination";
  readonly path: string;
  readonly lines: readonly string[];
  readonly question: string;
};

function cleanupPlan(journal: MigrationJournal): CleanupPlan | null {
  if (phaseIsPostActivation(journal.phase)) {
    const bytes =
      journal.copyManifest === null
        ? ""
        : ` (${formatBytes(journal.copyManifest.byteCount)})`;
    return {
      side: "source",
      path: journal.source.path,
      lines: [
        `Migration ${journal.id} (${journal.phase}): Traycer uses ${journal.destination.path}.`,
        `This PERMANENTLY DELETES the OLD folder ${journal.source.path}${bytes}, the backup the move kept. It cannot be undone.`,
        "Only content the move recorded and that is unchanged is deleted; if anything was added or changed there, nothing is deleted and you are told what.",
        `Provider files are kept unless the same bytes are verified in ${journal.destination.path}. ${journal.destination.path} and ~/.traycer-bootstrap are not touched.`,
        "Deleting the backup also removes the risk of an older Traycer version running from it and repeating queued or scheduled work.",
      ],
      question: `Permanently delete ${journal.source.path}?`,
    };
  }
  if (journal.phase === "rolled-back") {
    return {
      side: "destination",
      path: journal.destination.path,
      lines: [
        `Migration ${journal.id} (rolled-back): Traycer uses ${journal.source.path}, which is not touched.`,
        `This PERMANENTLY DELETES the unused, rolled-back copy in ${journal.destination.path}. Files there that the move did not create, or that changed since, are kept.`,
      ],
      question: `Permanently delete the unused copy in ${journal.destination.path}?`,
    };
  }
  return null;
}
