import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import {
  CLI_INVOCATION_LIFECYCLE_FILENAME,
  CLI_INVOCATION_RECORD_FILENAME,
  CLI_INVOCATION_RECORD_MAX_ARGS,
  CLI_INVOCATION_RECORD_MAX_ARG_LENGTH,
  CLI_INVOCATION_RECORD_MAX_SERIALIZED_BYTES,
  CLI_INVOCATION_RECORD_SCHEMA_VERSION,
  CLI_INVOCATION_RECORD_STALE_FILENAME,
  CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX,
  CLI_INVOCATION_RECORD_TXN_FILENAME,
  cliInvocationLifecyclePath,
  cliInvocationRecordOwnedStagingBasename,
  cliInvocationRecordOwnedStagingPath,
  cliInvocationRecordOwnedTransactionBasename,
  cliInvocationRecordOwnedTransactionPath,
  cliInvocationRecordPath,
  cliInvocationRecordPlatformFor,
  cliInvocationRecordStaleMarkerPath,
  cliInvocationStaleMarkerRemovableBy,
  cliInvocationStateDir,
  cliInvocationStateDirIdentitiesMatch,
  cliInvocationTransactionAbandonedByAge,
  cliInvocationTransactionMarkerDigest,
  cliInvocationTransactionMarkerMatchesBasename,
  electCliInvocationTransactionOwnerBasename,
  isCliInvocationTransactionMarkerBasename,
  parseCliInvocationRecord,
  parseCliInvocationStaleMarker,
  parseCliInvocationTransactionMarker,
  serializeCliInvocationLifecycle,
  serializeCliInvocationRecord,
  serializeCliInvocationStaleMarker,
  serializeCliInvocationTransactionMarker,
  type CliInvocationLifecycleEvent,
  type CliInvocationRecord,
  type CliInvocationRecordPlatform,
  type CliInvocationStateDirIdentity,
  type CliInvocationTransactionMarker,
  type CliInvocationTransactionOperation,
} from "@traycer/protocol/config/cli-invocation-record";
import { createCliLogger, errorFromUnknown } from "../logger";
import {
  CLI_ERROR_CODES,
  CliError,
  cliError,
  isErrnoException,
} from "../runner/errors";
import type { Environment } from "../runner/environment";
import {
  currentProcessIdentityToken,
  verifyProcessIdentityAsync,
} from "../store/process-identity";
import {
  ensureCliInvocationStateDir,
  inspectCliInvocationStateDir,
} from "../store/paths";
import type { CliInvocation } from "./cli-binary";

// OSS CLI writer for the host-owned invocation record. Schema, filenames,
// and the cache-bypass contract live in `@traycer/protocol/config` so the
// host reader cannot drift; this module owns the staged-record /
// transaction-marker protocol around service registration and uninstall.
//
// Ordering (registration):
//   1. create a unique contender `cli-invocation.txn.<token>` (`wx`) and
//      become owner only as the sole remaining live marker
//   2. write a unique staging file named in that marker
//   3. mutate the OS registration
//   4. on confirmed OS success, rename *this owner's* staging over the live
//      record, write a fresh lifecycle generation, clear an earlier stale
//      marker (compare-then-unlink on its label; a marker that survives is
//      reported, because it keeps the committed record bypassed), release
//   5. on commit failure, mark stale and unlink the live file so an older
//      invocation cannot stay preferred, then fail the registration
//   6. on OS throw, ALSO mark stale and unlink the live file. The platform
//      controllers do not roll back: launchd `bootstrap` succeeds before
//      `kickstart` fails, `schtasks /Create` before `/Run` - so the previous
//      record may describe a registration that no longer exists. The stale
//      marker sends the host to the OS definition, which is the source of
//      truth in either outcome
//   7. on lifecycle-generation failure, mark stale but KEEP the live record:
//      the record and the OS agree, but a host that re-keys on the old
//      generation once this owner's marker is gone would replay a
//      pre-registration answer. The stale marker survives this process and
//      bypasses the record until the next confirmed CLI transaction clears
//      it
//
// Uninstall contends for the same unique-marker election, so it cannot
// delete an in-flight install's sidecars. It removes the live record only
// after the OS uninstall resolves and only when that record carries its own
// label. The removal is strict: a record that survives (or cannot be read)
// is marked stale so it cannot be preferred, and the uninstall is reported
// as failed. A throw from the OS uninstall is handled like a throw from the
// OS registration: the backend may have deleted the service before the step
// that threw, so the own-label record is marked stale and removed and the
// host re-reads the OS definition.
//
// Authority reads distinguish an UNREADABLE file (a lock, a permission
// error) from an absent one and fail closed on it: an unreadable marker
// still blocks the election (aged out by the usual window), an unreadable
// record cannot be confirmed removed, an unreadable stale marker cannot be
// reported cleared.
//
// Unparseable txn files use the shared
// `CLI_INVOCATION_TXN_ABANDON_AFTER_MS` age window, the same bound the
// host uses. A still-alive parsed owner is never abandoned by age.
// Dead unique files may be unlinked by anyone: the path is never reused,
// so that unlink cannot delete a different live owner's marker. The
// legacy exact `cli-invocation.txn` path is never created, unlinked, or
// renamed onto: a live exact marker blocks election; an abandoned one
// is nonblocking residue left on disk.
//
// The state child is gated with `O_DIRECTORY|O_NOFOLLOW` (symlinks
// rejected) and its `dev`/`ino` is re-checked before each write group.
// Creates exclusive-open then `fchmod` the handle; replacement is
// rename of that inode (live mode travels with the temp). Every
// operation below the gate is by pathname - Node has no `openat` family -
// so a post-gate swap of the child under a group-writable parent can
// redirect a create, a rename, or an unlink into a directory the attacker
// chose. What that buys is bounded and stated in the protocol module's
// header: creates make NEW fixed-basename 0600 files; a redirected record
// rename lands a record whose label that directory's reader rejects; and
// every unlink is compare-then-remove (live record by label, stale marker
// by label, everything else by a per-transaction token), so no other
// directory's file is removed. No existing file is truncated, written
// through, or chmod'd through a pathname. Authority reads (markers, live
// record, compare-before-unlink) use O_NOFOLLOW: a symlink at a marker
// basename is skipped, not treated as live — a genuine marker is never a
// symlink (`wx`), and counting one as live would let a parent-writer
// suppress registration with one link.

