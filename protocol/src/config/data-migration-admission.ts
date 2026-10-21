import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { link, mkdir, open, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { breakStaleLock } from "./credentials-lock";
import {
  canonicalJson,
  componentHandshakeSchema,
  incompatibleHandshakes,
  phaseIsTerminal,
  type ComponentHandshake,
  type CoordinatorIncarnation,
  type HandshakeBlocker,
  type MaintenanceOperation,
  type MaintenanceRequest,
  type MigrationJournal,
  type MigrationPhase,
} from "./data-migration-contracts";
import {
  evaluateStartupGate,
  readMigrationJournalSync,
  readMigrationSelectorSync,
  writeFileAtomic,
  writeMigrationJournal,
  writeMigrationSelector,
  type HeldBootstrapSerialization,
  type StartupGateDecision,
  type StartupGateInput,
} from "./data-bootstrap-records";
import type { DataRootPlatform, DataRootResolution } from "./data-root";
import { readRegularFileBytesNoFollowSync } from "./host-update-attempt-fs";
import {
  composeAttemptHolderVerdict,
  type AttemptHolderLivenessVerdict,
  type AttemptHolderProcessLiveness,
} from "./host-update-attempt-liveness";
import type {
  ObservedProcessStart,
  ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle/process-start-identity";

/**
 * Process admission against the data-migration startup barrier, and the
 * coordinator lock that serializes migrate / recover / cleanup.
 *
 * Two controls (design: "Safety boundaries"):
 *
 * - `migration-coordinator.lock`: held by the one coordinator for the whole
 *   command. Taken over only on PROOF that the recorded incarnation exited
 *   (pid gone, or the pid now names a different process) - never on age.
 * - The startup barrier: the active journal's phase (`data-bootstrap-records`
 *   `evaluateStartupGate`). It survives coordinator death.
 *
 * Every participating process (Desktop main, the CLI, the host) ADMITS
 * itself before opening writable state: under `admission.lock` it checks the
 * gate, writes `admission-<entryId>.json` naming its pid, kernel start
 * identity, location generation and component handshake, then checks the
 * gate AGAIN. The coordinator moves the journal into a barrier phase under
 * the same mutex and only then lists entries. Because each side writes its
 * own fact before reading the other's, a registrant and the coordinator can
 * never both miss each other - even if a stuck mutex holder was overtaken -
 * so no process passes an unchecked gap: it is either listed (and must be
 * drained) or refused.
 *
 * Entries are reaped only on proof (`dead`, or `alive-different` - a
 * recycled pid). An entry whose liveness cannot be established is reported
 * as ambiguous and blocks the migration with diagnostics. Reaping only
 * deletes; it never admits anyone. Every file is flat in the bootstrap
 * folder.
 *
 * OS process reads differ per side (the host cannot import
 * `@traycer-clients/shared`), so callers inject a {@link ProcessIncarnationProbe}
 * built from their own process-identity readers; the decision rules live
 * here once.
 */

export const MIGRATION_COORDINATOR_LOCK_FILENAME = "migration-coordinator.lock";
export const ADMISSION_MUTEX_FILENAME = "admission.lock";
const ADMISSION_ENTRY_PATTERN = /^admission-([0-9a-f-]{36})\.json$/u;

/**
 * The admission mutex guards a few small file operations. A holder older than
 * this is overtaken even if its pid still answers: correctness never rested
 * on the mutex (see the write-then-recheck ordering above), and a startup
 * must not wedge behind a pid the OS recycled.
 */
export const ADMISSION_MUTEX_MAX_HOLD_MS = 30_000;
const ADMISSION_MUTEX_POLL_MS = 25;

/** The OS reads a side provides; the verdict vocabulary is the protocol's. */
export interface ProcessIncarnationProbe {
  /** This process's kernel start identity, or null when it cannot be read. */
  ownStartIdentity(): Promise<ProcessStartIdentity | null>;
  liveness(pid: number): Promise<"alive" | "dead" | "indeterminate">;
  verdict(
    pid: number,
    recorded: ProcessStartIdentity | null,
  ): Promise<AttemptHolderLivenessVerdict>;
}

/**
 * The `verdict` both sides' probes give, over their own OS reads:
 * {@link composeAttemptHolderVerdict} of one liveness read and one identity
 * read, with ONE exception.
 *
 * Liveness answered `alive`, an identity is recorded, and the identity read
 * came back with nothing. On Windows that is a pid the OS handed to a
 * short-lived process that exited between the two reads (`Get-Process` and
 * the WMI fallback both find nothing), and it read as `indeterminate`, so a
 * stale entry of a crashed process blocked a migration at random. Liveness
 * is read once more: `dead` then is positive proof no process runs at that
 * pid, so the recorded one cannot. Any other second answer keeps the
 * composed verdict. Nothing else changes: an `indeterminate` first liveness
 * still consults identity, and an identity read that answered is never
 * overridden.
 */
export async function composeIncarnationVerdict(input: {
  readonly pid: number;
  readonly recorded: ProcessStartIdentity | null;
  readonly liveness: (pid: number) => Promise<AttemptHolderProcessLiveness>;
  readonly observe: (
    pid: number,
    recorded: ProcessStartIdentity,
  ) => Promise<ObservedProcessStart | null>;
}): Promise<AttemptHolderLivenessVerdict> {
  const { pid, recorded } = input;
  const liveness = await input.liveness(pid);
  if (liveness === "dead" || recorded === null) {
    return composeAttemptHolderVerdict(liveness, recorded, null);
  }
  const observed = await input.observe(pid, recorded);
  if (
    liveness === "alive" &&
    observed === null &&
    (await input.liveness(pid)) === "dead"
  ) {
    return "dead";
  }
  return composeAttemptHolderVerdict(liveness, recorded, observed);
}

export type MigrationAdmissionErrorCode =
  | "startup-blocked"
  | "bootstrap-unusable"
  | "admission-busy"
  | "coordinator-not-held"
  | "migration-active"
  | "record-damaged";

/** Messages carry no paths or account identifiers. */
export class MigrationAdmissionError extends Error {
  readonly code: MigrationAdmissionErrorCode;
  readonly decision: StartupGateDecision | null;

  constructor(
    code: MigrationAdmissionErrorCode,
    message: string,
    decision: StartupGateDecision | null,
  ) {
    super(message);
    this.name = "MigrationAdmissionError";
    this.code = code;
    this.decision = decision;
  }
}

// ---- Lock files -------------------------------------------------------------

const lockHolderSchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(1),
    purpose: z.enum(["coordinator", "admission"]),
    pid: z.number().int().positive(),
    startIdentity: z.string().min(1).nullable(),
    nonce: z.string().min(1),
    acquiredAt: z.number().int().nonnegative(),
  }),
);
export type BootstrapLockHolder = z.infer<typeof lockHolderSchema>;

