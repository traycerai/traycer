import { lstat, readdir, rmdir } from "node:fs/promises";
import {
  acquireMigrationCoordinatorLock,
  MigrationAdmissionError,
  surveyAdmittedProcesses,
  withAdmissionMutex,
} from "@traycer/protocol/config/data-migration-admission";
import {
  BootstrapRecordError,
  initializeLocationRecord,
  listMigrationJournalIdsSync,
  readMigrationSelectorSync,
} from "@traycer/protocol/config/data-bootstrap-records";
import {
  DataRootError,
  dataBootstrapDir,
  defaultDataRoot,
  resolveDataRoot,
} from "@traycer/protocol/config/data-root";
import { parseSetupDataRootInput } from "@traycer/protocol/config/data-root-setup-input";
import { CLI_ERROR_CODES, isErrnoException } from "../../runner/errors";
import { coordinatorLockRefusalMessage } from "../engine/coordinator-lock";
import {
  dataRootOperationAvailable,
  unavailableMessage,
} from "./data-availability";
import {
  failed,
  ok,
  type DataCommandDeps,
  type DataCommandOutcome,
} from "./data-command-types";

/**
 * `traycer data init --to <folder>`: choose where a NEW installation keeps its
 * data, before anything has been installed.
 *
 * The folder comes from `--to`, or else the setup-only `TRAYCER_DATA_DIR`
 * (`parseSetupDataRootInput`); it is shown before anything is written. Init
 * never moves or replaces anything: it refuses when a location is already
 * chosen (or unreadable), when any migration history exists, when the
 * default folder already holds an installation (moving one is
 * `traycer data migrate`), and while any Traycer process is admitted.
 *
 * The decisive checks run again under the coordinator lock and the admission
 * mutex, the same serialization every Traycer start checks the barrier under,
 * so no process can start on the default folder between the check and the
 * write. A process that resolved the default folder before the write is
 * refused at admission (`location-changed`).
 */
export async function dataInit(
  deps: DataCommandDeps,
  input: { readonly to: string | null; readonly yes: boolean },
): Promise<DataCommandOutcome> {
  const selection = parseSetupDataRootInput({
    explicitTo: input.to,
    env: deps.env,
    platform: deps.platform,
  });
  if (selection.kind === "none") {
    return failed(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
      "choose the data folder with --to <folder> (or set TRAYCER_DATA_DIR for this command)",
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
  const text = [`New data folder: ${selection.root} (from ${from})`];
  const details = { root: selection.root, source: selection.source };
  if (!dataRootOperationAvailable(deps.availability, deps.platform, "init")) {
    return failed(
      CLI_ERROR_CODES.DATA_OPERATION_UNAVAILABLE,
      unavailableMessage("init"),
      details,
      text,
    );
  }
  const refusal = await existingInstallation(deps);
  if (refusal !== null)
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      refusal,
      details,
      text,
    );

  if (!input.yes) {
    if (!deps.io.interactive) {
      return failed(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
        "pass --yes to confirm the new data folder",
        details,
        text,
      );
    }
    deps.io.note(text.join("\n"));
    if (!(await deps.io.confirm(`Keep Traycer's data in ${selection.root}?`))) {
      return failed(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
        "nothing was changed",
        details,
        [],
      );
    }
  }

  const engine = deps.engine({
    signal: deps.signal,
    progress: () => undefined,
  });
  const bootstrapDir = dataBootstrapDir(deps.homeDir);
  const acquired = await acquireMigrationCoordinatorLock({
    bootstrapDir,
    probe: deps.probe,
  });
  if (!acquired.acquired) {
    return failed(
      CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
      coordinatorLockRefusalMessage(acquired.reason),
      { ...details, lock: acquired.reason },
      text,
    );
  }
  try {
    const secured = await engine.secureBootstrap(bootstrapDir);
    if (!secured.ok) {
      return failed(
        CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
        secured.reason,
        { ...details, refusal: secured.code },
        text,
      );
    }
    return await withAdmissionMutex({
      bootstrapDir,
      probe: deps.probe,
      waitMs: 10_000,
      fn: async (): Promise<DataCommandOutcome> => {
        const late = await existingInstallation(deps);
        if (late !== null)
          return failed(
            CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
            late,
            details,
            text,
          );
        const prepared = await engine.destination.prepare({
          requested: selection.root,
          protectedRoots: [defaultDataRoot(deps.homeDir), bootstrapDir],
        });
        if (!prepared.ok) {
          return failed(
            CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
            prepared.reason,
            { ...details, refusal: prepared.code },
            text,
          );
        }
        try {
          await initializeLocationRecord({
            bootstrapDir,
            held: acquired.lock,
            platform: deps.platform,
            root: prepared.root,
          });
        } catch (error) {
          // Leave nothing behind but what this command made and left empty.
          if (prepared.created) await removeIfEmpty(prepared.root);
          throw error;
        }
        return ok(
          {
            root: prepared.root,
            source: selection.source,
            created: prepared.created,
          },
          [
            ...text,
            `Traycer will keep its data in ${prepared.root}. Start Traycer to finish setting up.`,
            "The Traycer app itself, Desktop caches, the updater cache, system temp files and provider folders outside Traycer (such as ~/.claude) stay where they are.",
          ],
        );
      },
    });
  } catch (error) {
    if (
      error instanceof MigrationAdmissionError ||
      error instanceof BootstrapRecordError
    ) {
      return failed(
        CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
        error.message,
        { ...details, refusal: error.code },
        text,
      );
    }
    throw error;
  } finally {
    await acquired.lock.release();
  }
}

/** Why this machine already has an installation (or cannot be proven not to), else null. */
async function existingInstallation(
  deps: DataCommandDeps,
): Promise<string | null> {
  try {
    const resolution = resolveDataRoot(deps.homeDir, deps.platform);
    if (resolution.kind === "configured") {
      return `Traycer's data folder is already set to ${resolution.root}. To move it, use \`traycer data migrate --to <folder>\`.`;
    }
  } catch (error) {
    if (error instanceof DataRootError) {
      return `${error.message} Run \`traycer data status\`.`;
    }
    throw error;
  }
  const bootstrapDir = dataBootstrapDir(deps.homeDir);
  if (
    readMigrationSelectorSync(bootstrapDir).kind !== "absent" ||
    listMigrationJournalIdsSync(bootstrapDir).length > 0
  ) {
    return "this machine has Traycer data migration history; use `traycer data migrate` to change the data folder";
  }
  const defaultRoot = defaultDataRoot(deps.homeDir);
  if (await populated(defaultRoot)) {
    return `Traycer is already installed in ${defaultRoot}. To move it, use \`traycer data migrate --to <folder>\`.`;
  }
  const survey = await surveyAdmittedProcesses({
    bootstrapDir,
    probe: deps.probe,
    reap: false,
  });
  if (
    survey.processes.some(
      (report) => report.state !== "exited" && report.state !== "recycled",
    )
  ) {
    return "Traycer is running; quit Traycer (Desktop, hosts and CLI commands) and run this again";
  }
  return null;
}

async function populated(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return true;
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    // Unreadable is not proof of absence.
    return true;
  }
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length === 0) await rmdir(path);
  } catch {
    // Best effort: an empty private folder left behind is harmless.
  }
}