const NODE_FAMILY_BASENAMES: ReadonlySet<string> = new Set([
  "node",
  "node.exe",
  "bun",
  "bun.exe",
]);

/**
 * Did the OS registration inside `runServiceRegistrationWithInvocationRecord`
 * succeed before this error was thrown?
 *
 * The record commit, the lifecycle write and the stale-marker clear all run
 * AFTER the service manager has accepted the registration and started
 * launching the supervisor. A caller holding a host-start adoption lease must
 * therefore treat such an error differently from an OS failure: the
 * supervisor is already coming up and will present the lease, so the lease
 * has to be honoured (waited for) before the error is surfaced, or a
 * successfully registered service is left without its host.
 *
 * The OS backends answer the same question for their own partial failures,
 * and the register-throw branch above rethrows their error unchanged so the
 * flag travels: macOS `kickstart` after a successful `bootstrap`, Windows
 * `/Run` and the spawn-evidence wait after a successful `/Create`. Linux
 * rolls a failed `enable --now` back (disable, unit removed) and so does not
 * set it.
 */
export function didServiceRegistrationCommit(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  return error.details?.registrationCommitted === true;
}

export interface ServiceRegistrationRecordOptions {
  readonly environment: Environment;
  // Already-resolved host runtime home (CLI `hostHomeDir(environment)`,
  // including slotted `dev-runs/<slot>`). Never reconstructed from
  // `~/.traycer` here — same parameterization as the protocol path helpers.
  readonly hostHomeDir: string;
  readonly serviceLabel: string;
  readonly cli: CliInvocation;
  readonly register: () => Promise<void>;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

export interface ServiceUninstallRecordOptions {
  readonly environment: Environment;
  readonly hostHomeDir: string;
  readonly serviceLabel: string;
  readonly uninstall: () => Promise<void>;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

const PRODUCTION_TXN_WAIT_MS = 30_000;
const PRODUCTION_TXN_POLL_MS = 100;

export const CLI_INVOCATION_TXN_WAIT_MS = PRODUCTION_TXN_WAIT_MS;
export const CLI_INVOCATION_TXN_POLL_MS = PRODUCTION_TXN_POLL_MS;

export type CliInvocationTxnObservePause = () => Promise<void>;

let observePauseForTest: CliInvocationTxnObservePause | null = null;

/**
 * Test-only acquire interleaving. Production never calls this. Pass
 * `null` to restore the no-op. Returns the previous hook so tests can
 * save/restore symmetrically.
 */
export function __setCliInvocationTxnObservePauseForTest(
  next: CliInvocationTxnObservePause | null,
): CliInvocationTxnObservePause | null {
  const previous = observePauseForTest;
  observePauseForTest = next;
  return previous;
}

let pauseAfterGateForTest: CliInvocationTxnObservePause | null = null;
let pauseBeforeWriteForTest: CliInvocationTxnObservePause | null = null;

export function __setCliInvocationStateDirPauseAfterGateForTest(
  next: CliInvocationTxnObservePause | null,
): CliInvocationTxnObservePause | null {
  const previous = pauseAfterGateForTest;
  pauseAfterGateForTest = next;
  return previous;
}

export function __setCliInvocationStateDirPauseBeforeWriteForTest(
  next: CliInvocationTxnObservePause | null,
): CliInvocationTxnObservePause | null {
  const previous = pauseBeforeWriteForTest;
  pauseBeforeWriteForTest = next;
  return previous;
}

let pauseAfterExclusiveCreateForTest: CliInvocationTxnObservePause | null =
  null;

export function __setCliInvocationPauseAfterExclusiveCreateForTest(
  next: CliInvocationTxnObservePause | null,
): CliInvocationTxnObservePause | null {
  const previous = pauseAfterExclusiveCreateForTest;
  pauseAfterExclusiveCreateForTest = next;
  return previous;
}

/**
 * `cause` is whatever the state-directory check threw. Its errno code is
 * carried in `details` so a plain `EACCES` or `ENOSPC` is diagnosable from a
 * support report; `null` when the rejection was ours (an identity mismatch).
 */
function stateDirUnsafeError(
  serviceLabel: string,
  operation: CliInvocationTransactionOperation,
  cause: unknown,
): Error {
  return cliError({
    code:
      operation === "uninstall"
        ? CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED
        : CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    message: `CLI invocation state directory is not safe to hold a record for '${serviceLabel}'`,
    details: {
      label: serviceLabel,
      phase: "invocation-state-dir",
      causeCode: isErrnoException(cause) ? (cause.code ?? null) : null,
    },
    exitCode: 1,
  });
}

async function ensureInvocationHostHome(
  hostHomeDir: string,
  serviceLabel: string,
  operation: CliInvocationTransactionOperation,
): Promise<CliInvocationStateDirIdentity> {
  try {
    const identity = await ensureCliInvocationStateDir(hostHomeDir);
    if (pauseAfterGateForTest !== null) {
      await pauseAfterGateForTest();
    }
    return identity;
  } catch (cause) {
    if (
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      typeof cause.code === "string" &&
      cause.code.startsWith("E_SERVICE_")
    ) {
      throw cause;
    }
    throw stateDirUnsafeError(serviceLabel, operation, cause);
  }
}

async function assertStateDirUnchanged(
  hostHomeDir: string,
  expected: CliInvocationStateDirIdentity,
  serviceLabel: string,
  operation: CliInvocationTransactionOperation,
): Promise<void> {
  if (pauseBeforeWriteForTest !== null) {
    await pauseBeforeWriteForTest();
  }
  try {
    const current = await inspectCliInvocationStateDir(hostHomeDir, false);
    if (!cliInvocationStateDirIdentitiesMatch(expected, current)) {
      throw stateDirUnsafeError(serviceLabel, operation, null);
    }
  } catch (cause) {
    if (
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      typeof cause.code === "string" &&
      cause.code.startsWith("E_SERVICE_")
    ) {
      throw cause;
    }
    throw stateDirUnsafeError(serviceLabel, operation, cause);
  }
}

export async function runServiceRegistrationWithInvocationRecord(
  options: ServiceRegistrationRecordOptions,
): Promise<void> {
  const platform = cliInvocationRecordPlatformFor(process.platform);
  if (platform === null) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_UNSUPPORTED_PLATFORM,
      message: `service controller: unsupported platform '${process.platform}' (expected darwin|linux|win32)`,
      details: { platform: process.platform },
      exitCode: 1,
    });
  }
  const logger = createCliLogger(options.environment);
  const stateDirIdentity = await ensureInvocationHostHome(
    options.hostHomeDir,
    options.serviceLabel,
    "install",
  );
  const record = await buildValidatedRegistrationRecord({
    cli: options.cli,
    platform,
    serviceLabel: options.serviceLabel,
  });
  const held = await acquireTransaction({
    hostHomeDir: options.hostHomeDir,
    serviceLabel: options.serviceLabel,
    operation: "install",
    waitMs: options.waitMs,
    pollIntervalMs: options.pollIntervalMs,
    stateDirIdentity,
  });
  try {
    await assertStateDirUnchanged(
      options.hostHomeDir,
      stateDirIdentity,
      options.serviceLabel,
      "install",
    );
    await writeRestrictiveFile(
      held.stagingPath,
      serializeCliInvocationRecord(record),
    );
  } catch (cause) {
    logger.debug("CLI invocation record staging failed before OS mutation", {
      environment: options.environment,
      label: options.serviceLabel,
      errorName: errorFromUnknown(cause).name,
    });
    await releaseOwnedTransaction(held);
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `could not stage the CLI invocation record for '${options.serviceLabel}' before registering the service`,
      details: { label: options.serviceLabel, phase: "stage" },
      exitCode: 1,
    });
  }

  try {
    await options.register();
  } catch (cause) {
    // Not a rollback. The controllers mutate the OS in more than one step
    // (write + `bootstrap` + `kickstart`; `/Create` + `/Run`), and a throw
    // from a later step leaves the earlier ones in place - so the OS may now
    // describe THIS registration while the live record still describes the
    // previous one. Neither can be preferred over the OS definition, and the
    // stale marker is what sends the host there.
    logger.debug("OS registration threw; marking the cached invocation stale", {
      environment: options.environment,
      label: options.serviceLabel,
      errorName: errorFromUnknown(cause).name,
    });
    await markStaleAndUnpreferLive(held);
    throw cause;
  }

  try {
    await assertStateDirUnchanged(
      options.hostHomeDir,
      stateDirIdentity,
      options.serviceLabel,
      "install",
    );
    await rename(held.stagingPath, held.livePath);
  } catch (cause) {
    logger.debug(
      "CLI invocation record commit failed after OS registration succeeded",
      {
        environment: options.environment,
        label: options.serviceLabel,
        errorName: errorFromUnknown(cause).name,
      },
    );
    await markStaleAndUnpreferLive(held);
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service '${options.serviceLabel}' was registered, but the CLI invocation record could not be committed; the previous cached invocation was marked stale so it cannot be preferred`,
      details: {
        label: options.serviceLabel,
        phase: "commit",
        registrationCommitted: true,
      },
      exitCode: 1,
    });
  }

  try {
    await assertStateDirUnchanged(
      options.hostHomeDir,
      stateDirIdentity,
      options.serviceLabel,
      "install",
    );
    await writeConfirmedLifecycle(held, "registered", options.serviceLabel);
  } catch (cause) {
    logger.debug(
      "CLI invocation lifecycle generation write failed after record commit",
      {
        environment: options.environment,
        label: options.serviceLabel,
        errorName: errorFromUnknown(cause).name,
      },
    );
    // The record is committed and correct, so it stays. What is missing is
    // the generation, and without it a host that latched an answer under
    // the OLD generation would serve it again the moment this owner's
    // transaction marker is gone (an abandoned unique marker is reclaimed by
    // the next CLI transaction, and nothing else in the key would have
    // moved). The stale marker is the durable substitute: it outlives this
    // process, bypasses the record on every read, and is cleared only by a
    // later confirmed transaction - which writes the generation this one
    // could not.
    await markStaleKeepLive(held);
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service '${options.serviceLabel}' was registered, but the lifecycle generation could not be written; the cached invocation was marked stale so the host re-reads the OS registration`,
      details: {
        label: options.serviceLabel,
        phase: "lifecycle",
        registrationCommitted: true,
      },
      exitCode: 1,
    });
  }
  try {
    await assertStateDirUnchanged(
      options.hostHomeDir,
      stateDirIdentity,
      options.serviceLabel,
      "install",
    );
  } catch (cause) {
    // Post-registration like the two throws above it: the service manager has
    // the registration and the record and generation are committed, so the
    // adoption lease must still be honoured. Nothing is marked here - the
    // directory this transaction validated is no longer the one at the path,
    // and a marker written into whatever replaced it would bypass nothing of
    // ours. The retained transaction marker is what outlives this process.
    logger.debug(
      "CLI invocation state directory changed after the lifecycle write",
      {
        environment: options.environment,
        label: options.serviceLabel,
        errorName: errorFromUnknown(cause).name,
      },
    );
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service '${options.serviceLabel}' was registered and its CLI invocation record committed, but the record directory changed before an earlier stale marker could be cleared; the host re-reads the OS registration until a later service command clears it`,
      details: {
        label: options.serviceLabel,
        phase: "stale-clear",
        outcome: "unsafe-state-dir",
        registrationCommitted: true,
      },
      exitCode: 1,
    });
  }
  // Clear an earlier commit failure's stale marker BEFORE releasing, and
  // report a marker that survives: the record just committed is authoritative,
  // and a stale marker beside it keeps every host read on the OS definition
  // until some later CLI transaction succeeds at this step. Silence here would
  // report a registration as clean while npm/nvm maintenance stays degraded.
  const staleOutcome = await removeStaleMarkerIfOwn(held);
  await releaseOwnedTransaction(held);
  if (staleOutcome === "failed" || staleOutcome === "foreign") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service '${options.serviceLabel}' was registered and its CLI invocation record committed, but an earlier stale marker could not be cleared (${staleOutcome}); the host re-reads the OS registration until a later service command clears it`,
      details: {
        label: options.serviceLabel,
        phase: "stale-clear",
        outcome: staleOutcome,
        registrationCommitted: true,
      },
      exitCode: 1,
    });
  }
  logger.debug("CLI invocation record committed after service registration", {
    environment: options.environment,
    label: options.serviceLabel,
    argCount: record.args.length,
    sourceKind: record.source.kind,
  });
}