type LockRead =
  | { readonly kind: "gone" }
  | { readonly kind: "corrupt"; readonly raw: string }
  | {
      readonly kind: "held";
      readonly raw: string;
      readonly holder: BootstrapLockHolder;
    };

function readLockFileSync(path: string): LockRead {
  const read = readRegularFileBytesNoFollowSync(path);
  if (read.kind === "absent") return { kind: "gone" };
  if (read.kind === "not-regular") return { kind: "corrupt", raw: "" };
  const raw = read.bytes.toString("utf8");
  try {
    return {
      kind: "held",
      raw,
      holder: lockHolderSchema.parse(JSON.parse(raw)),
    };
  } catch {
    return { kind: "corrupt", raw };
  }
}

/**
 * Create the lock fully populated: a flushed temp file hard-linked into
 * place, which fails with EEXIST when the lock exists. A lock is therefore
 * never observed empty or half-written.
 */
async function tryCreateLock(
  path: string,
  holder: BootstrapLockHolder,
): Promise<boolean> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(holder), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(tmp, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}

async function releaseLockIfOwned(path: string, nonce: string): Promise<void> {
  const current = readLockFileSync(path);
  if (current.kind !== "held" || current.holder.nonce !== nonce) return;
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** Ensure the bootstrap folder exists as a plain folder; never follows links. */
async function ensureBootstrapDirExists(bootstrapDir: string): Promise<void> {
  try {
    await mkdir(bootstrapDir, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const stats = lstatSync(bootstrapDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new MigrationAdmissionError(
      "bootstrap-unusable",
      "Traycer's bootstrap folder (~/.traycer-bootstrap) is not a plain folder.",
      null,
    );
  }
}

// ---- Coordinator lock -------------------------------------------------------

/**
 * Also the {@link HeldBootstrapSerialization} every selector, journal and
 * location writer requires.
 */
export interface MigrationCoordinatorLock extends HeldBootstrapSerialization {
  readonly incarnation: CoordinatorIncarnation;
  /** Throws `coordinator-not-held` unless the lock file still carries this holder. */
  assertHeld(): void;
  release(): Promise<void>;
}

export type CoordinatorLockResult =
  | { readonly acquired: true; readonly lock: MigrationCoordinatorLock }
  | {
      readonly acquired: false;
      /**
       * `held`: a live coordinator holds it. `ambiguous`: its liveness cannot
       * be established - never taken over. `corrupt`: unreadable lock bytes -
       * never taken over by age. `identity-unavailable`: this process cannot
       * read its own start identity, so it could not be verified as holder.
       */
      readonly reason:
        | "held"
        | "ambiguous"
        | "corrupt"
        | "identity-unavailable";
      readonly holder: BootstrapLockHolder | null;
    };

/**
 * One attempt to become the migration coordinator. A recorded holder is
 * overtaken only when proven gone. The caller (migrate/recover/cleanup)
 * reports anything else to the user rather than waiting.
 */
export async function acquireMigrationCoordinatorLock(input: {
  readonly bootstrapDir: string;
  readonly probe: ProcessIncarnationProbe;
}): Promise<CoordinatorLockResult> {
  await ensureBootstrapDirExists(input.bootstrapDir);
  const startIdentity = await input.probe.ownStartIdentity();
  if (startIdentity === null) {
    return { acquired: false, reason: "identity-unavailable", holder: null };
  }
  const path = join(input.bootstrapDir, MIGRATION_COORDINATOR_LOCK_FILENAME);
  const holder: BootstrapLockHolder = {
    version: 1,
    purpose: "coordinator",
    pid: process.pid,
    startIdentity,
    nonce: randomUUID(),
    acquiredAt: Date.now(),
  };
  // Bounded: each pass either acquires, breaks a proven-dead holder (then
  // retries), or returns.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await tryCreateLock(path, holder)) {
      return { acquired: true, lock: coordinatorLockHandle(path, holder) };
    }
    const current = readLockFileSync(path);
    if (current.kind === "gone") continue;
    if (current.kind === "corrupt") {
      return { acquired: false, reason: "corrupt", holder: null };
    }
    const verdict = await input.probe.verdict(
      current.holder.pid,
      current.holder.startIdentity,
    );
    if (verdict === "alive-same") {
      return { acquired: false, reason: "held", holder: current.holder };
    }
    if (verdict === "indeterminate") {
      return { acquired: false, reason: "ambiguous", holder: current.holder };
    }
    await breakStaleLock(path, current.raw);
  }
  return { acquired: false, reason: "held", holder: null };
}

function coordinatorLockHandle(
  path: string,
  holder: BootstrapLockHolder,
): MigrationCoordinatorLock {
  const incarnation: CoordinatorIncarnation = {
    pid: holder.pid,
    startIdentity: holder.startIdentity,
    lockNonce: holder.nonce,
  };
  return {
    incarnation,
    assertHeld: () => {
      const current = readLockFileSync(path);
      if (current.kind !== "held" || current.holder.nonce !== holder.nonce) {
        throw new MigrationAdmissionError(
          "coordinator-not-held",
          "This process no longer holds the Traycer data migration lock.",
          null,
        );
      }
    },
    release: () => releaseLockIfOwned(path, holder.nonce),
  };
}

// ---- Admission mutex --------------------------------------------------------

/**
 * Run `fn` holding `admission.lock`. Waits up to `waitMs` for a live holder;
 * overtakes a holder whose pid is proven gone or that has held it longer than
 * {@link ADMISSION_MUTEX_MAX_HOLD_MS}.
 */
export async function withAdmissionMutex<T>(input: {
  readonly bootstrapDir: string;
  readonly probe: ProcessIncarnationProbe;
  readonly waitMs: number;
  readonly fn: () => Promise<T>;
}): Promise<T> {
  await ensureBootstrapDirExists(input.bootstrapDir);
  const path = join(input.bootstrapDir, ADMISSION_MUTEX_FILENAME);
  const holder: BootstrapLockHolder = {
    version: 1,
    purpose: "admission",
    pid: process.pid,
    startIdentity: null,
    nonce: randomUUID(),
    acquiredAt: Date.now(),
  };
  const deadline = Date.now() + Math.max(0, input.waitMs);
  for (;;) {
    if (await tryCreateLock(path, { ...holder, acquiredAt: Date.now() })) break;
    const current = readLockFileSync(path);
    if (current.kind === "gone") continue;
    // Only a clean removal retries at once; a break that could not complete
    // (a denied rename, a Windows sharing violation) falls through to the
    // bounded wait, as in the credentials lock.
    if (
      (await admissionHolderOvertakable(current, path, input.probe)) &&
      (await breakStaleLock(path, current.raw)) === "removed"
    ) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new MigrationAdmissionError(
        "admission-busy",
        "Another Traycer process is starting; try again in a moment.",
        null,
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, ADMISSION_MUTEX_POLL_MS),
    );
  }
  try {
    return await input.fn();
  } finally {
    await releaseLockIfOwned(path, holder.nonce);
  }
}

