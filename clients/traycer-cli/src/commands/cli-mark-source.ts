import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve } from "node:path";
import {
  type CliInstallManifest,
  type CliInstallSource,
  PACKAGE_MANAGER_CLI_SOURCES,
  readCliManifest,
  VALID_CLI_INSTALL_SOURCES,
  writeCliManifest,
} from "../manifest/cli-manifest";
import type { CommandFn, CommandResult } from "../runner/runner";
import { CLI_ERROR_CODES, cliError, isErrnoException } from "../runner/errors";
import { withCliLock } from "../store/cli-lock";
import {
  isInterpreterDistribution,
  stageWellKnownCliBinary,
  wellKnownCliBinaryPath,
  type WellKnownCliStageOutcome,
} from "../store/well-known-cli";
import { errorFromUnknown } from "../logger";

// `traycer cli mark-source` - internal, hidden command. Package-manager
// install hooks (Homebrew formula post_install, winget/Scoop post-install
// scripts, deb/rpm postinst) call this to record that the new binary is
// owned by the package manager so `traycer cli upgrade` routes to the
// right upgrade environment.
//
// User-facing rename of "manual" went into `cli re-anchor`. This
// command rejects `--source manual` to prevent the upgrade-lockout
// footgun documented on the user-facing wrapper: passing
// `--source homebrew` (or any PM source) on a manually-installed binary
// permanently disables `cli upgrade` since it routes through the wrong
// package manager.

// Allowed sources here are the PM hooks + the special `desktop` slot.
// `manual` is explicitly excluded - re-anchoring a manual install is the
// `cli re-anchor` command's job.
const PM_HOOK_SOURCE_VALUES: readonly CliInstallSource[] = [
  "desktop",
  ...PACKAGE_MANAGER_CLI_SOURCES,
];
const PM_HOOK_SOURCES: ReadonlySet<CliInstallSource> =
  new Set<CliInstallSource>(PM_HOOK_SOURCE_VALUES);

export interface CliMarkSourceArgs {
  readonly source: string;
  readonly binaryPath: string;
  readonly version: string;
}

export function buildCliMarkSourceCommand(args: CliMarkSourceArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const source = parsePmHookSource(args.source);
    ctx.runtime.logger.info("CLI mark-source command started", {
      environment: ctx.runtime.environment,
      isKnownSource: source !== null,
      hasBinaryPath: args.binaryPath.length > 0,
      hasVersion: args.version.length > 0,
    });
    if (args.source === "manual") {
      ctx.runtime.logger.warn("CLI mark-source rejected manual source", {
        environment: ctx.runtime.environment,
      });
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "cli mark-source: --source manual is not allowed here; this is the package-manager hook. " +
          "To re-anchor a manually installed CLI, run 'traycer cli re-anchor --binary-path <path> --installed-version <version>'.",
        details: { source: args.source },
        exitCode: 1,
      });
    }
    if (source === null) {
      ctx.runtime.logger.warn("CLI mark-source rejected invalid source", {
        environment: ctx.runtime.environment,
        isKnownSource: false,
      });
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: `cli mark-source: invalid source '${args.source}'; expected one of ${[...PM_HOOK_SOURCES].join(", ")}`,
        details: { source: args.source },
        exitCode: 1,
      });
    }
    return writeMarkSource({
      ctx,
      source: source,
      binaryPath: args.binaryPath,
      version: args.version,
      reason: "cli-mark-source",
    });
  };
}

function parsePmHookSource(value: string): CliInstallSource | null {
  for (const source of PM_HOOK_SOURCE_VALUES) {
    if (source === value) return source;
  }
  return null;
}