export async function runServiceUninstallWithInvocationRecord(
  options: ServiceUninstallRecordOptions,
): Promise<void> {
  const logger = createCliLogger(options.environment);
  const stateDirIdentity = await ensureInvocationHostHome(
    options.hostHomeDir,
    options.serviceLabel,
    "uninstall",
  );
  const held = await acquireTransaction({
    hostHomeDir: options.hostHomeDir,
    serviceLabel: options.serviceLabel,
    operation: "uninstall",
    waitMs: options.waitMs,
    pollIntervalMs: options.pollIntervalMs,
    stateDirIdentity,
  });
  try {
    await options.uninstall();
  } catch (cause) {
    // Same reasoning as the registration path: the backend may have removed
    // the service before the step that threw (`schtasks /Delete` runs before
    // the authority check and the launcher removal), so the live record may
    // describe a service that no longer exists. It is marked stale and
    // removed after its label matched; the host re-reads the OS definition,
    // which is the truth whether or not the deletion happened.
    logger.debug("OS uninstall threw; marking the cached invocation stale", {
      environment: options.environment,
      label: options.serviceLabel,
      errorName: errorFromUnknown(cause).name,
    });
    await markStaleAndUnpreferLive(held);
    throw cause;
  }
  // Identity BEFORE the label read, so every classification below - foreign
  // included - is of the record in the directory this transaction validated.
  // A directory swapped in after the uninstall would otherwise present some
  // other environment's record as "foreign" and return clean, leaving the
  // real record of the removed service behind an abandoned marker.
  await assertStateDirUnchangedAfterUninstall(held, options, stateDirIdentity);
  const matching = await liveRecordMatchesLabel(
    held.livePath,
    options.serviceLabel,
  );
  if (matching === "foreign") {
    logger.debug(
      "CLI invocation record retained after uninstall; live record is for a different label",
      {
        environment: options.environment,
        label: options.serviceLabel,
      },
    );
    await releaseOwnedTransaction(held);
    return;
  }
  // Again after the label compare: this is the compare half of
  // compare-then-unlink, and the identity must hold at the unlink too.
  await assertStateDirUnchangedAfterUninstall(held, options, stateDirIdentity);
  // Strict, not best-effort: `matching` above is the compare half of
  // compare-then-unlink, and this is the unlink. A record that survives its
  // own uninstall - a sharing violation on Windows is the realistic case -
  // would be preferred again by the next host read, so it is marked stale
  // (durable, bypasses it) and the uninstall is reported as failed rather
  // than clean. `absent` unlinks nothing: whatever is at the name is not a
  // record of this label, and the host's reader does not prefer it either.
  // `unreadable` is the same failure as a refused unlink: a record whose
  // label could not even be checked cannot be confirmed removed.
  let removalFailure: unknown = null;
  if (matching === "unreadable") {
    removalFailure = new Error("CLI invocation record could not be read");
  } else if (matching === "matching") {
    try {
      await rm(held.livePath, { force: true });
    } catch (cause) {
      removalFailure = cause;
    }
  }
  if (removalFailure !== null) {
    logger.debug("CLI invocation record could not be removed after uninstall", {
      environment: options.environment,
      label: options.serviceLabel,
      errorName: errorFromUnknown(removalFailure).name,
    });
    await markStaleKeepLive(held);
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED,
      message: `service '${options.serviceLabel}' was uninstalled, but its CLI invocation record could not be removed; it was marked stale so it cannot be preferred`,
      details: { label: options.serviceLabel, phase: "record-remove" },
      exitCode: 1,
    });
  }
  // Best effort HERE, unlike after a registration: with no record left, a
  // stale marker that survives bypasses an empty cache, and the next
  // registration's strict clear reports it if it is still there.
  await removeStaleMarkerIfOwn(held);
  try {
    await assertStateDirUnchanged(
      options.hostHomeDir,
      stateDirIdentity,
      options.serviceLabel,
      "uninstall",
    );
    await writeConfirmedLifecycle(held, "uninstalled", options.serviceLabel);
  } catch (cause) {
    logger.debug(
      "CLI invocation lifecycle generation write failed after confirmed uninstall",
      {
        environment: options.environment,
        label: options.serviceLabel,
        errorName: errorFromUnknown(cause).name,
      },
    );
    // Same durable substitute as the registration path: a host that latched
    // under the old generation must not replay the pre-uninstall answer once
    // this owner's marker is reclaimed, and the stale marker is what survives
    // to stop it.
    await markStaleKeepLive(held);
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED,
      message: `service '${options.serviceLabel}' was uninstalled, but the lifecycle generation could not be written; a stale marker was left so the cached invocation cannot be replayed`,
      details: { label: options.serviceLabel, phase: "lifecycle" },
      exitCode: 1,
    });
  }
  await releaseOwnedTransaction(held);
  logger.debug("CLI invocation record removed after confirmed uninstall", {
    environment: options.environment,
    label: options.serviceLabel,
  });
}

