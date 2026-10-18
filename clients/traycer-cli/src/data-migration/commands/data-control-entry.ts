import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError } from "commander";
import { clientProcessIncarnationProbe } from "@traycer-clients/shared/host-lock/data-migration-admission";
import {
  sha256DigestSchema,
  type Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";
import { dataRootPlatformOf } from "@traycer/protocol/config/data-root";
import { resolveAgentCliSurface } from "../../agent-surface";
import { CLI_ERROR_CODES, type CliErrorCode } from "../../runner/errors";
import { finishAndExit } from "../../runner/exit";
import type {
  ProgressEvent,
  ResultErrorEvent,
  ResultOkEvent,
} from "../../runner/output";
import {
  installStdioErrorGuards,
  writeStderr,
  writeStdout,
} from "../../runner/std-write";
import { productionMigrationEngineDeps } from "../engine/engine-deps";
import { DATA_ROOT_AVAILABILITY } from "./data-availability";
import { dataCleanup } from "./data-cleanup";
import {
  failed,
  type DataCommandDeps,
  type DataCommandIo,
  type DataCommandOutcome,
} from "./data-command-types";
import { dataInit } from "./data-init";
import { dataMigrate } from "./data-migrate";
import { dataRecover } from "./data-recover";
import { dataStatus } from "./data-status";

/**
 * The control entry for `traycer data ...`, taken INSTEAD of the ordinary CLI
 * entry, before it does anything.
 *
 * The ordinary entry registers the invocation with the data-migration startup
 * barrier, opens the CLI log under the data folder and refreshes the CLI slot
 * there before Commander runs. None of that may happen here:
 * - `data status`, `data recover` and `--help` must answer while a migration
 *   holds the barrier and when the location record is unusable - the
 *   ordinary logger alone already derives its path from that record;
 * - the coordinator (`migrate`, `recover`, `cleanup`) must not be an admitted
 *   participant, which the barrier would wait for, nor write into the folder
 *   it is moving (`engine/caller-preconditions.ts`).
 *
 * So this path writes only to stdout and stderr, and every write a data
 * command makes is the engine's (or `data init`'s) own, under the migration
 * coordinator lock. It is not a bypass for anything else: only argv whose
 * command is `data` arrives here, and this program knows only the `data`
 * subcommands - anything else under `data` is a parse error, never handed to
 * the ordinary program.
 */

/** Flags a person may put before `data` that the ordinary program would also accept as no-ops. */
const LEADING_FLAGS = new Set(["--json", "--quiet", "--no-progress"]);

export function selectsDataControlCommand(argv: readonly string[]): boolean {
  for (const token of argv.slice(2)) {
    if (LEADING_FLAGS.has(token)) continue;
    return token === "data";
  }
  return false;
}

function argvHas(argv: readonly string[], flag: string): boolean {
  for (const token of argv.slice(2)) {
    if (token === "--") return false;
    if (token === flag) return true;
  }
  return false;
}

function envFlag(value: string | undefined): boolean {
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
}

export function processDataCommandIo(argv: readonly string[]): DataCommandIo {
  const json = argvHas(argv, "--json");
  const noProgress = argvHas(argv, "--no-progress");
  const nonInteractive =
    envFlag(process.env.CI) || envFlag(process.env.TRAYCER_NONINTERACTIVE);
  return {
    json,
    interactive: !json && !nonInteractive && process.stdin.isTTY === true,
    note: (text) => {
      if (!json) writeStderr(`${text}\n`);
    },
    progress: (stage, message, line) => {
      if (noProgress) return;
      if (!json) {
        writeStderr(`${line}\n`);
        return;
      }
      const event: ProgressEvent = {
        type: "progress",
        stage,
        percent: null,
        bytes: null,
        totalBytes: null,
        message,
        workUnits: null,
        timestamp: new Date().toISOString(),
      };
      writeStdout(`${JSON.stringify(event)}\n`);
    },
    confirm: async (question) => {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      // Ctrl+C or a closed stdin at the prompt is declining, not a failure.
      const answer = await prompt
        .question(`${question} [y/N] `)
        .catch(() => "")
        .finally(() => prompt.close());
      return /^y(es)?$/i.test(answer.trim());
    },
  };
}

export function productionDataCommandDeps(
  io: DataCommandIo,
  signal: AbortSignal,
): DataCommandDeps {
  return {
    homeDir: homedir(),
    platform: dataRootPlatformOf(process.platform),
    env: process.env,
    availability: DATA_ROOT_AVAILABILITY,
    probe: clientProcessIncarnationProbe,
    engine: (input) => productionMigrationEngineDeps(input),
    signal,
    io,
  };
}

function digestOption(value: unknown): Sha256Digest | null | "invalid" {
  if (typeof value !== "string") return null;
  const parsed = sha256DigestSchema.safeParse(value);
  return parsed.success ? parsed.data : "invalid";
}

const READONLY_REFUSAL =
  "this session can read Traycer's data location but cannot change it - run this from your own terminal.";

/**
 * The `data` program. Each action stores its outcome in `settle`; the caller
 * renders it. Under `--json`, what Commander would print on stdout (help)
 * goes to `bufferJsonOut` instead, for the caller to wrap in one result
 * envelope. Exported for fixtures, which drive it with their own deps.
 */
export function buildDataProgram(
  deps: DataCommandDeps,
  settle: (outcome: DataCommandOutcome) => void,
  bufferJsonOut: (text: string) => void,
): Command {
  const program = new Command("traycer")
    .option("--json", "Emit NDJSON on stdout instead of text")
    .option(
      "--quiet",
      "Accepted for consistency; data commands print only what matters",
    )
    .option("--no-progress", "Suppress progress events / progress lines")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        if (deps.io.json) bufferJsonOut(text);
        else writeStdout(text);
      },
      writeErr: (text) => {
        if (!deps.io.json) writeStderr(text);
      },
    });
  const readonly = resolveAgentCliSurface(process.env) === "readonly";
  // A read-only agent session may look, never change (the CLI-019 rail the
  // ordinary program applies through READONLY_REFUSED_COMMANDS).
  const mutating = async (
    run: () => Promise<DataCommandOutcome>,
  ): Promise<void> => {
    settle(
      readonly
        ? failed(CLI_ERROR_CODES.FORBIDDEN, READONLY_REFUSAL, null, [])
        : await run(),
    );
  };
  const data = program
    .command("data")
    .description(
      "Where Traycer keeps its data: show it, choose it for a new installation, move it, recover an interrupted move, and delete the copy a move no longer uses",
    );
  const leaf = (cmd: Command): Command => {
    cmd.exitOverride();
    cmd.option("--json", "Emit NDJSON on stdout instead of text");
    return cmd;
  };

  leaf(
    data
      .command("status")
      .description(
        "Show the data folder, whether Traycer can start, and any migration with what to do next",
      ),
  ).action(async () => {
    settle(await dataStatus(deps));
  });

  leaf(
    data
      .command("init")
      .description(
        "Choose the data folder for a NEW installation (an existing one is moved with `data migrate`)",
      )
      .option(
        "--to <folder>",
        "The new data folder (default: TRAYCER_DATA_DIR, read only by this command)",
      )
      .option("--yes", "Do not ask for confirmation"),
  ).action(async (opts: Record<string, unknown>) => {
    await mutating(() =>
      dataInit(deps, {
        to: typeof opts.to === "string" ? opts.to : null,
        yes: opts.yes === true,
      }),
    );
  });

  leaf(
    data
      .command("migrate")
      .description(
        "Move the data folder of this installation to another folder",
      )
      .option(
        "--to <folder>",
        "The destination folder (default: TRAYCER_DATA_DIR, read only by this command)",
      )
      .option(
        "--dry-run",
        "Show what a move involves without changing anything",
      )
      .option("--yes", "Do not ask for confirmation")
      .option(
        "--accept-session-impact <digest>",
        "Accept exactly the reported session impact (the digest it printed)",
      ),
  ).action(async (opts: Record<string, unknown>) => {
    const accept = digestOption(opts.acceptSessionImpact);
    if (accept === "invalid") {
      settle(
        failed(
          CLI_ERROR_CODES.INVALID_ARGUMENT,
          "--accept-session-impact takes the sha256:... digest the report printed",
          null,
          [],
        ),
      );
      return;
    }
    const input = {
      to: typeof opts.to === "string" ? opts.to : null,
      dryRun: opts.dryRun === true,
      yes: opts.yes === true,
      acceptSessionImpact: accept,
    };
    if (input.dryRun) settle(await dataMigrate(deps, input));
    else await mutating(() => dataMigrate(deps, input));
  });

  leaf(
    data
      .command("recover")
      .description(
        "Continue an interrupted move, or with --rollback put everything back (only before the move took effect)",
      )
      .option(
        "--rollback",
        "Put everything back in the old folder instead of continuing",
      )
      .option(
        "--restore-record",
        "Restore the last good revision of a damaged migration record",
      )
      .option("--yes", "Do not ask for confirmation")
      .option(
        "--accept-session-impact <digest>",
        "Accept exactly the reported session impact (the digest it printed)",
      ),
  ).action(async (opts: Record<string, unknown>) => {
    const accept = digestOption(opts.acceptSessionImpact);
    if (accept === "invalid") {
      settle(
        failed(
          CLI_ERROR_CODES.INVALID_ARGUMENT,
          "--accept-session-impact takes the sha256:... digest the report printed",
          null,
          [],
        ),
      );
      return;
    }
    await mutating(() =>
      dataRecover(deps, {
        rollback: opts.rollback === true,
        restoreRecord: opts.restoreRecord === true,
        yes: opts.yes === true,
        acceptSessionImpact: accept,
      }),
    );
  });

  leaf(
    data
      .command("cleanup")
      .description(
        "Permanently delete the copy a migration no longer uses: the old folder after a move, or the unused copy after a rollback",
      )
      .argument(
        "<migration-id>",
        "The migration, as `traycer data status` shows it",
      )
      .option("--yes", "Do not ask for confirmation"),
  ).action(async (migrationId: string, opts: Record<string, unknown>) => {
    await mutating(() =>
      dataCleanup(deps, { migrationId, yes: opts.yes === true }),
    );
  });
  return program;
}