async function admissionHolderOvertakable(
  current: Exclude<LockRead, { kind: "gone" }>,
  path: string,
  probe: ProcessIncarnationProbe,
): Promise<boolean> {
  const ageMs =
    current.kind === "held"
      ? Date.now() - current.holder.acquiredAt
      : Date.now() - fileMtimeMs(path);
  if (ageMs >= ADMISSION_MUTEX_MAX_HOLD_MS) return true;
  return (
    current.kind === "held" &&
    (await probe.liveness(current.holder.pid)) === "dead"
  );
}

// ---- Admission entries ------------------------------------------------------

export const admissionEntrySchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(1),
    entryId: z.string().regex(/^[0-9a-f-]{36}$/u),
    pid: z.number().int().positive(),
    /** Null until the process has read its own start identity. */
    startIdentity: z.string().min(1).nullable(),
    handshake: componentHandshakeSchema,
    /** The location generation admitted under; null for the implicit default root. */
    generation: z.number().int().positive().nullable(),
    admittedAt: z.string().min(1),
  }),
);
export type AdmissionEntry = z.infer<typeof admissionEntrySchema>;

function admissionEntryPath(bootstrapDir: string, entryId: string): string {
  return join(bootstrapDir, `admission-${entryId}.json`);
}

export interface MigrationAdmission {
  readonly entryId: string;
  readonly generation: number | null;
  readonly handshake: ComponentHandshake;
  /**
   * The gate input this process was admitted under, for a launch boundary in
   * another realm (a worker thread) that cannot see this module's state.
   */
  readonly gateInput: StartupGateInput;
  /** The gate as this process sees it now, bound to the resolution it started with. */
  checkOpen(): StartupGateDecision;
  /** Remove this process's entry. Idempotent; a crash leaves it for proven-death reaping. */
  release(): Promise<void>;
}