async function buildValidatedRegistrationRecord(input: {
  readonly cli: CliInvocation;
  readonly platform: CliInvocationRecordPlatform;
  readonly serviceLabel: string;
}): Promise<CliInvocationRecord> {
  const command = input.cli.command;
  if (!isAbsolute(command) || command.includes("\0")) {
    throw invalidInvocation(
      input.serviceLabel,
      "command is not an absolute path",
    );
  }
  if (command.length > CLI_INVOCATION_RECORD_MAX_ARG_LENGTH) {
    throw invalidInvocation(input.serviceLabel, "command exceeds length bound");
  }
  if (!(await isExecutableRegularFile(command))) {
    throw invalidInvocation(
      input.serviceLabel,
      "command is not an executable regular file",
    );
  }
  if (input.cli.args.length > CLI_INVOCATION_RECORD_MAX_ARGS) {
    throw invalidInvocation(input.serviceLabel, "too many leading arguments");
  }
  if (isNodeFamilyCommand(command) && input.cli.args.length !== 1) {
    throw invalidInvocation(
      input.serviceLabel,
      "npm-style interpreter registrations take exactly one absolute script argument",
    );
  }
  const args: string[] = [];
  for (const [index, arg] of input.cli.args.entries()) {
    if (
      arg.includes("\0") ||
      arg.length > CLI_INVOCATION_RECORD_MAX_ARG_LENGTH
    ) {
      throw invalidInvocation(
        input.serviceLabel,
        "a leading argument contains NUL or exceeds the length bound",
      );
    }
    if (isAbsolute(arg) && !(await isRegularFile(arg))) {
      throw invalidInvocation(
        input.serviceLabel,
        "a file-like leading argument is not a regular file",
      );
    }
    // EXACTLY one argument for an interpreter, and it is the absolute script.
    // The record is a closed shape and `<interpreter> <absolute script>` is
    // the only interpreter form any emitter writes; a vector whose script
    // this CLI would have to guess at (`node --enable-source-maps /x.js`,
    // `node --eval payload`) is declined rather than re-interpreted, because
    // a wrong guess here is a wrong program handed to `spawn` on every later
    // maintenance call. The host's structural check applies the same rule.
    if (index === 0 && isNodeFamilyCommand(command) && !isAbsolute(arg)) {
      throw invalidInvocation(
        input.serviceLabel,
        "npm-style interpreter registrations require an absolute script argument",
      );
    }
    args.push(arg);
  }
  const record: CliInvocationRecord = {
    schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
    command,
    args,
    source: {
      kind: "service-registration",
      platform: input.platform,
      serviceLabel: input.serviceLabel,
    },
    recoveredAt: new Date().toISOString(),
  };
  if (
    new TextEncoder().encode(serializeCliInvocationRecord(record)).length >
    CLI_INVOCATION_RECORD_MAX_SERIALIZED_BYTES
  ) {
    throw invalidInvocation(
      input.serviceLabel,
      "serialized invocation exceeds size bound",
    );
  }
  return record;
}

