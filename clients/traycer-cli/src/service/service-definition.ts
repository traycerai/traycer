import { randomUUID } from "node:crypto";
import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renameWithWindowsRetry } from "@traycer/protocol/config/credentials-fs";
import { CLI_ERROR_CODES, cliError, type CliError } from "../runner/errors";
import type { CliInvocation } from "./cli-binary";
import { verifyServiceMutationAuthority } from "./mutation-authority";

// The registered service definition, read back and brought to the current
// launcher form WITHOUT registering, starting, stopping or restarting
// anything (`traycer host service refresh`, and the lifecycle mode change
// that runs it - see `refreshOnModeChange` in the protocol's
// host-lifecycle-policy).
//
// Why it exists: only a LABELLED service start can be parked by a
// non-Background lifecycle mode, and a definition written by a CLI that
// predates labelled starts launches `<cli> host start` unlabelled, which the
// policy can never park (`lifecycle-admission.ts`). Nothing else rewrites a
// definition while a host is running: every re-registration either stops the
// host first or needs a new supervisor to acknowledge its spawn.
//
// Platform-neutral pieces live here; each platform's read-back, predicate and
// write live beside its installer, because "current" is defined as exactly
// what that installer's own builders emit.

/** Where the refreshed definition first takes effect. */
export type ServiceDefinitionAppliesAt =
  // The next start of the service, including a service-manager restart of a
  // crashed host (systemd `Restart=`, launchd re-executing the launcher
  // file, a Scheduled Task run).
  | "next-start"
  // The next login only. launchd keeps running the definition it LOADED
  // until the job is unloaded, so an in-session respawn still uses the old
  // `ProgramArguments`; only the next login loads the rewritten plist.
  | "next-login";

/** Which older definition form was found (diagnostic, never branched on by callers). */
export type ServiceDefinitionForm =
  /** `/bin/sh -c <script> <cli...>` whose script or unit text is not current. */
  | "inline-script"
  /** `<cli...> host start [--service-label <label>]`, no launcher at all. */
  | "direct"
  /** macOS launcher-file plist whose launcher file is not current. */
  | "launcher-file"
  /** Windows `wscript <vbs>` task whose launcher script is not current. */
  | "launcher-vbs"
  /** Windows task whose action is not the current `wscript` launcher. */
  | "direct-action";

/**
 * The read-back verdict. `unrecognized` is a registration under this
 * service's own name that no Traycer emitter wrote - it is left alone, and
 * the remedy is a full re-registration.
 */
export type ServiceDefinitionState =
  | { readonly kind: "not-registered" }
  | { readonly kind: "current" }
  | {
      readonly kind: "stale";
      readonly form: ServiceDefinitionForm;
      readonly appliesAt: ServiceDefinitionAppliesAt;
    }
  | { readonly kind: "unrecognized"; readonly reason: string };

/** What a refresh did. A failure throws `SERVICE_DEFINITION_REFRESH_FAILED`. */
export type ServiceDefinitionRefresh =
  | { readonly kind: "not-registered" }
  | { readonly kind: "current" }
  | {
      readonly kind: "refreshed";
      readonly form: ServiceDefinitionForm;
      readonly appliesAt: ServiceDefinitionAppliesAt;
    };

export const SERVICE_REFRESH_COMMAND = "traycer host service refresh";
export const SERVICE_REINSTALL_COMMAND = "traycer host service install";

/**
 * The refresh failed. `remedy` is the command that repairs what is left:
 * a retry of the refresh, or a full re-registration (which restarts the
 * host) when the definition could not be read as Traycer's at all.
 */
export function serviceDefinitionRefreshFailed(input: {
  readonly subject: string;
  readonly reason: string;
  readonly remedy: string;
}): CliError {
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_DEFINITION_REFRESH_FAILED,
    message: `could not bring ${input.subject} to the current launcher form: ${input.reason}. Nothing was started or stopped. Run '${input.remedy}' to repair it.`,
    details: {
      subject: input.subject,
      reason: input.reason,
      remedy: input.remedy,
    },
    exitCode: 1,
  });
}

/**
 * The CLI invocation of a launcher-less `<cli...> host start` vector, or
 * `null`. Accepts the trailing `--service-label <label>` only for THIS
 * service's own label: that shape was never emitted, but a hand-edited
 * definition naming another label is not this service's to rewrite.
 */
export function directHostStartInvocation(
  argv: readonly string[],
  labelId: string,
): CliInvocation | null {
  const labelled =
    argv.length >= 5 &&
    argv[argv.length - 2] === "--service-label" &&
    argv[argv.length - 1] === labelId;
  const end = labelled ? argv.length - 2 : argv.length;
  if (end < 3) return null;
  if (argv[end - 2] !== "host" || argv[end - 1] !== "start") return null;
  const command = argv[0];
  if (command === undefined || command.length === 0) return null;
  return { command, args: argv.slice(1, end - 2) };
}

/**
 * The permission bits of the file a refresh is about to replace, so the
 * replacement keeps them: a rename installs a NEW inode, which would
 * otherwise take the writer's umask - and launchd refuses a group-writable
 * plist. `null` when the file cannot be stat'ed (the write then gets the
 * default a fresh `writeFile` gets, as the installer's own write does).
 */
export async function existingFileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o7777;
  } catch {
    return null;
  }
}

/**
 * Replace `path` with `data` atomically: a temp file beside it, then a
 * rename, so the service manager (or a login racing this write) reads the
 * old definition or the new one and never a torn one. The temp name starts
 * with `.` and ends in `.tmp`, a name no service manager loads.
 *
 * `mode` is applied to the temp file before the rename (`writeFile`'s own
 * `mode` only applies on create, and umask narrows it); `null` keeps the
 * default a fresh `writeFile` gets, which is what the installer writes.
 */
export async function replaceDefinitionFile(
  path: string,
  data: string | Buffer,
  mode: number | null,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  await verifyServiceMutationAuthority();
  try {
    await writeFile(temporary, data);
    if (mode !== null) await chmod(temporary, mode);
    await verifyServiceMutationAuthority();
    await renameWithWindowsRetry(temporary, path, 0);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}