export type AdmissionResult =
  | { readonly kind: "admitted"; readonly admission: MigrationAdmission }
  | {
      readonly kind: "refused";
      readonly decision: Extract<StartupGateDecision, { kind: "blocked" }>;
    };

let currentAdmission: MigrationAdmission | null = null;

/** This process's admission, once {@link admitProcess} succeeded. */
export function currentMigrationAdmission(): MigrationAdmission | null {
  return currentAdmission;
}

/**
 * Admit this process before it opens any writable runtime state. On refusal
 * nothing is written - not even the bootstrap folder. `identityWaitMs`
 * bounds how long registration waits for this process's start identity; a
 * short-lived command passes 0 and the entry is completed in the background
 * (an entry without identity whose pid is alive reads as ambiguous to the
 * coordinator, the safe direction).
 */
export async function admitProcess(input: {
  readonly homeDir: string;
  readonly platform: DataRootPlatform;
  readonly processResolution: DataRootResolution;
  readonly handshake: ComponentHandshake;
  readonly probe: ProcessIncarnationProbe;
  readonly mutexWaitMs: number;
  readonly identityWaitMs: number;
}): Promise<AdmissionResult> {
  const gateInput: StartupGateInput = {
    homeDir: input.homeDir,
    platform: input.platform,
    processResolution: input.processResolution,
  };
  const gate = (): StartupGateDecision => evaluateStartupGate(gateInput);
  const first = gate();
  if (first.kind === "blocked") return { kind: "refused", decision: first };

  const bootstrapDir = input.processResolution.bootstrapDir;
  const entryId = randomUUID();
  const path = admissionEntryPath(bootstrapDir, entryId);
  const identityRead = input.probe.ownStartIdentity().catch(() => null);
  const startIdentity = await withinMs(identityRead, input.identityWaitMs);
  const entry: AdmissionEntry = {
    version: 1,
    entryId,
    pid: process.pid,
    startIdentity,
    handshake: input.handshake,
    generation: first.generation,
    admittedAt: new Date().toISOString(),
  };

  const outcome = await withAdmissionMutex({
    bootstrapDir,
    probe: input.probe,
    waitMs: input.mutexWaitMs,
    fn: async (): Promise<StartupGateDecision> => {
      const checked = gate();
      if (checked.kind === "blocked") return checked;
      await writeFileAtomic(path, `${JSON.stringify(entry)}\n`);
      // Write-then-recheck: see the module comment.
      const rechecked = gate();
      if (rechecked.kind === "blocked") await rm(path, { force: true });
      return rechecked;
    },
  });
  if (outcome.kind === "blocked") return { kind: "refused", decision: outcome };

  let released = false;
  // A crash leaves the entry for proven-death reaping; an orderly exit
  // (including `process.exit`) removes it synchronously.
  const removeOnExit = (): void => {
    rmSync(path, { force: true });
  };
  process.once("exit", removeOnExit);
  const completion =
    startIdentity !== null
      ? Promise.resolve()
      : identityRead.then(async (identity) => {
          if (identity === null || released) return;
          await writeFileAtomic(
            path,
            `${JSON.stringify({ ...entry, startIdentity: identity })}\n`,
          );
          if (released) await rm(path, { force: true });
        });
  const admission: MigrationAdmission = {
    entryId,
    generation: first.generation,
    handshake: input.handshake,
    gateInput,
    checkOpen: gate,
    release: async () => {
      released = true;
      process.removeListener("exit", removeOnExit);
      if (currentAdmission === admission) currentAdmission = null;
      await completion.catch(() => undefined);
      await rm(path, { force: true });
    },
  };
  currentAdmission = admission;
  return { kind: "admitted", admission };
}