function isNodeFamilyCommand(command: string): boolean {
  return NODE_FAMILY_BASENAMES.has(basename(command).toLowerCase());
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableRegularFile(path: string): Promise<boolean> {
  if (!(await isRegularFile(path))) return false;
  if (process.platform === "win32") return true;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function invalidInvocation(label: string, reason: string): Error {
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
    message: `service install: CLI invocation is not persistable for '${label}': ${reason}`,
    details: { label },
    exitCode: 1,
  });
}

interface HeldTransaction {
  readonly token: string;
  readonly basename: string;
  readonly txnPath: string;
  readonly stagingPath: string;
  readonly livePath: string;
  readonly stalePath: string;
  readonly lifecyclePath: string;
  readonly rawMarker: string;
  readonly hostHomeDir: string;
  readonly stateDirIdentity: CliInvocationStateDirIdentity;
  readonly serviceLabel: string;
  readonly operation: CliInvocationTransactionOperation;
  /**
   * Digest of the abandoned legacy exact `cli-invocation.txn` this owner
   * observed when it won the election, or `null`. Written into the lifecycle
   * this transaction commits, so the host can discharge that marker by
   * matching bytes rather than by comparing clocks.
   */
  readonly legacyMarkerDigest: string | null;
}

interface ObservedContender {
  readonly basename: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly raw: string;
  readonly abandoned: boolean;
}

async function acquireTransaction(input: {
  readonly hostHomeDir: string;
  readonly serviceLabel: string;
  readonly operation: CliInvocationTransactionOperation;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
  readonly stateDirIdentity: CliInvocationStateDirIdentity;
}): Promise<HeldTransaction> {
  // Monotonic, deliberately: this bounds how long a CLI waits behind another
  // live transaction, and a wall clock stepped backwards mid-wait would keep
  // a 30-second deadline in the future for as long as the step was. Marker
  // AGES stay on wall time because they are compared against timestamps
  // another process persisted.
  const deadline = performance.now() + input.waitMs;
  let held: HeldTransaction | null = null;
  for (;;) {
    const observed = await observeTransactionMarkers(input.hostHomeDir);
    if (observePauseForTest !== null) {
      await observePauseForTest();
    }
    await cleanupAbandonedContenders(
      observed,
      held === null ? "" : held.txnPath,
    );
    const live = (await observeTransactionMarkers(input.hostHomeDir)).filter(
      (entry) => !entry.abandoned,
    );
    const others = live.filter(
      (entry) => held === null || entry.path !== held.txnPath,
    );
    if (others.length > 0) {
      if (held !== null) {
        const winnerBasename = electCliInvocationTransactionOwnerBasename(
          live.map((entry) => ({
            basename: entry.basename,
            mtimeMs: entry.mtimeMs,
          })),
        );
        if (winnerBasename !== held.basename) {
          await unlinkIfUnchanged(held.txnPath, held.rawMarker);
          held = null;
        }
      }
    } else if (held === null) {
      await assertStateDirUnchanged(
        input.hostHomeDir,
        input.stateDirIdentity,
        input.serviceLabel,
        input.operation,
      );
      held = await createUniqueContender(input);
      continue;
    } else {
      const heldPath = held.txnPath;
      const all = await observeTransactionMarkers(input.hostHomeDir);
      const confirmed = all.filter((entry) => !entry.abandoned);
      if (confirmed.length === 1 && confirmed[0]?.path === heldPath) {
        // The legacy exact marker is never unlinked by anyone, so an
        // abandoned one is residue this transaction is about to supersede.
        // Its bytes are what the lifecycle will name as superseded; a LIVE
        // legacy marker never reaches this branch (it is an `other`).
        const legacy = all.find(
          (entry) =>
            entry.basename === CLI_INVOCATION_RECORD_TXN_FILENAME &&
            entry.abandoned,
        );
        return {
          ...held,
          legacyMarkerDigest:
            legacy === undefined
              ? null
              : cliInvocationTransactionMarkerDigest(
                  Buffer.from(legacy.raw, "utf8"),
                ),
        };
      }
      if (!confirmed.some((entry) => entry.path === heldPath)) {
        held = null;
      }
    }
    if (performance.now() >= deadline) {
      if (held !== null) {
        await unlinkIfUnchanged(held.txnPath, held.rawMarker);
      }
      throw cliError({
        code:
          input.operation === "uninstall"
            ? CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED
            : CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: `another CLI service ${input.operation} is already in progress for '${input.serviceLabel}'`,
        details: { label: input.serviceLabel, phase: "txn-busy" },
        exitCode: 75,
      });
    }
    await sleep(input.pollIntervalMs);
  }
}

