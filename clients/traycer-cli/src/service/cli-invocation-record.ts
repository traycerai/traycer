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
  CLI_INVOCATION_TRANSACTION_MARKER_DIGEST_BYTES,
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
  type CliInvocationLegacyMarkerEvidence,
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

// OSS writer for the host-owned invocation record. Schema lives in `@traycer/protocol/config`.
// Unreadable markers fail closed. Unlinks are compare-then-remove. Abandoned unique txn markers stay on disk.

const NODE_FAMILY_BASENAMES: ReadonlySet<string> = new Set([
  "node",
  "node.exe",
  "bun",
  "bun.exe",
]);

/** True when the OS accepted the registration before this error. Mutation-authority failures keep their identity via {@link markRegistrationCommitted}. */
export function didServiceRegistrationCommit(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    if (committedRegistrationFailures.has(error)) return true;
  }
  if (!(error instanceof CliError)) return false;
  return error.details?.registrationCommitted === true;
}

/** Mark without changing type or identity. */
export function markRegistrationCommitted<T>(error: T): T {
  if (typeof error === "object" && error !== null) {
    committedRegistrationFailures.add(error);
  }
  return error;
}

const committedRegistrationFailures = new WeakSet<object>();

export interface ServiceRegistrationRecordOptions {
  readonly environment: Environment;
  // Already-resolved host runtime home, including slotted `dev-runs/<slot>`. Never reconstructed from `~/.traycer` here.
  readonly hostHomeDir: string;
  readonly serviceLabel: string;
  readonly cli: CliInvocation;
  readonly register: () => Promise<void>;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

export interface ServiceRemovalRecordContext {
  readonly environment: Environment;
  readonly hostHomeDir: string;
  readonly serviceLabel: string;
}

export interface ServiceUninstallRecordOptions extends ServiceRemovalRecordContext {
  readonly uninstall: () => Promise<void>;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

export interface ServiceRemovalRecordOptions<
  T,
> extends ServiceRemovalRecordContext {
  /** Failure-message noun: uninstall path is `uninstalled`, competing-registration repair is `retired`. */
  readonly operation: "uninstalled" | "retired";
  readonly remove: () => Promise<T>;
  /** True invalidates the record as uninstall does. A partial removal counts as removed. */
  readonly removed: (result: T) => boolean;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

const PRODUCTION_TXN_WAIT_MS = 30_000;
const PRODUCTION_TXN_POLL_MS = 100;

export const CLI_INVOCATION_TXN_WAIT_MS = PRODUCTION_TXN_WAIT_MS;
export const CLI_INVOCATION_TXN_POLL_MS = PRODUCTION_TXN_POLL_MS;

export type CliInvocationTxnObservePause = () => Promise<void>;

let observePauseForTest: CliInvocationTxnObservePause | null = null;

/** Test-only acquire interleaving. Production never calls this. */
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

/** `details` carries the thrown errno; `null` when the rejection was an identity mismatch. */
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
    // Not a rollback: later-step throws leave earlier OS mutations in place, so the stale marker sends the host to the OS definition.
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
    // Record stays; stale marker is the durable substitute until a later confirmed transaction writes the generation.
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
    // Post-registration: honour the adoption lease. Do not write a marker into a directory that is no longer ours.
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
  // Clear an earlier stale marker before releasing; report a survivor so a clean install cannot leave hosts on the OS definition.
  const staleOutcome = await removeStaleMarkerIfOwn(held);
  // Abandoned residue and this owner's marker: confirmed gone or reported; never best-effort on a success path.
  const residue = await sweepAbandonedResidue(held);
  const release = await releaseOwnedTransaction(held);
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
  if (release === "retained" || residue.length > 0) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service '${options.serviceLabel}' was registered and its CLI invocation record committed, but a transaction marker could not be removed; the host re-reads the OS registration until a later service command clears it`,
      details: {
        label: options.serviceLabel,
        phase: "release",
        ownMarkerRetained: release === "retained",
        residue,
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
  await runServiceRemovalWithInvocationRecord<void>({
    environment: options.environment,
    hostHomeDir: options.hostHomeDir,
    serviceLabel: options.serviceLabel,
    operation: "uninstalled",
    remove: options.uninstall,
    removed: () => true,
    waitMs: options.waitMs,
    pollIntervalMs: options.pollIntervalMs,
  });
}

/** Invalidate the record exactly when `remove` took this label away, wholly or in part. */
export async function runServiceRemovalWithInvocationRecord<T>(
  options: ServiceRemovalRecordOptions<T>,
): Promise<T> {
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
  let result: T;
  try {
    result = await options.remove();
  } catch (cause) {
    // Backend may have removed the service before the throw, so unprefer the live record.
    logger.debug("OS uninstall threw; marking the cached invocation stale", {
      environment: options.environment,
      label: options.serviceLabel,
      errorName: errorFromUnknown(cause).name,
    });
    await markStaleAndUnpreferLive(held);
    throw cause;
  }
  if (!options.removed(result)) {
    // Nothing removed: only this owner's marker has to go, and confirmed.
    reportRetainedRelease(
      await releaseOwnedTransaction(held),
      options.serviceLabel,
    );
    return result;
  }
  // Identity before the label read, so classification is of the record in the directory this transaction validated.
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
    reportRetainedRelease(
      await releaseOwnedTransaction(held),
      options.serviceLabel,
    );
    return result;
  }
  // Again after the label compare: this is the compare half of
  // compare-then-unlink, and the identity must hold at the unlink too.
  await assertStateDirUnchangedAfterUninstall(held, options, stateDirIdentity);
  // Strict compare-then-unlink: a surviving own-label record is marked stale and the uninstall is failed, not clean.
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
      message: `service '${options.serviceLabel}' was ${options.operation}, but its CLI invocation record could not be removed; it was marked stale so it cannot be preferred`,
      details: { label: options.serviceLabel, phase: "record-remove" },
      exitCode: 1,
    });
  }
  // Best-effort here: with no record left, a surviving stale marker bypasses an empty cache until the next registration's strict clear.
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
    // Stale marker stops a host that latched the old generation from replaying the pre-uninstall answer.
    await markStaleKeepLive(held);
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED,
      message: `service '${options.serviceLabel}' was ${options.operation}, but the lifecycle generation could not be written; a stale marker was left so the cached invocation cannot be replayed`,
      details: { label: options.serviceLabel, phase: "lifecycle" },
      exitCode: 1,
    });
  }
  // Sweep abandoned residue now that the generation is written; every removal is confirmed or reported.
  const residue = await sweepAbandonedResidue(held);
  const release = await releaseOwnedTransaction(held);
  if (release === "retained" || residue.length > 0) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED,
      message: `service '${options.serviceLabel}' was ${options.operation} and its CLI invocation record removed, but a transaction marker could not be removed; the host re-reads the OS registration until a later service command clears it`,
      details: {
        label: options.serviceLabel,
        phase: "release",
        ownMarkerRetained: release === "retained",
        residue,
      },
      exitCode: 1,
    });
  }
  logger.debug("CLI invocation record removed after confirmed uninstall", {
    environment: options.environment,
    label: options.serviceLabel,
  });
  return result;
}

/** Record left as-is; only this owner's marker had to go, and it did not. Report rather than call the operation clean. */
function reportRetainedRelease(
  release: "released" | "retained",
  serviceLabel: string,
): void {
  if (release === "released") return;
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED,
    message: `service '${serviceLabel}': the CLI invocation record was left in place, but this command's transaction marker could not be removed; the host re-reads the OS registration until a later service command clears it`,
    details: {
      label: serviceLabel,
      phase: "release",
      ownMarkerRetained: true,
      residue: [],
    },
    exitCode: 1,
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
    // Exactly one argument for an interpreter: the absolute script. Anything else is declined, not re-interpreted.
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
  /** Legacy exact `cli-invocation.txn` as seen at election: digest, `none`, or `unreadable`. Never hashed as empty. */
  readonly legacyMarkerEvidence: CliInvocationLegacyMarkerEvidence;
  /** Abandoned unique contenders observed at election; swept after the lifecycle write, left in place on failure. */
  readonly abandonedResidue: readonly ObservedContender[];
}

interface ObservedContender {
  readonly basename: string;
  readonly path: string;
  readonly mtimeMs: number;
  /** File bytes the legacy-marker digest is taken over. Empty when `unreadable`. */
  readonly bytes: Buffer;
  /** `bytes` as UTF-8 text; empty when `unreadable`. Never digested. */
  readonly raw: string;
  readonly abandoned: boolean;
  /** Present but unreadable, kept apart from a readable empty file so the digest cannot match real bytes. */
  readonly unreadable: boolean;
}

async function acquireTransaction(input: {
  readonly hostHomeDir: string;
  readonly serviceLabel: string;
  readonly operation: CliInvocationTransactionOperation;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
  readonly stateDirIdentity: CliInvocationStateDirIdentity;
}): Promise<HeldTransaction> {
  // Deadline uses monotonic time so a backward wall-clock step cannot stretch it. Marker ages stay on wall time.
  const deadline = performance.now() + input.waitMs;
  let held: HeldTransaction | null = null;
  for (;;) {
    const observed = await observeTransactionMarkers(input.hostHomeDir);
    if (observePauseForTest !== null) {
      await observePauseForTest();
    }
    if (observed === null) {
      // A failed scan is retried with `held` untouched: this process may own a marker it could not list.
      if (performance.now() >= deadline) {
        await failAcquisition(input, held, "enumeration-failed");
      }
      await sleep(input.pollIntervalMs);
      continue;
    }
    // Abandoned contenders are elected around, never unlinked here. Sweep only after this owner's lifecycle write.
    const live = observed.filter((entry) => !entry.abandoned);
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
          // A loser confirms its own marker gone before dropping `held`; a surviving file would count as a second live contender.
          if (await unlinkIfUnchanged(held.txnPath, held.rawMarker)) {
            held = null;
          }
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
      // A failed confirmation scan (`null`) confirms nothing either way: the
      // marker stays held and the scan is retried on the next pass.
      const all = await observeTransactionMarkers(input.hostHomeDir);
      const confirmed = all?.filter((entry) => !entry.abandoned) ?? [];
      if (
        all !== null &&
        confirmed.length === 1 &&
        confirmed[0]?.path === heldPath
      ) {
        // The legacy exact marker is never unlinked; an abandoned one is residue this transaction is about to supersede.
        const legacy = all.find(
          (entry) =>
            entry.basename === CLI_INVOCATION_RECORD_TXN_FILENAME &&
            entry.abandoned,
        );
        return {
          ...held,
          legacyMarkerEvidence:
            legacy === undefined
              ? { kind: "none" }
              : legacy.unreadable
                ? { kind: "unreadable" }
                : {
                    kind: "digest",
                    digest: cliInvocationTransactionMarkerDigest(legacy.bytes),
                  },
          abandonedResidue: all.filter(
            (entry) =>
              entry.abandoned &&
              entry.basename !== CLI_INVOCATION_RECORD_TXN_FILENAME,
          ),
        };
      }
      if (all !== null && !confirmed.some((entry) => entry.path === heldPath)) {
        held = null;
      }
    }
    if (performance.now() >= deadline) {
      await failAcquisition(input, held, "busy");
    }
    await sleep(input.pollIntervalMs);
  }
}

/** Reported, not assumed: a marker this process could not remove stays live until the process exits. */
async function failAcquisition(
  input: {
    readonly operation: CliInvocationTransactionOperation;
    readonly serviceLabel: string;
  },
  held: HeldTransaction | null,
  cause: "busy" | "enumeration-failed",
): Promise<never> {
  const ownMarkerRetained =
    held !== null && !(await unlinkIfUnchanged(held.txnPath, held.rawMarker));
  const retainedSuffix = ownMarkerRetained
    ? ", and this command's own transaction marker could not be removed; it stops blocking election when this process exits and is reclaimed by a later successful CLI service command"
    : "";
  throw cliError({
    code:
      input.operation === "uninstall"
        ? CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED
        : CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    message:
      cause === "busy"
        ? `another CLI service ${input.operation} is already in progress for '${input.serviceLabel}'${retainedSuffix}`
        : `could not list the CLI invocation transaction markers for '${input.serviceLabel}' before the deadline${retainedSuffix}`,
    details: {
      label: input.serviceLabel,
      phase: cause === "busy" ? "txn-busy" : "txn-enumerate",
      ownMarkerRetained,
    },
    exitCode: 75,
  });
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
      legacyMarkerEvidence: { kind: "none" },
      abandonedResidue: [],
    };
  }
}