/**
 * The spawn/writer guard: before starting work that writes the data root
 * (a provider install, an agent or terminal child, an update helper), an
 * admitted process re-checks the gate. Throws `startup-blocked` once a
 * migration barrier is up or the root changed under this process. A process
 * that never admitted (a unit test, a tool outside the participant set) is
 * not gated here; participants admit at startup.
 */
export function assertMigrationAdmissionOpen(): void {
  const admission = currentAdmission;
  if (admission === null) return;
  const decision = admission.checkOpen();
  if (decision.kind === "blocked") {
    throw new MigrationAdmissionError(
      "startup-blocked",
      decision.message,
      decision,
    );
  }
}

// ---- Survey and drain (coordinator side) -----------------------------------

export type AdmittedProcessState =
  /** Same incarnation still running: must be stopped before copying. */
  | "running"
  /** Proven gone: reaped. */
  | "exited"
  /** The pid now names another process: reaped. */
  | "recycled"
  /** Liveness or identity could not be established: blocks with diagnostics. */
  | "ambiguous"
  /** The entry file is not a readable entry: blocks with diagnostics. */
  | "unreadable";

export interface AdmittedProcessReport {
  readonly entryId: string;
  readonly entry: AdmissionEntry | null;
  readonly state: AdmittedProcessState;
}

export interface AdmissionSurvey {
  readonly processes: readonly AdmittedProcessReport[];
  /** True when nothing remains that could still write. */
  readonly drained: boolean;
  /** Running participants whose protocol differs from this binary's. */
  readonly handshakeBlockers: readonly HandshakeBlocker[];
}

/**
 * Classify every admission entry. With `reap`, entries proven gone are
 * deleted (only those: reaping never admits anyone). Read-only status passes
 * `reap: false`.
 */
