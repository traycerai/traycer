import { randomUUID } from "node:crypto";
import { link, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  readRegularFileNoFollow,
  type RegularFileNoFollowRead,
} from "@traycer-clients/shared/host-update";
import {
  DESKTOP_PRESENCE_ON_EXIT_VERDICTS,
  desktopPresencePath,
  parseDesktopPresenceText,
  type DesktopPresence,
  type DesktopPresenceOnExit,
} from "@traycer/protocol/config/desktop-presence";
import {
  effectiveHostLifecycleMode,
  hostLifecyclePolicyPath,
  parseHostLifecyclePolicyText,
  serializeHostLifecyclePolicy,
  type HostLifecycleMode,
  type HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import {
  parseSupervisorRecordText,
  serializeSupervisorRecord,
  supervisorRecordPath,
  type SupervisorRecord,
  type SupervisorRunAdmittedAs,
} from "@traycer/protocol/config/supervisor-record";
import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle";
import type { Environment } from "../runner/environment";
import { verifyProcessIdentityAsync } from "../store/process-identity";
import { hostHomeDir } from "../store/paths";
import { HOST_START_ORIGINS, type HostStartOrigin } from "./lifecycle-origin";
import { writeTextAtomically } from "./lifecycle-probe";

// The CLI's reads and writes of the host-lifecycle records in the host home.
//
// Three of the four files are SHARED with Traycer Desktop, so their names,
// shapes and parsers live in `@traycer/protocol/config` and every read below
// goes through those parsers - a torn or malformed file reads as `invalid`,
// which every caller treats exactly like `absent`. The fourth,
// `supervisor-run.json`, is private to this CLI (see `SupervisorRunState`).
//
// Reads never throw. A reader of these records is either the supervisor
// deciding whether to run, where an exception would crash the one process
// that has to exist at login, or a diagnostic command, where it would hide
// every other line of the report.

/**
 * One read of one record.
 *
 * `invalid` and `unreadable` are kept apart from `absent` ONLY so `host
 * doctor` can name a broken file. Every decision treats all three alike: the
 * policy as Background, a presence as not there, a supervisor record as an
 * old supervisor. The one exception is run-ownership inheritance
 * (`readInheritableRunOwnership`), which inherits only on an `absent`
 * `supervisor.json`.
 */
export type LifecycleRecordRead<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly record: T }
  /** Present, but not a well-formed `v: 1` record. */
  | { readonly kind: "invalid" }
  /** Present, but the read itself failed (permissions, a directory, I/O). */
  | { readonly kind: "unreadable"; readonly cause: string };