// Shared internal: validates the binary path + version and writes the
// manifest under the per-environment CLI lock. Used by both `cli mark-source`
// (PM hooks) and `cli re-anchor` (user-facing manual install).
export async function writeMarkSource(opts: {
  readonly ctx: import("../runner/runner").CommandContext;
  readonly source: CliInstallSource;
  readonly binaryPath: string;
  readonly version: string;
  readonly reason: "cli-mark-source" | "cli-re-anchor";
}): Promise<CommandResult> {
  opts.ctx.runtime.logger.info("CLI install source write started", {
    environment: opts.ctx.runtime.environment,
    reason: opts.reason,
    source: opts.source,
    hasBinaryPath: opts.binaryPath.length > 0,
    hasVersion: opts.version.length > 0,
  });
  if (!VALID_CLI_INSTALL_SOURCES.has(opts.source)) {
    opts.ctx.runtime.logger.warn(
      "CLI install source write rejected invalid source",
      {
        environment: opts.ctx.runtime.environment,
        reason: opts.reason,
        source: opts.source,
      },
    );
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `${opts.reason}: invalid source '${opts.source}'`,
      details: { source: opts.source },
      exitCode: 1,
    });
  }
  // Resolved against THIS process's cwd, exactly once, before anything is
  // checked or persisted. Package-manager hooks routinely invoke this with a
  // relative --binary-path from their install prefix; persisting that string
  // verbatim would hand every LATER consumer a path it re-resolves against
  // its own cwd - the manifest would name a different file (or none) per
  // process, and the slot machinery would silently repoint on whatever it
  // found there. The path validated below and the path written to the
  // manifest must be one absolute spelling.
  const binaryPath = resolve(opts.binaryPath);
  let binaryStat: Stats;
  try {
    binaryStat = await stat(binaryPath);
  } catch (err) {
    const error = errorFromUnknown(err);
    opts.ctx.runtime.logger.warn(
      "CLI install source write binary path missing",
      {
        environment: opts.ctx.runtime.environment,
        reason: opts.reason,
        errorName: error.name,
        errorCode: readErrorCode(err),
      },
    );
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `${opts.reason}: binary path does not exist: ${binaryPath}`,
      details: { binaryPath },
      exitCode: 1,
    });
  }
  if (!binaryStat.isFile()) {
    opts.ctx.runtime.logger.warn(
      "CLI install source write rejected non-file binary path",
      {
        environment: opts.ctx.runtime.environment,
        reason: opts.reason,
      },
    );
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `${opts.reason}: binary path is not a regular file: ${binaryPath}`,
      details: { binaryPath },
      exitCode: 1,
    });
  }
  if (opts.version.length === 0) {
    opts.ctx.runtime.logger.warn(
      "CLI install source write rejected empty version",
      {
        environment: opts.ctx.runtime.environment,
        reason: opts.reason,
      },
    );
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `${opts.reason}: --installed-version is required and must be non-empty`,
      details: { version: opts.version },
      exitCode: 1,
    });
  }
  return withCliLock(
    {
      environment: opts.ctx.runtime.environment,
      reason: opts.reason,
      waitMs: 10_000,
      pollIntervalMs: 100,
    },
    async () => {
      const previous = await readCliManifest(opts.ctx.runtime.environment);
      opts.ctx.runtime.logger.debug(
        "CLI install source write read previous manifest",
        {
          environment: opts.ctx.runtime.environment,
          reason: opts.reason,
          hadPreviousManifest: previous !== null,
          previousSource: previous?.source ?? null,
        },
      );
      const next: CliInstallManifest = {
        version: opts.version,
        installedAt: new Date().toISOString(),
        binaryPath,
        source: opts.source,
        // Mark-source / re-anchor is the moment the new binary IS the
        // live binary - no pending swap. Clear any prior pendingUpgrade
        // since the user explicitly re-anchored the install.
        pendingUpgrade: null,
      };
      await writeCliManifest(opts.ctx.runtime.environment, next);
      opts.ctx.runtime.logger.info("CLI install source manifest written", {
        environment: opts.ctx.runtime.environment,
        reason: opts.reason,
        source: opts.source,
        hasVersion: opts.version.length > 0,
        hadPreviousManifest: previous !== null,
      });
      // Anchor time is also when the well-known slot must start serving
      // this binary: the host daemon's own CLI discovery (doctor /
      // update / service status) reads ONLY `<cliInstallHomeDir>/bin/`,
      // never this manifest, so a brew/hand-placed install stays
      // invisible to it - "has no Traycer CLI installed" in the GUI -
      // until the slot is staged. Best-effort by design: the manifest
      // above is this command's primary contract, so a staging failure
      // is reported, not thrown.
      //
      // An INTERPRETER distribution is the exception and must be skipped,
      // not staged: copying npm's shebanged bundle here would leave the
      // host spawning a script that resolves `node` off the service
      // manager's PATH, and on Windows would put JavaScript behind
      // `traycer.exe`. Staging it is worse than leaving the slot empty -
      // the host would fail to execute a CLI it believes it has. The same
      // predicate gates the resolver, so the two writers cannot drift.
      const interpreterDistribution = isInterpreterDistribution(opts.source);
      // Whether a PREVIOUS distribution already put an executable in the
      // slot. It stays there: the host daemon and any service registered
      // against that path both launch from it, so deleting it to reflect
      // the new anchor would take a working machine down rather than
      // improve it. What changes is what we TELL the user - the note below
      // must not claim the service now runs through the interpreter when a
      // foreign executable is still what actually gets launched.
      const priorSlotExists =
        interpreterDistribution &&
        (await slotHasBinary(
          wellKnownCliBinaryPath(opts.ctx.runtime.environment),
        ));
      const wellKnown: WellKnownCliStageOutcome = interpreterDistribution
        ? {
            staged: "not-applicable",
            wellKnownPath: wellKnownCliBinaryPath(opts.ctx.runtime.environment),
          }
        : await stageWellKnownCliBinary({
            environment: opts.ctx.runtime.environment,
            binaryPath,
          });
      if (wellKnown.staged === "failed") {
        opts.ctx.runtime.logger.warn(
          "CLI install source well-known staging failed",
          {
            environment: opts.ctx.runtime.environment,
            reason: opts.reason,
            errorName: wellKnown.errorName,
            errorMessage: wellKnown.errorMessage,
          },
        );
      } else {
        opts.ctx.runtime.logger.info(
          "CLI install source well-known slot staged",
          {
            environment: opts.ctx.runtime.environment,
            reason: opts.reason,
            staged: wellKnown.staged,
          },
        );
      }
      const anchoredLine = `marked CLI as ${opts.source}-owned at ${binaryPath} (version ${opts.version})`;
      return {
        data: {
          previous,
          current: next,
          wellKnown,
        },
        human: opts.ctx.runtime.json
          ? null
          : wellKnown.staged === "failed"
            ? `${anchoredLine}\nwarning: could not stage ${wellKnown.wellKnownPath} (${wellKnown.errorMessage}); the host daemon resolves the CLI only at that path, so host-driven doctor/update will not see this install until it is staged`
            : wellKnown.staged === "not-applicable"
              ? `${anchoredLine}\n${interpreterSlotNote(wellKnown.wellKnownPath, priorSlotExists)}`
              : anchoredLine,
        exitCode: 0,
      };
    },
  );
}

function readErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

// Human note for an interpreter distribution, which owns no slot. The two
// states are materially different for the reader and must not be conflated:
// with no slot the host simply cannot see this install, while a slot left
// over from a previous executable install keeps being launched by both the
// host daemon and any service registered against it - so the machine is
// running a DIFFERENT CLI than the manifest now names.
function interpreterSlotNote(
  wellKnownPath: string,
  priorSlotExists: boolean,
): string {
  if (!priorSlotExists) {
    return `note: this distribution ships a script rather than an executable, so ${wellKnownPath} is left alone; the service runs the CLI through its interpreter, but host-driven doctor/update will not see this install`;
  }
  return `warning: this distribution ships a script rather than an executable, so ${wellKnownPath} still holds the previously anchored executable; the host daemon and any already-registered service keep launching THAT binary, not this one. Re-register the service ('traycer host service install') to point it at this install, or remove ${wellKnownPath} once nothing depends on it`;
}

// Only a CONFIRMED absence may answer "no prior slot". The two messages this
// feeds differ in what they warn about: the absent-slot note says the service
// runs through the interpreter, the present-slot warning says a foreign
// executable is still what gets launched. An EACCES or EIO here is not
// evidence of absence, and picking the softer note on a fault would tell the
// user the safe thing precisely when nothing is known - so anything except
// ENOENT reads as "assume it exists" and selects the cautious warning.
async function slotHasBinary(wellKnownPath: string): Promise<boolean> {
  try {
    await stat(wellKnownPath);
    return true;
  } catch (err) {
    return !(isErrnoException(err) && err.code === "ENOENT");
  }
}