async function createUniqueContender(input: {
  readonly hostHomeDir: string;
  readonly serviceLabel: string;
  readonly operation: CliInvocationTransactionOperation;
  readonly stateDirIdentity: CliInvocationStateDirIdentity;
}): Promise<HeldTransaction> {
  for (;;) {
    const token = randomUUID();
    const identity = currentProcessIdentityToken();
    const marker: CliInvocationTransactionMarker = {
      schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
      kind: "transaction",
      owner: {
        pid: identity.pid,
        token,
        processStartIdentity: identity.startIdentity,
        startedAtMs: identity.startedAtMs,
      },
      stagingFile: cliInvocationRecordOwnedStagingBasename(token),
      operation: input.operation,
      serviceLabel: input.serviceLabel,
      startedAt: new Date().toISOString(),
    };
    const rawMarker = serializeCliInvocationTransactionMarker(marker);
    const basenameForFile = cliInvocationRecordOwnedTransactionBasename(token);
    const txnPath = cliInvocationRecordOwnedTransactionPath(
      input.hostHomeDir,
      token,
    );
    try {
      await writeExclusiveAuthorityFile(txnPath, rawMarker);
    } catch (cause) {
      if (isErrnoException(cause) && cause.code === "EEXIST") {
        continue;
      }
      throw cliError({
        code:
          input.operation === "uninstall"
            ? CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED
            : CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: `could not acquire the CLI invocation transaction for '${input.serviceLabel}'`,
        details: { label: input.serviceLabel, phase: "txn-acquire" },
        exitCode: 1,
      });
    }
    return {
      token,
      basename: basenameForFile,
      txnPath,
      stagingPath: cliInvocationRecordOwnedStagingPath(
        input.hostHomeDir,
        token,
      ),
      livePath: cliInvocationRecordPath(input.hostHomeDir),
      stalePath: cliInvocationRecordStaleMarkerPath(input.hostHomeDir),
      lifecyclePath: cliInvocationLifecyclePath(input.hostHomeDir),
      rawMarker,
      hostHomeDir: input.hostHomeDir,
      stateDirIdentity: input.stateDirIdentity,
      serviceLabel: input.serviceLabel,
      operation: input.operation,
      legacyMarkerDigest: null,
    };
  }
}

function openFlagsForAuthorityRead(): number {
  if (process.platform === "win32") return constants.O_RDONLY;
  return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
}

/**
 * What a read of an authority file inside the state dir found.
 *
 * Four outcomes rather than "content or null", because the callers cannot
 * all treat "could not read" the same way:
 *
 *   - `absent`: nothing at the name (or the directory itself is gone);
 *   - `not-a-file`: a symlink (refused by `O_NOFOLLOW`), a directory, a FIFO.
 *     No writer of ours creates one (`wx` never yields a link), and the
 *     host's reader skips the same entries, so it is skip-not-live: never a
 *     contender, never a bypass, nothing to clear;
 *   - `unreadable`: a regular file is there and could not be opened or read
 *     (`EACCES`, `EBUSY`, `EPERM`, `EIO` - a sharing or antivirus lock on
 *     Windows is the realistic case). Collapsing this into `absent` let a
 *     second CLI confirm itself as sole contender while the first, whose live
 *     marker was momentarily locked, was already mutating the OS. It is
 *     therefore FAIL-CLOSED wherever it matters: a marker that cannot be read
 *     still blocks, a record that cannot be read cannot be confirmed removed,
 *     a stale marker that cannot be read cannot be reported cleared.
 */
type AuthorityRead =
  | { readonly kind: "ok"; readonly raw: string; readonly mtimeMs: number }
  | { readonly kind: "absent" }
  | { readonly kind: "not-a-file" }
  | { readonly kind: "unreadable"; readonly mtimeMs: number | null };

