import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  type CliInstallManifest,
  type CliInstallSource,
  PACKAGE_MANAGER_CLI_SOURCES,
  readCliManifest,
  VALID_CLI_INSTALL_SOURCES,
  writeCliManifest,
} from "../manifest/cli-manifest";
import type { CommandFn, CommandResult } from "../runner/runner";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { withCliLock } from "../store/cli-lock";
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

export function buildCliMarkSourceCommand(
  args: CliMarkSourceArgs,
): CommandFn {
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
    opts.ctx.runtime.logger.warn("CLI install source write rejected invalid source", {
      environment: opts.ctx.runtime.environment,
      reason: opts.reason,
      source: opts.source,
    });
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `${opts.reason}: invalid source '${opts.source}'`,
      details: { source: opts.source },
      exitCode: 1,
    });
  }
  let binaryStat: Stats;
  try {
    binaryStat = await stat(opts.binaryPath);
  } catch (err) {
    const error = errorFromUnknown(err);
    opts.ctx.runtime.logger.warn("CLI install source write binary path missing", {
      environment: opts.ctx.runtime.environment,
      reason: opts.reason,
      errorName: error.name,
      errorCode: readErrorCode(err),
    });
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `${opts.reason}: binary path does not exist: ${opts.binaryPath}`,
      details: { binaryPath: opts.binaryPath },
      exitCode: 1,
    });
  }
  if (!binaryStat.isFile()) {
    opts.ctx.runtime.logger.warn("CLI install source write rejected non-file binary path", {
      environment: opts.ctx.runtime.environment,
      reason: opts.reason,
    });
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `${opts.reason}: binary path is not a regular file: ${opts.binaryPath}`,
      details: { binaryPath: opts.binaryPath },
      exitCode: 1,
    });
  }
  if (opts.version.length === 0) {
    opts.ctx.runtime.logger.warn("CLI install source write rejected empty version", {
      environment: opts.ctx.runtime.environment,
      reason: opts.reason,
    });
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
      opts.ctx.runtime.logger.debug("CLI install source write read previous manifest", {
        environment: opts.ctx.runtime.environment,
        reason: opts.reason,
        hadPreviousManifest: previous !== null,
        previousSource: previous?.source ?? null,
      });
      const next: CliInstallManifest = {
        version: opts.version,
        installedAt: new Date().toISOString(),
        binaryPath: opts.binaryPath,
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
      return {
        data: {
          previous,
          current: next,
        },
        human: opts.ctx.runtime.json
          ? null
          : `marked CLI as ${opts.source}-owned at ${opts.binaryPath} (version ${opts.version})`,
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
