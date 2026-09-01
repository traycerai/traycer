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
  cliInvocationStateDir,
  cliInvocationStateDirIdentitiesMatch,
  cliInvocationTransactionAbandonedByAge,
  cliInvocationTransactionMarkerMatchesBasename,
  electCliInvocationTransactionOwnerBasename,
  isCliInvocationTransactionMarkerBasename,
  parseCliInvocationRecord,
  parseCliInvocationTransactionMarker,
  serializeCliInvocationLifecycle,
  serializeCliInvocationRecord,
  serializeCliInvocationTransactionMarker,
  type CliInvocationLifecycleEvent,
  type CliInvocationRecord,
  type CliInvocationRecordPlatform,
  type CliInvocationStateDirIdentity,
  type CliInvocationTransactionMarker,
  type CliInvocationTransactionOperation,
} from "@traycer/protocol/config/cli-invocation-record";
import { createCliLogger, errorFromUnknown } from "../logger";
import { CLI_ERROR_CODES, cliError, isErrnoException } from "../runner/errors";
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
//      record
//   5. on commit failure, mark stale and unlink the live file so an older
//      invocation cannot stay preferred, then fail the registration
//   6. on OS throw (platform controllers roll back), release *this owner's*
//      unique txn+staging and leave the live record
//
// Uninstall contends for the same unique-marker election, so it cannot
// delete an in-flight install's sidecars. It removes the live record only
// after the OS uninstall resolves. A throw retains the live record and
// still releases only this owner's unique txn.
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
// rename of that inode (live mode travels with the temp). Residual: a
// post-gate swap of the child under a group-writable parent can at
// most create NEW fixed-basename 0600 files in a directory the
// attacker chose; no existing file is truncated, written through, or
// chmod'd through a pathname. Authority reads
// (markers, live record, compare-before-unlink) use O_NOFOLLOW: a
// symlink at a marker basename is skipped, not treated as live — a
// genuine marker is never a symlink (`wx`), and counting one as live
// would let a parent-writer suppress registration with one link.

const STALE_MARKER_BODY = `${JSON.stringify({
  schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
  kind: "stale",
})}\n`;

const NODE_FAMILY_BASENAMES: ReadonlySet<string> = new Set([
  "node",
  "node.exe",
  "bun",
  "bun.exe",
]);

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

function stateDirUnsafeError(
  serviceLabel: string,
  operation: CliInvocationTransactionOperation,
): Error {
  return cliError({
    code:
      operation === "uninstall"
        ? CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED
        : CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    message: `CLI invocation state directory is not safe to hold a record for '${serviceLabel}'`,
    details: { label: serviceLabel, phase: "invocation-state-dir" },
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
    throw stateDirUnsafeError(serviceLabel, operation);
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
      throw stateDirUnsafeError(serviceLabel, operation);
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
    throw stateDirUnsafeError(serviceLabel, operation);
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
    await releaseOwnedTransaction(held);
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
      details: { label: options.serviceLabel, phase: "commit" },
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
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service '${options.serviceLabel}' was registered, but the lifecycle generation could not be written`,
      details: { label: options.serviceLabel, phase: "lifecycle" },
      exitCode: 1,
    });
  }
  await assertStateDirUnchanged(
    options.hostHomeDir,
    stateDirIdentity,
    options.serviceLabel,
    "install",
  );
  await releaseOwnedTransaction(held);
  await removeBestEffort(held.stalePath);
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
    await releaseOwnedTransaction(held);
    throw cause;
  }
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
  await assertStateDirUnchanged(
    options.hostHomeDir,
    stateDirIdentity,
    options.serviceLabel,
    "uninstall",
  );
  await removeBestEffort(held.livePath);
  await removeBestEffort(held.stalePath);
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
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED,
      message: `service '${options.serviceLabel}' was uninstalled, but the lifecycle generation could not be written`,
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
  const deadline = Date.now() + input.waitMs;
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
      const confirmed = (
        await observeTransactionMarkers(input.hostHomeDir)
      ).filter((entry) => !entry.abandoned);
      if (confirmed.length === 1 && confirmed[0]?.path === heldPath) {
        return held;
      }
      if (!confirmed.some((entry) => entry.path === heldPath)) {
        held = null;
      }
    }
    if (Date.now() >= deadline) {
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
    };
  }
}

function openFlagsForAuthorityRead(): number {
  if (process.platform === "win32") return constants.O_RDONLY;
  return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
}

/**
 * Read an authority file inside the state dir. A symlink is skip-not-live:
 * we do not follow it and we do not treat it as a live contender.
 */
async function readAuthorityUtf8(
  path: string,
): Promise<{ readonly raw: string; readonly mtimeMs: number } | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, openFlagsForAuthorityRead());
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return { raw: await handle.readFile("utf8"), mtimeMs: info.mtimeMs };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
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
      const read = await readAuthorityUtf8(path);
      // Skip-not-live: a planted symlink (O_NOFOLLOW/ELOOP) is not a
      // contender. A genuine marker is created with wx and is never a link.
      if (read === null) return null;
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
  return verdict === "dead" || verdict === "alive-different";
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
  const read = await readAuthorityUtf8(path);
  if (read === null) {
    try {
      await lstat(path);
      return false;
    } catch {
      return true;
    }
  }
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
      }),
    );
    await rename(temporary, held.lifecyclePath);
  } catch (cause) {
    await removeBestEffort(temporary);
    throw cause;
  }
}

async function markStaleAndUnpreferLive(held: HeldTransaction): Promise<void> {
  let staleWritten = false;
  try {
    await assertStateDirUnchanged(
      held.hostHomeDir,
      held.stateDirIdentity,
      held.serviceLabel,
      held.operation,
    );
    const temporary = `${held.stalePath}.${held.token}.tmp`;
    try {
      await writeExclusiveAuthorityFile(temporary, STALE_MARKER_BODY);
      await rename(temporary, held.stalePath);
      staleWritten = true;
    } catch (cause) {
      await removeBestEffort(temporary);
      throw cause;
    }
  } catch {
    // If the stale file cannot be written, keep the transaction marker:
    // presence of either marker is cache bypass. Never let marker I/O hide
    // the commit failure.
  }
  await removeBestEffort(held.livePath);
  await removeBestEffort(held.stagingPath);
  if (staleWritten) {
    await unlinkIfUnchanged(held.txnPath, held.rawMarker);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function liveRecordMatchesLabel(
  livePath: string,
  serviceLabel: string,
): Promise<"matching" | "absent" | "foreign"> {
  const read = await readAuthorityUtf8(livePath);
  if (read === null) return "absent";
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