async function readLifecycleRecord<T>(
  path: string,
  parse: (text: string) => T | null,
): Promise<LifecycleRecordRead<T>> {
  let read: RegularFileNoFollowRead;
  try {
    read = await readRegularFileNoFollow(path);
  } catch (cause) {
    return {
      kind: "unreadable",
      cause: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unreadable") {
    return { kind: "unreadable", cause: read.cause };
  }
  const record = parse(read.text);
  return record === null ? { kind: "invalid" } : { kind: "valid", record };
}

function recordOrNull<T>(read: LifecycleRecordRead<T>): T | null {
  return read.kind === "valid" ? read.record : null;
}

// ---- lifecycle-policy.json ------------------------------------------------

export function hostLifecyclePolicyFilePath(environment: Environment): string {
  return hostLifecyclePolicyPath(hostHomeDir(environment));
}

export function readHostLifecyclePolicy(
  environment: Environment,
): Promise<LifecycleRecordRead<HostLifecyclePolicy>> {
  return readLifecycleRecord(
    hostLifecyclePolicyFilePath(environment),
    parseHostLifecyclePolicyText,
  );
}

/** The mode in force for a read: Background unless the record is valid. */
export function effectiveModeOf(
  read: LifecycleRecordRead<HostLifecyclePolicy>,
): HostLifecycleMode {
  return effectiveHostLifecycleMode(recordOrNull(read));
}

/**
 * `traycer host lifecycle set`: write `mode` with `updatedBy: "cli"`, one
 * `rev` past whatever is on disk, atomically (temp file + rename, so a reader
 * sees the old record or the new one and never a torn one).
 *
 * The `rev` of a record that no longer parses is salvaged when its JSON still
 * carries one, because a reader that stamped a side effect with that `rev`
 * must still see this write as newer; only a file with no readable `rev` at
 * all restarts the counter at 1.
 *
 * Not serialized against a concurrent desktop write. Both writers are driven
 * by a person changing a setting and the file is replaced whole, so the loser
 * of such a race is simply the older choice. Both writers compute `rev` as
 * "the one on disk + 1" with no compare-and-swap, so the two records of such
 * a race can carry the SAME `rev` with different modes: `rev` alone cannot
 * tell them apart, and a reader detecting a change compares `(rev, mode)`.
 */
export async function writeHostLifecyclePolicyFromCli(
  environment: Environment,
  mode: HostLifecycleMode,
  now: Date,
): Promise<HostLifecyclePolicy> {
  const path = hostLifecyclePolicyFilePath(environment);
  const previousRev = await readPreviousPolicyRev(path);
  const policy: HostLifecyclePolicy = {
    v: 1,
    rev: previousRev + 1,
    mode,
    updatedAt: now.toISOString(),
    updatedBy: "cli",
  };
  await writeTextAtomically(path, serializeHostLifecyclePolicy(policy));
  return policy;
}

async function readPreviousPolicyRev(path: string): Promise<number> {
  const read = await readLifecycleRecord(path, (text) => text);
  if (read.kind !== "valid") return 0;
  const parsed = parseHostLifecyclePolicyText(read.record);
  if (parsed !== null) return parsed.rev;
  let value: unknown;
  try {
    value = JSON.parse(read.record);
  } catch {
    return 0;
  }
  const salvaged = z
    .object({ rev: z.number().int().nonnegative() })
    .safeParse(value);
  return salvaged.success ? salvaged.data.rev : 0;
}

// ---- desktop-presence.json ------------------------------------------------

export function readDesktopPresence(
  environment: Environment,
): Promise<LifecycleRecordRead<DesktopPresence>> {
  return readLifecycleRecord(
    desktopPresencePath(hostHomeDir(environment)),
    parseDesktopPresenceText,
  );
}

/**
 * Is the desktop that wrote a presence record still running?
 *
 * - `alive` - its pid is running AND the kernel's start identity matches the
 *   one it recorded, so it is the same process.
 * - `dead` - positive evidence it is gone: the pid is not running, or it is
 *   running a DIFFERENT process (the OS recycled the number).
 * - `indeterminate` - the probe could not tell (a refused `tasklist`, a
 *   failed `ps`). Never evidence of death: every caller treats it as "do not
 *   act on absence".
 *
 * The shared ASYNC probe, never the synchronous one: on Windows the latter
 * blocks the supervisor's event loop on `tasklist` and PowerShell for seconds.
 */
export const DESKTOP_PRESENCE_LIVENESS_VERDICTS = [
  "alive",
  "dead",
  "indeterminate",
] as const;
export type DesktopPresenceLiveness =
  (typeof DESKTOP_PRESENCE_LIVENESS_VERDICTS)[number];

export async function probeDesktopPresenceLiveness(
  presence: DesktopPresence,
): Promise<DesktopPresenceLiveness> {
  try {
    const verdict = await verifyProcessIdentityAsync({
      pid: presence.pid,
      startedAtMs: null,
      startIdentity: presence.processStartIdentity,
    });
    switch (verdict) {
      case "alive-same":
        return "alive";
      case "dead":
      case "alive-different":
        return "dead";
      case "indeterminate":
        return "indeterminate";
    }
  } catch {
    return "indeterminate";
  }
}

// ---- supervisor.json ------------------------------------------------------

export function readSupervisorRecord(
  environment: Environment,
): Promise<LifecycleRecordRead<SupervisorRecord>> {
  return readLifecycleRecord(
    supervisorRecordPath(hostHomeDir(environment)),
    parseSupervisorRecordText,
  );
}

// ---- supervisor-run.json (CLI-private) --------------------------------------

const SUPERVISOR_RUN_STATE_FILENAME = "supervisor-run.json";

/**
 * How this supervisor's run was admitted.
 *
 * - `granted` - an explicit start: a live parent CLI published an adoption
 *   proof and this supervisor consumed it (`origin` says who).
 * - `unattended` - a service-manager start with no proof: login, the service
 *   manager relaunching a supervisor whose crash budget ran out. The only
 *   admission the lifecycle policy can park.
 * - `foreground` - not a labelled service launch at all: `traycer host start`
 *   run by hand, a reclaim probe, or a legacy unlabelled launcher. Never
 *   parked.
 */
export const SUPERVISOR_RUN_ADMISSIONS = [
  "granted",
  "unattended",
  "foreground",
] as const;
export type SupervisorRunAdmission = (typeof SUPERVISOR_RUN_ADMISSIONS)[number];

/** A desktop presence as the supervisor last observed it. */
export interface ObservedDesktopPresence {
  readonly pid: number;
  readonly onExit: DesktopPresenceOnExit;
  readonly liveness: DesktopPresenceLiveness;
  readonly observedAt: string;
}

/**
 * The running supervisor's run ownership state, for `host status`, `host
 * doctor` and `host lifecycle get`.
 *
 * PRIVATE to this CLI, and deliberately not folded into `supervisor.json`:
 * that record is the desktop's contract (does the running supervisor enforce
 * the policy at all, and may the desktop act on its run?), and nothing
 * outside this CLI reads who owns a run. A separate file keeps the shared
 * record exactly the shape its protocol parser defines; the one fact the
 * desktop needs from `admission` - a terminal's run or the service's - is
 * published there as `admittedAs` (`writeSupervisorRecords`).
 *
 * Written at admission (and, later, whenever the policy observer changes
 * one of these facts); removed with `supervisor.json` on every supervisor
 * exit except one that owes a successor (77 / 76), which keeps it for that
 * successor to continue (`SupervisorRecordRemoval`,
 * `readInheritableRunOwnership`). `supervisorStartIdentity` is what lets a
 * reader tell this supervisor's record from one a killed supervisor left
 * behind under a pid the OS has since reused.
 *
 * - `adopted` - a live desktop presence has been observed during this run.
 *   Sticky: once desktop-owned, the run stays desktop-owned (lifecycle
 *   mechanics, "Run ownership").
 * - `lastPresence` - the last presence observation, or `null` when this run
 *   has not looked yet.
 */
export interface SupervisorRunState {
  readonly v: 1;
  readonly supervisorPid: number;
  readonly supervisorStartIdentity: ProcessStartIdentity | null;
  readonly admission: SupervisorRunAdmission;
  /** The grant's origin; `null` when not granted, or granted by an N-1 proof. */
  readonly origin: HostStartOrigin | null;
  readonly adopted: boolean;
  readonly lastPresence: ObservedDesktopPresence | null;
  readonly updatedAt: string;
}

const isoTimestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)));