export async function surveyAdmittedProcesses(input: {
  readonly bootstrapDir: string;
  readonly probe: ProcessIncarnationProbe;
  readonly reap: boolean;
}): Promise<AdmissionSurvey> {
  const processes: AdmittedProcessReport[] = [];
  // The surveying process's own entry (the coordinator's CLI invocation) is
  // the authority doing the draining, not a writer to drain.
  const ownEntryId = currentAdmission?.entryId ?? null;
  for (const entryId of listAdmissionEntryIds(input.bootstrapDir)) {
    if (entryId === ownEntryId) continue;
    const path = admissionEntryPath(input.bootstrapDir, entryId);
    const entry = readAdmissionEntry(path);
    if (entry === "gone") continue;
    if (entry === null) {
      processes.push({ entryId, entry: null, state: "unreadable" });
      continue;
    }
    const state = stateOf(
      await input.probe.verdict(entry.pid, entry.startIdentity),
    );
    if (input.reap && (state === "exited" || state === "recycled")) {
      await rm(path, { force: true });
    }
    processes.push({ entryId, entry, state });
  }
  const live = processes.filter((report) => report.state === "running");
  return {
    processes,
    drained: processes.every(
      (report) => report.state === "exited" || report.state === "recycled",
    ),
    handshakeBlockers: incompatibleHandshakes(
      live.flatMap((report) =>
        report.entry === null ? [] : [report.entry.handshake],
      ),
    ),
  };
}

function stateOf(verdict: AttemptHolderLivenessVerdict): AdmittedProcessState {
  switch (verdict) {
    case "alive-same":
      return "running";
    case "dead":
      return "exited";
    case "alive-different":
      return "recycled";
    case "indeterminate":
      return "ambiguous";
  }
}