function render(outcome: DataCommandOutcome, json: boolean): void {
  const timestamp = new Date().toISOString();
  if (outcome.status === "ok") {
    if (json) {
      const event: ResultOkEvent = {
        type: "result",
        status: "ok",
        data: outcome.data,
        timestamp,
      };
      writeStdout(`${JSON.stringify(event)}\n`);
    } else if (outcome.text.length > 0) {
      writeStdout(`${outcome.text.join("\n")}\n`);
    }
    return;
  }
  if (json) {
    const event: ResultErrorEvent = {
      type: "result",
      status: "error",
      error: {
        code: outcome.code,
        message: outcome.message,
        details: outcome.details,
      },
      timestamp,
    };
    writeStdout(`${JSON.stringify(event)}\n`);
    return;
  }
  const context = outcome.text.length > 0 ? `${outcome.text.join("\n")}\n` : "";
  writeStderr(`${context}traycer: ${outcome.message} [code=${outcome.code}]\n`);
}

function renderError(code: CliErrorCode, message: string, json: boolean): void {
  render(failed(code, message, null, []), json);
}

/**
 * Run one `traycer data ...` invocation and exit. Ctrl+C asks the engine to
 * stop at its next safe point; the journal keeps the phase, so
 * `traycer data recover` continues or rolls back from there.
 */