const supervisorRunStateSchema = z.object({
  v: z.literal(1),
  supervisorPid: z.number().int().positive(),
  supervisorStartIdentity: z
    .string()
    .refine((value) => isProcessStartIdentity(value))
    .nullable(),
  admission: z.enum(SUPERVISOR_RUN_ADMISSIONS),
  origin: z.enum(HOST_START_ORIGINS).nullable(),
  adopted: z.boolean(),
  lastPresence: z
    .object({
      pid: z.number().int().positive(),
      onExit: z.enum(DESKTOP_PRESENCE_ON_EXIT_VERDICTS),
      liveness: z.enum(DESKTOP_PRESENCE_LIVENESS_VERDICTS),
      observedAt: isoTimestamp,
    })
    .nullable(),
  updatedAt: isoTimestamp,
});

export function parseSupervisorRunStateText(
  text: string,
): SupervisorRunState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = supervisorRunStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    v: 1,
    supervisorPid: data.supervisorPid,
    // Narrowed by the refinement above; the schema's static type is `string`.
    supervisorStartIdentity:
      data.supervisorStartIdentity !== null &&
      isProcessStartIdentity(data.supervisorStartIdentity)
        ? data.supervisorStartIdentity
        : null,
    admission: data.admission,
    origin: data.origin,
    adopted: data.adopted,
    lastPresence: data.lastPresence,
    updatedAt: data.updatedAt,
  };
}

