import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  MigrationJournal,
  MigrationPhase,
  Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  DataRootError,
  resolveDataRoot,
} from "@traycer/protocol/config/data-root";
import { parseSetupDataRootInput } from "@traycer/protocol/config/data-root-setup-input";
import { CLI_ERROR_CODES, isErrnoException } from "../../runner/errors";
import type { MigrationEngineDeps } from "../engine/engine-deps";
import type { EngineProgress, EngineResult } from "../engine/engine-types";
import {
  inspectMigrationReadonly,
  presentImpact,
  resumeMigration,
  rollbackMigration,
  startMigration,
  type MigrationAdvisory,
} from "../engine/migration-engine";
import {
  dataRootOperationAvailable,
  unavailableMessage,
} from "./data-availability";
import {
  failed,
  ok,
  type DataCommandDeps,
  type DataCommandIo,
  type DataCommandOutcome,
} from "./data-command-types";
import {
  blockerLines,
  formatBytes,
  impactLines,
  nextStepLines,
  stoppedOutcome,
} from "./data-report";

/**
 * `traycer data migrate --to <folder> [--dry-run]`: move an existing
 * installation's data folder. The engine (`migration-engine.ts`) does all of
 * the work and all of the safety checks; this is the user's side of it.
 *
 * `--dry-run` is the engine's readonly advisory: it takes no lock and writes
 * nothing, and it cannot inspect stores or sessions (that needs an
 * authorized start), so a clean dry run is never a clearance.
 */

const PHASE_LABEL: Record<MigrationPhase, string> = {
  planned: "Checking Traycer's stores and sessions",
  quiescing:
    "Stopping Traycer hosts and waiting for every Traycer process to exit",
  copying: "Copying",
  repairing: "Updating the copied stores",
  "preparing-external": "Updating worktree links and login items",
  ready: "Checking the copy",
  switching: "Switching to the new folder",
  switched: "Final check",
  activated: "Re-enabling login items",
  cleaning: "Deleting the old folder",
  complete: "Done",
  "rollback-requested": "Putting everything back",
  "rolled-back": "Put back",
};

export function engineProgressReporter(
  io: DataCommandIo,
): (event: EngineProgress) => void {
  let lastCopyStep = -1;
  return (event) => {
    switch (event.kind) {
      case "phase":
        io.progress(
          event.phase,
          PHASE_LABEL[event.phase],
          `${PHASE_LABEL[event.phase]}...`,
        );
        return;
      case "copy": {
        const step =
          event.totalBytes === 0
            ? 10
            : Math.floor((event.bytes / event.totalBytes) * 10);
        if (step === lastCopyStep) return;
        lastCopyStep = step;
        const message = `Copied ${String(event.files)} of ${String(event.totalFiles)} files (${formatBytes(event.bytes)} of ${formatBytes(event.totalBytes)})`;
        io.progress("copying", message, `  ${message}`);
        return;
      }
      case "waiting-for-participants":
        io.note(
          `  Waiting for ${String(event.running)} Traycer process(es) to quit. Quit Traycer Desktop and finish any other traycer commands; the move stops if they are still running after about two minutes.`,
        );
        return;
      case "deferred-to-quiescence":
        io.note(
          `  ${String(event.running)} running Traycer process(es) will be stopped before copying.`,
        );
        return;
      case "maintenance":
      case "cleanup":
        return;
    }
  };
}

/** No data folder to move: nothing about the move itself applies. */
function sourceAbsent(advisory: MigrationAdvisory): boolean {
  return advisory.blockers.some((blocker) => blocker.code === "source-absent");
}

function advisoryLines(advisory: MigrationAdvisory): string[] {
  const lines = sourceAbsent(advisory)
    ? []
    : [
        `Space: the copy needs about ${formatBytes(advisory.requiredBytes)}; ${advisory.destinationFreeBytes === null ? "free space on the destination is unknown" : `${formatBytes(advisory.destinationFreeBytes)} free on the destination`}.`,
      ];
  if (advisory.blockers.length > 0)
    lines.push("Blockers:", ...blockerLines(advisory.blockers));
  return lines;
}

function whatMovesLines(sourceRoot: string, sourceBytes: number): string[] {
  return [
    `Moves: everything in ${sourceRoot} - sign-ins and credentials, chat and agent history, Traycer-managed provider accounts, managed worktrees (uncommitted changes included), downloaded hosts, models and runtimes.`,
    "Stays: the Traycer app, Desktop caches, the updater cache, system temp files, provider folders outside Traycer (such as ~/.claude) and ~/.traycer-bootstrap, which records the location.",
    "Before you continue, quit Traycer Desktop and finish any other traycer commands, and close shells or editors open in managed worktrees. The move stops Traycer hosts and their agents itself, then waits for every other Traycer process to exit.",
    `The old folder is kept unchanged as a backup (${formatBytes(sourceBytes)}) until you delete it with \`traycer data cleanup\`.`,
    "Old chat history and tool output can still show the old paths.",
  ];
}