/** How long an aborted command may take to reach a safe point after an unexpected failure. */
const FATAL_SETTLE_CEILING_MS = 5 * 60_000;

export async function runDataControlEntry(
  argv: readonly string[],
): Promise<void> {
  // As in the ordinary entry: a reader that closed the pipe (`| head -1`) is
  // not a failure, and must not reach `onFatal` and stop a running move.
  installStdioErrorGuards();
  const io = processDataCommandIo(argv);
  const abort = new AbortController();
  const state: {
    inFlight: boolean;
    fatal: boolean;
    outcome: DataCommandOutcome | null;
  } = {
    inFlight: false,
    fatal: false,
    outcome: null,
  };
  // An unexpected failure must not end the process under a running engine
  // step: it asks the engine to stop at its next safe point and lets the
  // command settle. Ending it anyway would still be safe (the journal makes a
  // crash recoverable) but would leave the user with no explanation.
  const onFatal = (cause: unknown): void => {
    if (state.fatal) return;
    state.fatal = true;
    abort.abort();
    renderError(
      CLI_ERROR_CODES.UNEXPECTED,
      `unexpected failure (${cause instanceof Error ? cause.message : String(cause)}); run \`traycer data status\``,
      io.json,
    );
    if (!state.inFlight) {
      void finishAndExit(1);
      return;
    }
    // Bounded: the engine stops at its next safe point and its child
    // processes carry their own timeouts and the abort signal; this backstop
    // ends a command that never settles. Ending it is a crash the journal
    // already makes recoverable.
    setTimeout(() => {
      void finishAndExit(1);
    }, FATAL_SETTLE_CEILING_MS).unref();
  };
  process.on("unhandledRejection", onFatal);
  process.on("uncaughtException", onFatal);
  const onInterrupt = (): void => {
    if (abort.signal.aborted) return;
    io.note(
      "Stopping at the next safe point; `traycer data recover` continues or rolls back from there.",
    );
    abort.abort();
  };
  process.on("SIGINT", onInterrupt);
  let jsonOut = "";
  const program = buildDataProgram(
    productionDataCommandDeps(io, abort.signal),
    (outcome) => {
      state.outcome = outcome;
    },
    (text) => {
      jsonOut += text;
    },
  );
  let exitCode = 0;
  state.inFlight = true;
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help exits 0: printed in human mode, buffered under --json and
      // wrapped in one result here, as the ordinary entry does. A parse
      // failure already printed its message in human mode.
      if (error.exitCode === 0 && io.json) {
        const event: ResultOkEvent = {
          type: "result",
          status: "ok",
          data: { output: jsonOut.trimEnd() },
          timestamp: new Date().toISOString(),
        };
        writeStdout(`${JSON.stringify(event)}\n`);
      } else if (error.exitCode !== 0 && io.json) {
        renderError(
          CLI_ERROR_CODES.INVALID_ARGUMENT,
          error.message.replace(/^error:\s*/i, ""),
          true,
        );
      }
      exitCode = error.exitCode;
    } else {
      onFatal(error);
    }
  } finally {
    state.inFlight = false;
    process.off("SIGINT", onInterrupt);
  }
  if (state.fatal) {
    await finishAndExit(1);
    return;
  }
  if (state.outcome !== null) {
    render(state.outcome, io.json);
    exitCode = state.outcome.status === "ok" ? 0 : 1;
  }
  await finishAndExit(exitCode);
}