export function supervisorRunStatePath(environment: Environment): string {
  return join(hostHomeDir(environment), SUPERVISOR_RUN_STATE_FILENAME);
}

export function readSupervisorRunState(
  environment: Environment,
): Promise<LifecycleRecordRead<SupervisorRunState>> {
  return readLifecycleRecord(
    supervisorRunStatePath(environment),
    parseSupervisorRunStateText,
  );
}

/** The ownership a successor supervisor continues from its predecessor's run. */
export interface InheritedRunOwnership {
  readonly adopted: true;
  readonly lastPresence: ObservedDesktopPresence | null;
}

/**
 * The desktop ownership a restart-owed successor carries over, or `null`.
 *
 * An exit that owes a successor (77, 76) keeps `supervisor-run.json` (see
 * `SupervisorRecordRemoval`) because the run is not over: the supervisor that
 * comes back - the update's or restart's relaunch - is the same run, and a
 * run that was desktop-owned must stay so. Without this the successor never
 * saw a live presence, started `adopted: false`, and a Linked host whose
 * desktop died during an update ran unowned indefinitely.
 *
 * The condition is the owed exit's own footprint on disk - the run state kept
 * and `supervisor.json` gone - not merely a predecessor that is gone. A
 * supervisor that never reached its exit (killed, crashed, ended with the
 * logon session, OOM) leaves `supervisor.json` beside its run state, and so
 * does one whose own removal failed (`removeSupervisorRecords` keeps it then).
 * That run ended without owing anyone a successor, and the next unattended
 * start - a logon trigger, or the service manager's relaunch after a crash -
 * is a new run that has to observe its own desktop.
 *
 * Carried over only when ALL hold, and `null` otherwise:
 *
 * - the file parses and says `adopted: true`;
 * - it carries the owed mark (`markSupervisorRunOwed`), which only an exit
 *   that owes a successor writes. The file alone proves nothing: a SIGKILL,
 *   a power loss or a Windows session end leaves it behind too, and that run
 *   is over - a later start must not inherit its Linked `stop`;
 * - it records a start identity;
 * - `supervisor.json` is `absent`. Any record there refuses, whichever pid it
 *   names, and so do `invalid` and `unreadable`: this is the one decision
 *   that does not read them as absent, because each is a shape the owed exit
 *   never leaves. The successor calls this before it publishes its own
 *   `supervisor.json`, so a record found here is never the reader's own;
 * - the supervisor the run state names is provably gone by pid + that
 *   identity (`dead`, or its pid now runs something else). A live or
 *   unverifiable predecessor is not a predecessor: a second supervisor may
 *   still be running, and its run is its own.
 *
 * Never throws; every failure is `null`, which degrades to an unowned run -
 * the behaviour before this existed. An unowned run is adopted again by the
 * first live presence its observer sees.
 */
export async function readInheritableRunOwnership(
  environment: Environment,
): Promise<InheritedRunOwnership | null> {
  const read = await readLifecycleRecord(
    supervisorRunStatePath(environment),
    parseOwedSupervisorRunStateText,
  );
  if (read.kind !== "valid") return null;
  const predecessor = read.record;
  if (!predecessor.adopted || predecessor.supervisorStartIdentity === null) {
    return null;
  }
  if ((await readSupervisorRecord(environment)).kind !== "absent") {
    return null;
  }
  try {
    const verdict = await verifyProcessIdentityAsync({
      pid: predecessor.supervisorPid,
      startedAtMs: null,
      startIdentity: predecessor.supervisorStartIdentity,
    });
    if (verdict !== "dead" && verdict !== "alive-different") return null;
  } catch {
    return null;
  }
  return { adopted: true, lastPresence: predecessor.lastPresence };
}