async function readAuthorityFile(path: string): Promise<AuthorityRead> {
  let handle: FileHandle;
  try {
    handle = await open(path, openFlagsForAuthorityRead());
  } catch (cause) {
    const code = isErrnoException(cause) ? cause.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    // `O_NOFOLLOW` refuses a symlink with ELOOP (Linux, macOS). A directory
    // opened read-only succeeds on POSIX and is caught by `isFile` below, but
    // Windows refuses the open itself with EISDIR, so that code is the same
    // "not a marker" answer rather than an unreadable one that would block.
    if (code === "ELOOP" || code === "EISDIR") return { kind: "not-a-file" };
    return { kind: "unreadable", mtimeMs: await lstatMtimeMs(path) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "not-a-file" };
    return {
      kind: "ok",
      raw: await handle.readFile("utf8"),
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return { kind: "unreadable", mtimeMs: await lstatMtimeMs(path) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function lstatMtimeMs(path: string): Promise<number | null> {
  try {
    return (await lstat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function observeTransactionMarkers(
  hostHomeDir: string,
): Promise<ObservedContender[]> {
  const stateDir = cliInvocationStateDir(hostHomeDir);
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return [];
  }
  const observed = await Promise.all(
    names.filter(isCliInvocationTransactionMarkerBasename).map(async (name) => {
      const path = join(stateDir, name);
      const read = await readAuthorityFile(path);
      // Skip-not-live: a planted symlink (O_NOFOLLOW/ELOOP) is not a
      // contender. A genuine marker is created with wx and is never a link.
      if (read.kind === "absent" || read.kind === "not-a-file") return null;
      if (read.kind === "unreadable") {
        // A marker that IS there and cannot be read blocks like a live one:
        // its owner may be mid-mutation right now. It is aged out by the
        // same window an unparseable payload gets, and its empty `raw`
        // means no compare-then-unlink can ever match it, so nothing here
        // removes a file whose contents it never saw.
        const mtimeMs = read.mtimeMs ?? Date.now();
        return {
          basename: name,
          path,
          mtimeMs,
          raw: "",
          abandoned: cliInvocationTransactionAbandonedByAge(
            mtimeMs,
            Date.now(),
          ),
        };
      }
      return {
        basename: name,
        path,
        mtimeMs: read.mtimeMs,
        raw: read.raw,
        abandoned: await isAbandonedContender(name, read.raw, read.mtimeMs),
      };
    }),
  );
  const present: ObservedContender[] = [];
  for (const entry of observed) {
    if (entry !== null) present.push(entry);
  }
  return present;
}

async function isAbandonedContender(
  name: string,
  raw: string,
  mtimeMs: number,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const marker = parseCliInvocationTransactionMarker(parsed);
  if (
    marker === null ||
    !cliInvocationTransactionMarkerMatchesBasename(marker, name)
  ) {
    return cliInvocationTransactionAbandonedByAge(mtimeMs, Date.now());
  }
  const verdict = await verifyProcessIdentityAsync({
    pid: marker.owner.pid,
    startedAtMs: marker.owner.startedAtMs,
    startIdentity: marker.owner.processStartIdentity,
  });
  if (verdict === "dead" || verdict === "alive-different") return true;
  if (verdict === "alive-same") return false;
  // `indeterminate`: the pid is alive but the marker carries no start identity
  // to compare it against (the owner could not obtain one), or the probe could
  // not read the process's. A dead owner whose pid was reused looks exactly
  // like this, and without the age window it would hold the election for as
  // long as the unrelated process keeps the pid - every later install and
  // uninstall timing out on it. The host applies the same window to the same
  // verdict; a parsed owner that is positively alive is still never aged out.
  return cliInvocationTransactionAbandonedByAge(
    Number.isFinite(Date.parse(marker.startedAt))
      ? Math.max(Date.parse(marker.startedAt), mtimeMs)
      : mtimeMs,
    Date.now(),
  );
}

async function cleanupAbandonedContenders(
  observed: readonly ObservedContender[],
  keepPath: string,
): Promise<void> {
  for (const entry of observed) {
    if (!entry.abandoned) continue;
    if (entry.path === keepPath) continue;
    // Never unlink the legacy exact path. Abandoned exact files are
    // nonblocking residue; unique contenders elect around them.
    if (entry.basename === CLI_INVOCATION_RECORD_TXN_FILENAME) continue;
    await unlinkIfUnchanged(entry.path, entry.raw);
  }
}

async function unlinkIfUnchanged(
  path: string,
  expectedRaw: string,
): Promise<boolean> {
  if (basename(path) === CLI_INVOCATION_RECORD_TXN_FILENAME) {
    return false;
  }
  const read = await readAuthorityFile(path);
  if (read.kind === "absent") return true;
  if (read.kind !== "ok") return false;
  if (read.raw !== expectedRaw) return false;
  await removeBestEffort(path);
  return true;
}

async function releaseOwnedTransaction(held: HeldTransaction): Promise<void> {
  await removeBestEffort(held.stagingPath);
  await unlinkIfUnchanged(held.txnPath, held.rawMarker);
}

function openFlagsForExclusiveCreate(): number {
  if (process.platform === "win32") {
    return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  }
  return (
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW
  );
}

async function writeExclusiveAuthorityFile(
  path: string,
  contents: string,
): Promise<void> {
  const handle = await open(path, openFlagsForExclusiveCreate(), 0o600);
  try {
    if (pauseAfterExclusiveCreateForTest !== null) {
      await pauseAfterExclusiveCreateForTest();
    }
    if (process.platform !== "win32") {
      await handle.chmod(0o600);
    }
    await handle.writeFile(contents, { encoding: "utf8" });
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await removeBestEffort(path);
    throw cause;
  }
  await handle.close();
}

async function writeRestrictiveFile(
  path: string,
  contents: string,
): Promise<void> {
  await writeExclusiveAuthorityFile(path, contents);
}

async function writeConfirmedLifecycle(
  held: HeldTransaction,
  event: CliInvocationLifecycleEvent,
  serviceLabel: string,
): Promise<void> {
  // Unique per owner token so two processes cannot share a temp name.
  // Same-directory temp + rename matches `writeJsonAtomically`: 0600 write,
  // then rename over the live file. The txn stays held until this rename
  // succeeds; failure cleans only this temp.
  const temporary = `${held.lifecyclePath}.${held.token}.tmp`;
  try {
    await writeExclusiveAuthorityFile(
      temporary,
      serializeCliInvocationLifecycle({
        schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
        kind: "lifecycle",
        generation: randomUUID(),
        event,
        serviceLabel,
        at: new Date().toISOString(),
        supersededLegacyMarkerDigest: held.legacyMarkerDigest,
      }),
    );
    await rename(temporary, held.lifecyclePath);
  } catch (cause) {
    await removeBestEffort(temporary);
    throw cause;
  }
}

/**
 * Write this label's stale marker. `false` when it could not be written, in
 * which case the caller keeps its transaction marker: presence of either is a
 * cache bypass, and marker I/O must never hide the failure being reported.
 */
async function writeStaleMarker(held: HeldTransaction): Promise<boolean> {
  try {
    await assertStateDirUnchanged(
      held.hostHomeDir,
      held.stateDirIdentity,
      held.serviceLabel,
      held.operation,
    );
    const temporary = `${held.stalePath}.${held.token}.tmp`;
    try {
      await writeExclusiveAuthorityFile(
        temporary,
        serializeCliInvocationStaleMarker({ serviceLabel: held.serviceLabel }),
      );
      await rename(temporary, held.stalePath);
      return true;
    } catch (cause) {
      await removeBestEffort(temporary);
      throw cause;
    }
  } catch {
    return false;
  }
}

/**
 * Commit failure and OS-throw path: the live record may describe a
 * registration that no longer exists, so it is unpreferred (stale marker) and
 * removed - after its label matched, like every other removal of it.
 */
async function markStaleAndUnpreferLive(held: HeldTransaction): Promise<void> {
  const staleWritten = await writeStaleMarker(held);
  if (
    (await liveRecordMatchesLabel(held.livePath, held.serviceLabel)) ===
    "matching"
  ) {
    // Identity re-check as the LAST thing before the unlink, after the label
    // compare, so the window between "this is our record" and "remove it" is
    // one syscall wide. A swap that lands inside it redirects the unlink to
    // a sibling environment's record, which is that environment's CACHE of
    // its OS definition: the cost is one OS re-read there, never a change in
    // what executes. Stated exactly in the protocol header.
    try {
      await assertStateDirUnchanged(
        held.hostHomeDir,
        held.stateDirIdentity,
        held.serviceLabel,
        held.operation,
      );
      await removeBestEffort(held.livePath);
    } catch {
      // The directory moved: leave the record where it is. The stale marker
      // (or the retained transaction marker) already bypasses it.
    }
  }
  await removeBestEffort(held.stagingPath);
  if (staleWritten) {
    await unlinkIfUnchanged(held.txnPath, held.rawMarker);
  }
}

/**
 * Post-uninstall identity check. The service is gone, so a record of this
 * label that survives describes nothing - which is the OS-throw case with the
 * same remedy: unprefer and remove it as far as the moved directory allows,
 * and report the uninstall as failed rather than clean. Where the identity
 * re-check refuses every write, the retained transaction marker is the bypass
 * that outlives this process.
 */
async function assertStateDirUnchangedAfterUninstall(
  held: HeldTransaction,
  options: ServiceUninstallRecordOptions,
  stateDirIdentity: CliInvocationStateDirIdentity,
): Promise<void> {
  try {
    await assertStateDirUnchanged(
      options.hostHomeDir,
      stateDirIdentity,
      options.serviceLabel,
      "uninstall",
    );
  } catch (cause) {
    createCliLogger(options.environment).debug(
      "CLI invocation state directory changed after OS uninstall; marking the cached invocation stale",
      {
        environment: options.environment,
        label: options.serviceLabel,
        errorName: errorFromUnknown(cause).name,
      },
    );
    await markStaleAndUnpreferLive(held);
    throw cause;
  }
}

/**
 * Lifecycle-write and record-removal failure path: what is on disk is
 * correct but must not be preferred until a later transaction confirms it.
 */
async function markStaleKeepLive(held: HeldTransaction): Promise<void> {
  const staleWritten = await writeStaleMarker(held);
  await removeBestEffort(held.stagingPath);
  if (staleWritten) {
    await unlinkIfUnchanged(held.txnPath, held.rawMarker);
  }
}

type StaleMarkerRemoval = "removed" | "absent" | "foreign" | "failed";

/**
 * Compare-then-unlink of `cli-invocation.stale`.
 *
 * The compare is on the marker's label through an `O_NOFOLLOW` read: a marker
 * for another label - which, since a label has exactly one host home, means
 * the state directory entry was re-pointed at another environment's
 * directory - is `foreign` and left alone; a legacy marker without a label is
 * anyone's. `failed` is a marker of ours that `unlink` refused (a Windows
 * sharing violation is the realistic case), and it is distinct from `foreign`
 * because the two want different diagnoses.
 *
 * A symlink, FIFO or directory at the name is `absent`, not `failed`: the
 * host's marker reader opens `O_NOFOLLOW` and skips anything that is not a
 * regular file, so such an entry bypasses nothing and there is nothing to
 * clear. Reporting it would hand anyone who can plant a link in this
 * directory a way to fail every `service install` while changing nothing.
 */
async function removeStaleMarkerIfOwn(
  held: HeldTransaction,
): Promise<StaleMarkerRemoval> {
  const read = await readAuthorityFile(held.stalePath);
  if (read.kind === "unreadable") return "failed";
  if (read.kind !== "ok") return "absent";
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return "foreign";
  }
  const marker = parseCliInvocationStaleMarker(parsed);
  if (
    marker === null ||
    !cliInvocationStaleMarkerRemovableBy(marker, held.serviceLabel)
  ) {
    return "foreign";
  }
  try {
    await rm(held.stalePath, { force: true });
    return "removed";
  } catch {
    return "failed";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `unreadable` is kept apart from `absent` because the two want opposite
 * things from an uninstall: an absent record needs no removal, an unreadable
 * one cannot be confirmed removed and must be marked stale instead.
 */
async function liveRecordMatchesLabel(
  livePath: string,
  serviceLabel: string,
): Promise<"matching" | "absent" | "foreign" | "unreadable"> {
  const read = await readAuthorityFile(livePath);
  if (read.kind === "unreadable") return "unreadable";
  if (read.kind !== "ok") return "absent";
  const raw = read.raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "absent";
  }
  const record = parseCliInvocationRecord(parsed);
  if (record === null) return "absent";
  return record.source.serviceLabel === serviceLabel ? "matching" : "foreign";
}

function isOwnKnownAuthorityBasename(name: string): boolean {
  if (name === CLI_INVOCATION_RECORD_TXN_FILENAME) return false;
  if (name === CLI_INVOCATION_RECORD_FILENAME) return true;
  if (name === CLI_INVOCATION_RECORD_STALE_FILENAME) return true;
  if (name === CLI_INVOCATION_LIFECYCLE_FILENAME) return true;
  if (isCliInvocationTransactionMarkerBasename(name)) return true;
  if (name.startsWith(CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX)) {
    return true;
  }
  if (
    name.startsWith(`${CLI_INVOCATION_LIFECYCLE_FILENAME}.`) &&
    name.endsWith(".tmp")
  ) {
    return true;
  }
  if (
    name.startsWith(`${CLI_INVOCATION_RECORD_STALE_FILENAME}.`) &&
    name.endsWith(".tmp")
  ) {
    return true;
  }
  return false;
}

async function removeBestEffort(path: string): Promise<void> {
  if (!isOwnKnownAuthorityBasename(basename(path))) {
    return;
  }
  try {
    await rm(path, { force: true });
  } catch {
    return;
  }
}