export async function dataMigrate(
  deps: DataCommandDeps,
  input: {
    readonly to: string | null;
    readonly dryRun: boolean;
    readonly yes: boolean;
    readonly acceptSessionImpact: Sha256Digest | null;
  },
): Promise<DataCommandOutcome> {
  const selection = parseSetupDataRootInput({
    explicitTo: input.to,
    env: deps.env,
    platform: deps.platform,
  });
  if (selection.kind === "none") {
    return failed(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
      "choose the destination with --to <folder> (or set TRAYCER_DATA_DIR for this command)",
      null,
      [],
    );
  }
  const from = selection.source === "flag" ? "--to" : "TRAYCER_DATA_DIR";
  if (selection.kind === "invalid") {
    return failed(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
      `the folder from ${from} cannot be used: ${selection.reason}`,
      { requested: selection.requested, source: selection.source },
      [],
    );
  }
  let sourceRoot: string;
  try {
    sourceRoot = resolveDataRoot(deps.homeDir, deps.platform).root;
  } catch (error) {
    if (!(error instanceof DataRootError)) throw error;
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      `${error.message} Run \`traycer data status\`.`,
      { refusal: error.code },
      [],
    );
  }
  const header = [
    `Move Traycer's data`,
    `  from ${sourceRoot}`,
    `  to   ${selection.root} (from ${from})`,
  ];
  const available = dataRootOperationAvailable(
    deps.availability,
    deps.platform,
    "migrate",
  );
  if (!input.dryRun && !available) {
    return failed(
      CLI_ERROR_CODES.DATA_OPERATION_UNAVAILABLE,
      unavailableMessage("migrate"),
      { destination: selection.root },
      header,
    );
  }

  const engine = deps.engine({
    signal: deps.signal,
    progress: engineProgressReporter(deps.io),
  });
  const advisory = await inspectMigrationReadonly(engine, {
    destination: selection.root,
  });
  const summary = [...header, ...advisoryLines(advisory)];
  if (input.dryRun) {
    const text = sourceAbsent(advisory)
      ? [...summary, "This dry run changed nothing."]
      : [
          ...summary,
          ...whatMovesLines(advisory.sourceRoot, advisory.sourceBytes),
          "This dry run changed nothing. It cannot check Traycer's stores and sessions; that happens when the move starts, and the move can still stop then.",
        ];
    if (!available && !sourceAbsent(advisory))
      text.push(unavailableMessage("migrate"));
    const data = { advisory, available };
    return advisory.blockers.length === 0
      ? ok(data, text)
      : failed(
          CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
          "the move cannot start yet",
          data,
          text,
        );
  }
  if (advisory.blockers.length > 0) {
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      "the move cannot start yet",
      { advisory },
      summary,
    );
  }

  const plan = [
    ...summary,
    ...whatMovesLines(advisory.sourceRoot, advisory.sourceBytes),
  ];
  if (!input.yes) {
    if (!deps.io.interactive) {
      return failed(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
        "pass --yes to start the move",
        { advisory },
        plan,
      );
    }
    deps.io.note(plan.join("\n"));
    if (!(await deps.io.confirm("Start the move?"))) {
      return failed(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
        "nothing was changed",
        null,
        [],
      );
    }
  }
  // An ordinary interactive run reviews the impact report before Traycer
  // stops, whether or not it needs acceptance. `--yes`, `--json` and a run
  // without a terminal never prompt: they accept only the exact digest given.
  // A review the journal already records is not waived either way (engine).
  const prompt = deps.io.interactive && !input.yes;
  const result = await startMigration(engine, {
    destination: selection.root,
    acceptedSessionImpactDigest: input.acceptSessionImpact,
    reviewImpact: prompt,
  });
  return settleMigrationRun(deps, engine, result, { prompt, fromStart: true });
}

/**
 * Carry an engine run to a result the user can act on: present the impact
 * report and continue on acceptance (only when `prompt`), and phrase a stop
 * with the recovery actions valid in its phase. Shared by `migrate` and
 * `recover`.
 *
 * A stop in `planned` that this command started is rolled back, so the same
 * command can simply be run again; the report says what that left behind.
 */