/**
 * The key an owed exit adds to the run state it keeps. On disk only: the
 * run-state parser strips it, so no reader but inheritance ever sees it, and
 * a successor's own publish replaces the whole file without it.
 */
const owedRunStateMarkSchema = z.object({ owesSuccessor: z.literal(true) });

/** A kept run state that also carries the owed mark, or `null`. */
function parseOwedSupervisorRunStateText(
  text: string,
): SupervisorRunState | null {
  const record = parseSupervisorRunStateText(text);
  if (record === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return owedRunStateMarkSchema.safeParse(value).success ? record : null;
}

/**
 * Mark the run state an exit that owes a successor keeps (77, 76), so the
 * successor may continue it (`readInheritableRunOwnership`). Only while the
 * file still names `supervisorPid`: a successor that already published owns
 * the file, and its record is never touched.
 *
 * The same one-winner claim `removeSupervisorRecords` uses: rename to a
 * private name, rewrite only a record that is ours, and restore it only while
 * the canonical name is still vacant, so a record written in between wins.
 * Best-effort: an unmarked file is a run that is not continued, which is the
 * safe way to fail.
 */
export async function markSupervisorRunOwed(
  environment: Environment,
  supervisorPid: number,
): Promise<void> {
  const path = supervisorRunStatePath(environment);
  const claimed = `${path}.${process.pid}.${randomUUID()}.owed`;
  try {
    await rename(path, claimed);
  } catch {
    // Absent (this supervisor never published) or not renameable.
    return;
  }
  try {
    const read = await readRegularFileNoFollow(claimed);
    const record =
      read.kind === "text" ? parseSupervisorRunStateText(read.text) : null;
    if (record !== null && record.supervisorPid === supervisorPid) {
      await writeFile(
        claimed,
        `${JSON.stringify({ ...record, owesSuccessor: true }, null, 2)}\n`,
      );
    }
  } catch {
    // Left as it was: restored below unmarked.
  }
  try {
    await link(claimed, path);
  } catch {
    // The canonical name was taken in between: that newer record wins.
  }
  await rm(claimed, { force: true }).catch(() => undefined);
}

// ---- the supervisor's own records -------------------------------------------

/** What the supervisor publishes about itself at admission. */
export interface SupervisorRecords {
  /**
   * `supervisor.json`, less the two fields the writer stamps from the run
   * state: the start identity and `admittedAs`.
   */
  readonly record: Omit<SupervisorRecord, "startIdentity" | "admittedAs">;
  readonly runState: SupervisorRunState;
}

/**
 * The public half of a run's admission (`SupervisorRecord.admittedAs`): a
 * granted or unattended start is the service manager's, and a foreground one
 * is a person's `traycer host start` in a terminal.
 */
export function supervisorRunAdmittedAs(
  admission: SupervisorRunAdmission,
): SupervisorRunAdmittedAs {
  return admission === "foreground" ? "foreground" : "service";
}

/**
 * Publish `supervisor.json` and `supervisor-run.json`. The run state first:
 * `supervisor.json` is what tells a reader a capable supervisor is running,
 * so it lands only once the facts that reader will want next are on disk.
 *
 * `supervisor.json` carries the run state's `supervisorStartIdentity` and the
 * public half of its admission, so the two records can never name the
 * supervisor, or how its run was started, differently: a reader that is not
 * allowed `supervisor-run.json` (the desktop) checks the recorded pid is still
 * that process, and whether a person started it in a terminal, from the
 * public record alone.
 */
export async function writeSupervisorRecords(
  environment: Environment,
  records: SupervisorRecords,
): Promise<void> {
  await writeTextAtomically(
    supervisorRunStatePath(environment),
    `${JSON.stringify(records.runState, null, 2)}\n`,
  );
  await writeTextAtomically(
    supervisorRecordPath(hostHomeDir(environment)),
    serializeSupervisorRecord({
      ...records.record,
      startIdentity: records.runState.supervisorStartIdentity,
      admittedAs: supervisorRunAdmittedAs(records.runState.admission),
    }),
  );
}

/**
 * What a supervisor's exit removes.
 *
 * - `all` - both records: every exit that ends the run.
 * - `keep-run-state` - `supervisor.json` only, on an exit that owes a
 *   successor (77 restart-owed, 76 relaunch refused busy; see
 *   `exitOwesSuccessor` in `commands/host-start.ts`). The run is not over,
 *   so its ownership facts stay on disk for that successor to continue
 *   (`readInheritableRunOwnership`).
 *   With `supervisor.json` gone, no reader attributes the kept file to a
 *   running supervisor: `readHostLifecycleSnapshot` pairs the two by pid.
 *
 * "Run state kept, `supervisor.json` gone" is therefore the owed exit's
 * footprint, and `readInheritableRunOwnership` inherits only from it. `all`
 * must never leave that shape behind, which fixes its order: the run state
 * first, and `supervisor.json` only once the run state is gone. A failure or
 * a kill in between leaves both files, or `supervisor.json` alone - never an
 * inheritable run.
 */
export type SupervisorRecordRemoval = "all" | "keep-run-state";

/**
 * Remove this supervisor's `supervisor.json` and (unless `removal` keeps it)
 * `supervisor-run.json` - only if they still name `supervisorPid`.
 *
 * Guarded because a second supervisor for the same host home is a case the
 * supervisor already reasons about (two service labels at a cold login, a
 * `host ensure` during a relaunch backoff). An unguarded unlink by the one
 * that exits would erase the survivor's records, and the desktop would then
 * read "old supervisor, restart the host to apply" about a supervisor that
 * enforces the policy.
 *
 * The same one-winner claim the adoption proof uses (`host-start-adoption.ts`):
 * rename to a private name, check the owner, and restore a record that is not
 * ours only while the canonical name is still vacant, so a record written in
 * between is never overwritten. Best-effort: a failure leaves a stale record,
 * which readers tell apart by the recorded pid and start identity. For `all`
 * a run state that could not be removed keeps `supervisor.json` beside it
 * (see `SupervisorRecordRemoval`).
 */
export async function removeSupervisorRecords(
  environment: Environment,
  supervisorPid: number,
  removal: SupervisorRecordRemoval,
): Promise<void> {
  if (removal === "all") {
    const runState = await removeIfOwned(
      supervisorRunStatePath(environment),
      (text) =>
        parseSupervisorRunStateText(text)?.supervisorPid === supervisorPid,
    );
    if (runState === "left") return;
  }
  await removeIfOwned(
    supervisorRecordPath(hostHomeDir(environment)),
    (text) => parseSupervisorRecordText(text)?.pid === supervisorPid,
  );
}

/**
 * `left` - the canonical name could not be claimed, so a record of ours may
 * still be there. `cleared` - nothing of ours is there any more: it was
 * removed, it was absent, or what is there belongs to someone else.
 */
type OwnedRecordRemoval = "cleared" | "left";

async function removeIfOwned(
  path: string,
  owned: (text: string) => boolean,
): Promise<OwnedRecordRemoval> {
  const claimed = `${path}.${process.pid}.${randomUUID()}.release`;
  try {
    await rename(path, claimed);
  } catch (cause) {
    // Absent - the common case for a supervisor that never published - is
    // nothing of ours to remove. Anything else left the record where it was.
    return isMissingFile(cause) ? "cleared" : "left";
  }
  const read = await readRegularFileNoFollow(claimed).catch(() => null);
  if (read !== null && read.kind === "text" && owned(read.text)) {
    await rm(claimed, { force: true }).catch(() => undefined);
    return "cleared";
  }
  try {
    await link(claimed, path);
  } catch {
    // The canonical name was taken in between: that newer record wins.
  }
  await rm(claimed, { force: true }).catch(() => undefined);
  return "cleared";
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