function openFlagsForAuthorityRead(): number {
  if (process.platform === "win32") return constants.O_RDONLY;
  return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
}

/** `unreadable` is not `absent`: collapsing them let a second CLI elect while the first's marker was locked. Fail closed. */
type AuthorityRead =
  | {
      readonly kind: "ok";
      /** The file's bytes, as read. What a digest is taken over. */
      readonly bytes: Buffer;
      /** `bytes` decoded as UTF-8, for the parsers and the compare-then-unlink. */
      readonly raw: string;
      readonly mtimeMs: number;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "not-a-file" }
  | { readonly kind: "unreadable"; readonly mtimeMs: number | null };

/** Enough for the largest document this module parses and for the digest prefix the protocol helper hashes. */
const AUTHORITY_FILE_READ_BOUND_BYTES = Math.max(
  CLI_INVOCATION_RECORD_MAX_SERIALIZED_BYTES,
  CLI_INVOCATION_TRANSACTION_MARKER_DIGEST_BYTES,
);

async function readAuthorityFile(path: string): Promise<AuthorityRead> {
  let handle: FileHandle;
  try {
    handle = await open(path, openFlagsForAuthorityRead());
  } catch (cause) {
    const code = isErrnoException(cause) ? cause.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    // `O_NOFOLLOW` refuses a symlink with ELOOP. Windows EISDIR on a directory is the same not-a-marker answer, not unreadable.
    if (code === "ELOOP" || code === "EISDIR") return { kind: "not-a-file" };
    return { kind: "unreadable", mtimeMs: await lstatMtimeMs(path) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "not-a-file" };
    // Bounded, never `readFile()`: an oversized legacy marker must still yield a digest the host can discharge.
    const bytes = await readAuthorityBytes(handle, info.size);
    if (bytes === null) {
      return { kind: "unreadable", mtimeMs: info.mtimeMs };
    }
    return {
      kind: "ok",
      bytes,
      raw: bytes.toString("utf8"),
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return { kind: "unreadable", mtimeMs: await lstatMtimeMs(path) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Loop until `size` is filled or EOF. Within bound, ask for one extra byte and require exactly `size`; a grow/shrink is `unreadable`. */
async function readAuthorityBytes(
  handle: FileHandle,
  size: number,
): Promise<Buffer | null> {
  const oversize = size > AUTHORITY_FILE_READ_BOUND_BYTES;
  const wanted = oversize ? AUTHORITY_FILE_READ_BOUND_BYTES : size;
  const capacity = oversize ? wanted : wanted + 1;
  const buffer = Buffer.alloc(capacity);
  let filled = 0;
  while (filled < capacity) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      capacity - filled,
      filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === wanted ? buffer.subarray(0, wanted) : null;
}

async function lstatMtimeMs(path: string): Promise<number | null> {
  try {
    return (await lstat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** `null` vs `[]`: a failed `readdir` is not empty; treating it as empty dropped `held` while the marker still blocked. */
async function observeTransactionMarkers(
  hostHomeDir: string,
): Promise<ObservedContender[] | null> {
  const stateDir = cliInvocationStateDir(hostHomeDir);
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (cause: unknown) {
    if (isErrnoException(cause) && cause.code === "ENOENT") return [];
    return null;
  }
  const observed = await Promise.all(
    names.filter(isCliInvocationTransactionMarkerBasename).map(async (name) => {
      const path = join(stateDir, name);
      const read = await readAuthorityFile(path);
      // Skip-not-live: a planted symlink (O_NOFOLLOW/ELOOP) is not a
      // contender. A genuine marker is created with wx and is never a link.
      if (read.kind === "absent" || read.kind === "not-a-file") return null;
      if (read.kind === "unreadable") {
        // An unreadable marker blocks like a live one. Empty `raw` means nothing here removes a file whose contents it never saw.
        const mtimeMs = read.mtimeMs ?? Date.now();
        return {
          basename: name,
          path,
          mtimeMs,
          bytes: Buffer.alloc(0),
          raw: "",
          abandoned: cliInvocationTransactionAbandonedByAge(
            mtimeMs,
            Date.now(),
          ),
          unreadable: true,
        };
      }
      return {
        basename: name,
        path,
        mtimeMs: read.mtimeMs,
        bytes: read.bytes,
        raw: read.raw,
        abandoned: await isAbandonedContender(name, read.raw, read.mtimeMs),
        unreadable: false,
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
  // `indeterminate`: pid alive but no start identity. Age window applies; a positively alive parsed owner is never aged out.
  return cliInvocationTransactionAbandonedByAge(
    Number.isFinite(Date.parse(marker.startedAt))
      ? Math.max(Date.parse(marker.startedAt), mtimeMs)
      : mtimeMs,
    Date.now(),
  );
}

/** Sweep abandoned unique contenders only after this owner's lifecycle write. The legacy exact path is never unlinked. */
async function sweepAbandonedResidue(held: HeldTransaction): Promise<string[]> {
  const survivors: string[] = [];
  for (const entry of held.abandonedResidue) {
    if (entry.basename === CLI_INVOCATION_RECORD_TXN_FILENAME) continue;
    if (!(await unlinkIfUnchanged(entry.path, entry.raw))) {
      survivors.push(entry.basename);
    }
  }
  // A legacy exact marker this owner could not read is a survivor too: `unreadable` never discharges.
  if (held.legacyMarkerEvidence.kind === "unreadable") {
    survivors.push(CLI_INVOCATION_RECORD_TXN_FILENAME);
  }
  return survivors;
}

/** `true` only when the file is gone afterwards. `removeBestEffort` can swallow a Windows sharing violation. */
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
  return confirmAbsent(path);
}

/** Poll briefly: Windows pending-delete reports access denied until the handle closes. */
async function confirmAbsent(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < REMOVAL_CONFIRM_ATTEMPTS; attempt += 1) {
    if ((await readAuthorityFile(path)).kind === "absent") return true;
    await sleep(REMOVAL_CONFIRM_INTERVAL_MS);
  }
  return (await readAuthorityFile(path)).kind === "absent";
}

const REMOVAL_CONFIRM_ATTEMPTS = 5;
const REMOVAL_CONFIRM_INTERVAL_MS = 20;

/** `retained` when the marker could not be confirmed gone; success paths report it. */
async function releaseOwnedTransaction(
  held: HeldTransaction,
): Promise<"released" | "retained"> {
  await removeBestEffort(held.stagingPath);
  return (await unlinkIfUnchanged(held.txnPath, held.rawMarker))
    ? "released"
    : "retained";
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
    // Inside the cleanup boundary: a close that rejects must still remove the exclusive file this process created.
    await handle.close();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await removeBestEffort(path);
    throw cause;
  }
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
  // Unique per owner token so two processes cannot share a temp name. Txn stays held until this rename succeeds.
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
        // Written as observed, `none` and `unreadable` included: `none` never discharges by clock and `unknown` may.
        legacyMarkerEvidence: held.legacyMarkerEvidence,
      }),
    );
    await rename(temporary, held.lifecyclePath);
  } catch (cause) {
    await removeBestEffort(temporary);
    throw cause;
  }
}

/** `false` when it could not be written; the caller keeps its transaction marker so marker I/O cannot hide the failure. */
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

/** Commit-failure/OS-throw: unprefer and remove the live record after its label matched. */
async function markStaleAndUnpreferLive(held: HeldTransaction): Promise<void> {
  const staleWritten = await writeStaleMarker(held);
  if (
    (await liveRecordMatchesLabel(held.livePath, held.serviceLabel)) ===
    "matching"
  ) {
    // Identity re-check as the last thing before unlink, after the label compare, so the window is one syscall wide.
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

/** A surviving own-label record after uninstall is unpreferred and removed; report failed rather than clean. */
async function assertStateDirUnchangedAfterUninstall(
  held: HeldTransaction,
  options: ServiceRemovalRecordContext,
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

/** On disk is correct but must not be preferred until a later transaction confirms it. */
async function markStaleKeepLive(held: HeldTransaction): Promise<void> {
  const staleWritten = await writeStaleMarker(held);
  await removeBestEffort(held.stagingPath);
  if (staleWritten) {
    await unlinkIfUnchanged(held.txnPath, held.rawMarker);
  }
}

type StaleMarkerRemoval = "removed" | "absent" | "foreign" | "failed";

/** Compare on label via `O_NOFOLLOW`. A symlink/FIFO/directory at the name is `absent`, not `failed`. */
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
  } catch {
    return "failed";
  }
  // Confirmed: a stale marker still answering at the pathname (Windows pending-delete) still bypasses the committed record.
  return (await confirmAbsent(held.stalePath)) ? "removed" : "failed";
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `unreadable` is not `absent`: an unreadable record cannot be confirmed removed and must be marked stale. */
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