function listAdmissionEntryIds(bootstrapDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(bootstrapDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  return names.flatMap((name) => {
    const match = ADMISSION_ENTRY_PATTERN.exec(name);
    return match === null ? [] : [match[1]];
  });
}

function readAdmissionEntry(path: string): AdmissionEntry | null | "gone" {
  try {
    const read = readRegularFileBytesNoFollowSync(path);
    if (read.kind === "absent") return "gone";
    if (read.kind === "not-regular") return null;
    const parsed = admissionEntrySchema.safeParse(
      JSON.parse(read.bytes.toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---- Journal changes (coordinator side) ------------------------------------

/**
 * Start a transaction: write its planned journal (revision 1), then select
 * it as active. Refused while another transaction is active and not
 * terminal. A crash between the two writes leaves an unselected planned
 * journal, which holds no barrier and is kept as history.
 */
export async function beginMigrationJournal(input: {
  readonly bootstrapDir: string;
  readonly coordinator: MigrationCoordinatorLock;
  readonly journal: MigrationJournal;
}): Promise<void> {
  input.coordinator.assertHeld();
  assertCoordinatorRecorded(input.journal, input.coordinator);
  const selector = readMigrationSelectorSync(input.bootstrapDir);
  if (selector.kind === "damaged") {
    throw new MigrationAdmissionError(
      "record-damaged",
      `Traycer's data migration record is damaged (${selector.reason}). Run \`traycer data recover\`.`,
      null,
    );
  }
  const current = selector.kind === "valid" ? selector.record : null;
  if (current?.activeMigrationId != null) {
    const active = readMigrationJournalSync(
      input.bootstrapDir,
      current.activeMigrationId,
    );
    if (active.kind !== "valid" || !phaseIsTerminal(active.record.phase)) {
      throw new MigrationAdmissionError(
        "migration-active",
        "A Traycer data migration is already in progress. Run `traycer data status`.",
        null,
      );
    }
  }
  await writeMigrationJournal(
    input.bootstrapDir,
    input.coordinator,
    null,
    input.journal,
  );
  await writeMigrationSelector(input.bootstrapDir, input.coordinator, current, {
    version: 1,
    revision: (current?.revision ?? 0) + 1,
    activeMigrationId: input.journal.id,
  });
}

/**
 * Persist the next journal revision of the ACTIVE transaction, under the
 * admission mutex so a phase change into (or out of) the barrier is ordered
 * against every registration. The phase table and activation boundary are
 * enforced by `writeMigrationJournal`. After moving into a barrier phase the
 * coordinator lists entries with {@link surveyAdmittedProcesses}.
 */
export async function advanceMigrationJournal(input: {
  readonly bootstrapDir: string;
  readonly coordinator: MigrationCoordinatorLock;
  readonly probe: ProcessIncarnationProbe;
  readonly expected: MigrationJournal;
  readonly next: MigrationJournal;
}): Promise<void> {
  input.coordinator.assertHeld();
  assertCoordinatorRecorded(input.next, input.coordinator);
  const selector = readMigrationSelectorSync(input.bootstrapDir);
  if (
    selector.kind !== "valid" ||
    selector.record.activeMigrationId !== input.next.id
  ) {
    throw new MigrationAdmissionError(
      "migration-active",
      "This journal is not the active Traycer data migration.",
      null,
    );
  }
  await withAdmissionMutex({
    bootstrapDir: input.bootstrapDir,
    probe: input.probe,
    waitMs: ADMISSION_MUTEX_MAX_HOLD_MS,
    fn: () =>
      writeMigrationJournal(
        input.bootstrapDir,
        input.coordinator,
        input.expected,
        input.next,
      ),
  });
}

function assertCoordinatorRecorded(
  journal: MigrationJournal,
  coordinator: MigrationCoordinatorLock,
): void {
  if (
    canonicalJson(journal.coordinator) !==
    canonicalJson(coordinator.incarnation)
  ) {
    throw new MigrationAdmissionError(
      "coordinator-not-held",
      "The journal must name the coordinator that holds the migration lock.",
      null,
    );
  }
}

// ---- Maintenance authorization (host side) ---------------------------------

/** Phases in which each offline maintenance operation may run. */
const MAINTENANCE_PHASES: Readonly<
  Record<MaintenanceOperation, readonly MigrationPhase[]>
> = {
  inventory: ["planned", "quiescing"],
  "verify-quiesced-source": ["quiescing", "copying"],
  "repair-copy": ["repairing"],
  "verify-copy": [
    "repairing",
    "preparing-external",
    "ready",
    "switching",
    "switched",
  ],
};

export type MaintenanceAuthorization =
  | {
      readonly ok: true;
      readonly journal: MigrationJournal;
      readonly provisional: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The host's `data-maintenance` entry point authorizes a request only when
 * it names the live coordinator incarnation that holds the coordinator lock,
 * the active transaction, its current journal revision, and an operation the
 * phase permits. Roots and adapters then come from that journal, never from
 * the request. The bootstrap folder is the caller's OS-home one, so the
 * account is the coordinator's own.
 */
export async function authorizeMaintenanceRequest(input: {
  readonly bootstrapDir: string;
  readonly request: MaintenanceRequest;
  readonly probe: ProcessIncarnationProbe;
}): Promise<MaintenanceAuthorization> {
  const { request } = input;
  const lock = readLockFileSync(
    join(input.bootstrapDir, MIGRATION_COORDINATOR_LOCK_FILENAME),
  );
  if (
    lock.kind !== "held" ||
    lock.holder.purpose !== "coordinator" ||
    lock.holder.pid !== request.authorization.pid ||
    lock.holder.nonce !== request.authorization.lockNonce ||
    lock.holder.startIdentity !== request.authorization.startIdentity
  ) {
    return deny("the request does not name the migration lock's holder");
  }
  if (
    (await input.probe.verdict(lock.holder.pid, lock.holder.startIdentity)) !==
    "alive-same"
  ) {
    return deny("the migration coordinator is not running");
  }
  const selector = readMigrationSelectorSync(input.bootstrapDir);
  if (
    selector.kind !== "valid" ||
    selector.record.activeMigrationId !== request.migrationId
  ) {
    return deny("the request does not name the active migration");
  }
  const journal = readMigrationJournalSync(
    input.bootstrapDir,
    request.migrationId,
  );
  if (journal.kind !== "valid")
    return deny("the migration journal is not readable");
  if (journal.record.revision !== request.journalRevision) {
    return deny("the request names a stale journal revision");
  }
  if (
    canonicalJson(journal.record.coordinator) !==
    canonicalJson(request.authorization)
  ) {
    return deny("the journal names another coordinator");
  }
  if (!MAINTENANCE_PHASES[request.operation].includes(journal.record.phase)) {
    return deny(
      `${request.operation} is not permitted in phase ${journal.record.phase}`,
    );
  }
  return {
    ok: true,
    journal: journal.record,
    provisional:
      request.operation === "inventory" && journal.record.phase === "planned",
  };
}

function deny(message: string): MaintenanceAuthorization {
  return { ok: false, message };
}

// ---- Helpers ----------------------------------------------------------------

async function withinMs<T>(
  promise: Promise<T | null>,
  ms: number,
): Promise<T | null> {
  if (ms <= 0) return null;
  let expire: (value: null) => void = () => undefined;
  const timeout = new Promise<null>((resolve) => {
    expire = resolve;
  });
  const timer = setTimeout(() => expire(null), ms);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}