export async function settleMigrationRun(
  deps: DataCommandDeps,
  engine: MigrationEngineDeps,
  first: EngineResult,
  options: { readonly prompt: boolean; readonly fromStart: boolean },
): Promise<DataCommandOutcome> {
  let result = first;
  for (;;) {
    if (result.kind === "done") return doneOutcome(result.journal);
    const journal = result.journal;
    if (result.reason === "acceptance-required" && result.impact !== null) {
      const presentation = presentImpact(result.impact);
      const lines = impactLines(presentation);
      if (options.prompt) {
        deps.io.note(lines.join("\n"));
        const question = presentation.requiresAcceptance
          ? "Continue the move with these session effects?"
          : "Continue the move?";
        if (await deps.io.confirm(question)) {
          result = await resumeMigration(engine, {
            acceptedSessionImpactDigest: presentation.digest,
            reviewImpact: options.prompt,
          });
          continue;
        }
      }
      const discard =
        options.fromStart && journal?.phase === "planned"
          ? await discardPlan(engine, journal)
          : null;
      const command =
        journal === null
          ? "traycer data migrate --to <folder> --yes"
          : discard?.discarded === true
            ? `traycer data migrate --to "${journal.destination.path}" --yes`
            : "traycer data recover --yes";
      return failed(
        CLI_ERROR_CODES.DATA_ACCEPTANCE_REQUIRED,
        options.prompt
          ? "the move was not continued"
          : `review the session effects, then run \`${command} --accept-session-impact ${presentation.digest}\``,
        {
          digest: presentation.digest,
          report: presentation.report,
          migrationId: journal?.id ?? null,
          phase:
            discard?.discarded === true
              ? "rolled-back"
              : (journal?.phase ?? null),
        },
        [
          ...(options.prompt ? [] : lines),
          `Session impact digest: ${presentation.digest}`,
          ...(discard !== null
            ? discard.lines
            : journal === null
              ? []
              : ["Next:", ...nextStepLines(journal)]),
        ],
      );
    }
    if (options.fromStart && journal?.phase === "planned") {
      const discard = await discardPlan(engine, journal);
      if (discard.discarded)
        return stoppedOutcome({ ...result, journal: null }, discard.lines);
    }
    return stoppedOutcome(result, []);
  }
}

/**
 * Whether `path` is there. Only proven absence is "absent": the path is gone
 * while its parent is still readable. An unreadable path or a missing drive
 * (whose paths also answer ENOENT) proves nothing either way: "unknown".
 */
export async function pathPresence(
  path: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") return "unknown";
  }
  try {
    await lstat(dirname(path));
    return "absent";
  } catch {
    return "unknown";
  }
}

/**
 * Roll back a plan this command started, and say exactly what is left: the
 * journal stays as a rolled-back record, and the destination folder the start
 * created is removed only while it is still that folder and empty.
 */
export async function discardPlan(
  engine: MigrationEngineDeps,
  journal: MigrationJournal,
): Promise<{ readonly discarded: boolean; readonly lines: readonly string[] }> {
  const rolledBack = await rollbackMigration(engine);
  if (rolledBack.kind !== "done") {
    return {
      discarded: false,
      lines: [
        "The planned move could not be rolled back:",
        ...blockerLines(rolledBack.blockers),
        "Next:",
        ...nextStepLines(journal),
      ],
    };
  }
  const presence = await pathPresence(journal.destination.path);
  const destination =
    presence === "present"
      ? "kept"
      : presence === "absent"
        ? "removed"
        : "unknown";
  return {
    discarded: true,
    lines: [
      `The planned move ${journal.id} was rolled back before Traycer was stopped or anything was copied; your data stays in ${journal.source.path}.`,
      destination === "removed"
        ? `The empty destination folder ${journal.destination.path} it had created was removed.`
        : destination === "kept"
          ? `The destination folder ${journal.destination.path} was kept (it is not empty or is no longer the folder this move created).`
          : `Traycer could not check whether the destination folder ${journal.destination.path} is still there.`,
      "Its record stays in ~/.traycer-bootstrap.",
    ],
  };
}

function doneOutcome(journal: MigrationJournal): DataCommandOutcome {
  const data = {
    migrationId: journal.id,
    phase: journal.phase,
    source: journal.source.path,
    destination: journal.destination.path,
  };
  if (journal.phase === "rolled-back" && journal.rollbackFromPhase === null) {
    return ok(data, [
      `The planned move ${journal.id} was rolled back before anything was copied; your data stays in ${journal.source.path}.`,
      `The destination folder ${journal.destination.path} was removed if it was still empty. Its record stays in ~/.traycer-bootstrap.`,
    ]);
  }
  if (journal.phase === "rolled-back") {
    return ok(data, [
      `Everything is back in ${journal.source.path}; Traycer can start again.`,
      ...(journal.copyManifest === null
        ? []
        : ["Next:", ...nextStepLines(journal)]),
    ]);
  }
  if (journal.phase === "cleaning") {
    return ok(data, [
      `Traycer uses ${journal.destination.path}. Deleting the old folder is unfinished.`,
      "Next:",
      ...nextStepLines(journal),
    ]);
  }
  const bytes =
    journal.copyManifest === null
      ? ""
      : ` (${formatBytes(journal.copyManifest.byteCount)})`;
  return ok(data, [
    `Done. Traycer now uses ${journal.destination.path}.`,
    `The old folder ${journal.source.path} is kept as a backup${bytes} and is no longer updated.`,
    "Do not start an older Traycer version: it would use the old folder and could repeat queued or scheduled work, sending messages or making changes a second time.",
    "After checking that Traycer works, permanently delete the backup:",
    `  traycer data cleanup ${journal.id}`,
  ]);
}
