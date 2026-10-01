import { randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  probeProcessExistenceWithoutSpawn,
  verifyProcessIdentityAsync,
  type ProcessIdentityVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
import { readRegularFileNoFollow } from "@traycer-clients/shared/host-update";
import { renameWithWindowsRetry } from "@traycer/protocol/config/credentials-fs";
import {
  desktopPresencePath,
  parseDesktopPresenceText,
  serializeDesktopPresence,
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
  SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
  supervisorRecordHasCapability,
  supervisorRecordPath,
  type SupervisorRecord,
} from "@traycer/protocol/config/supervisor-record";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type {
  HostLifecycleRunAdmission,
  HostLifecycleSupervisorState,
} from "../../ipc-contracts/host-lifecycle-types";
import { log } from "../app/logger";
import { readPidMetadataState } from "./host-lifecycle";

// Desktop main's reads and writes of the host-lifecycle records in the host
// home: the lifecycle policy (co-written with `traycer host lifecycle set`),
// this desktop's presence record, and the supervisor record (read only).
//
// Nothing here caches a record. The CLI is a co-writer of the policy, so every
// decision re-reads the file it decides on ("never hydrate once"). Two
// values are memoized: this process's own start identity, which cannot
// change, and the identity verdict on the process `supervisor.json` names,
// keyed by that record's pid and identity and kept only while the pid's
// spawn-free existence agrees with it, and for at most
// `SUPERVISOR_VERDICT_REUSE_MS`. Reads never throw: a torn, malformed or
// unreadable file reads as absent, which for the policy means Background - the
// mode every install had before this record existed.

/** One read of the policy file, as every decision in this module sees it. */
export interface HostLifecyclePolicyRead {
  /** The record, or `null` for an absent, unreadable or malformed file. */
  readonly policy: HostLifecyclePolicy | null;
  /** The mode in force: the record's, or Background without one. */
  readonly mode: HostLifecycleMode;
  /**
   * The record's `rev`. For a malformed file that still carries a readable
   * `rev` that value is kept, so a write over it is still newer than whatever
   * a reader stamped from it; otherwise `0`.
   */
  readonly rev: number;
}

/**
 * - `written` - the record names this process with `onExit`.
 * - `identity-unavailable` - this process's start identity could not be read,
 *   so no record was written: a presence without one is malformed by
 *   contract, and the supervisor would read it as absent anyway.
 */
export type DesktopPresenceWriteOutcome = "written" | "identity-unavailable";

export interface HostLifecyclePolicyStoreOptions {
  /** The host runtime home (`HostFsLayout.rootDir`). */
  readonly hostHomeDir: string;
  /** The host's `pid.json`, read to tell an old supervisor from no host. */
  readonly pidMetadataFile: string;
  readonly ownPid: number;
  /** This process's start identity, or `null` when the probe failed. */
  readonly readOwnStartIdentity: () => Promise<ProcessStartIdentity | null>;
  readonly now: () => Date;
}

const salvagedRevSchema = z.object({ rev: z.number().int().nonnegative() });

/**
 * The longest a full identity probe's verdict on the supervisor record's
 * process is reused, however long the spawn-free existence probe keeps
 * agreeing with it.
 *
 * Existence is not identity: once a supervisor dies without removing its
 * record, the OS may hand its pid to another process - on Windows, commonly
 * within seconds - and from then on that pid `exists`. Without an age bound
 * the cached `alive-same` would outlive the supervisor for as long as the
 * stranger runs, and `→ linked` would trust a supervisor that is gone. With
 * it, a reused pid reads as the supervisor for at most this long after the
 * last full probe; the view, refreshed every 15 s, shows the truth within one
 * refresh after that.
 *
 * 60 s is four view refreshes per full probe. A full probe spawns `ps`
 * (macOS) or `tasklist` and PowerShell (Windows): the start-identity read
 * alone measured 193-227 ms on a Windows VM, and over 4 s for a desktop
 * running at BelowNormal against load (`OWN_WINDOWS_START_IDENTITY_TIMEOUT_MS`
 * in the shared process-identity module). The desktop's other cached verdicts
 * pay the same probe at 120 s (`IDENTITY_VERDICT_REUSE_MS`,
 * `ALIVE_RECHECK_INTERVAL_MS`); this one is tighter because a wrong answer here
 * leaves the host down under `linked` rather than delaying a respawn.
 */
const SUPERVISOR_VERDICT_REUSE_MS = 60_000;

/** One read of the supervisor record, as `readSupervisorRun` returns it. */
export interface SupervisorRunRead {
  readonly state: HostLifecycleSupervisorState;
  /** The live supervisor's pid; `null` unless `state` is `enforcing`. */
  readonly supervisorPid: number | null;
  /**
   * How its run was started; `null` unless `state` is `enforcing`, and for a
   * record written before the field existed.
   */
  readonly admittedAs: HostLifecycleRunAdmission | null;
}

/** A full identity probe's verdict on the process a supervisor record names. */
interface SupervisorVerdictMemo {
  /** The record's pid and start identity: a new record is probed afresh. */
  readonly key: string;
  readonly verdict: ProcessIdentityVerdict;
  /** When the full probe that gave `verdict` began (the store's clock). */
  readonly probedAtMs: number;
}

export class HostLifecyclePolicyStore {
  readonly policyPath: string;
  readonly presencePath: string;
  readonly supervisorPath: string;
  private readonly pidMetadataFile: string;
  private readonly ownPid: number;
  private readonly readOwnStartIdentity: () => Promise<ProcessStartIdentity | null>;
  private readonly now: () => Date;
  /**
   * `readSupervisorState` runs on every view refresh - each watcher edge and
   * poll tick - and a full probe spawns `ps` (macOS) or `tasklist` and
   * PowerShell (Windows). The verdict is kept while the spawn-free existence
   * probe agrees with it, for at most `SUPERVISOR_VERDICT_REUSE_MS`; see
   * `supervisorRecordIsStale`.
   */
  private supervisorVerdict: SupervisorVerdictMemo | null = null;

  constructor(options: HostLifecyclePolicyStoreOptions) {
    this.policyPath = hostLifecyclePolicyPath(options.hostHomeDir);
    this.presencePath = desktopPresencePath(options.hostHomeDir);
    this.supervisorPath = supervisorRecordPath(options.hostHomeDir);
    this.pidMetadataFile = options.pidMetadataFile;
    this.ownPid = options.ownPid;
    this.readOwnStartIdentity = options.readOwnStartIdentity;
    this.now = options.now;
  }

  async readPolicy(): Promise<HostLifecyclePolicyRead> {
    const text = await readTextOrNull(this.policyPath);
    if (text === null) {
      return { policy: null, mode: effectiveHostLifecycleMode(null), rev: 0 };
    }
    const policy = parseHostLifecyclePolicyText(text);
    return {
      policy,
      mode: effectiveHostLifecycleMode(policy),
      rev: policy === null ? salvageRev(text) : policy.rev,
    };
  }

  /**
   * Write `mode` with `updatedBy: "desktop"`, one `rev` past whatever is on
   * disk at the moment of writing, atomically (temp file + rename, so a
   * reader sees the old record or the new one and never a torn one).
   *
   * Not serialized against a concurrent CLI write, for the reason
   * `writeHostLifecyclePolicyFromCli` gives: both writers are a person
   * changing a setting, and the file is replaced whole, so the file always
   * holds one whole choice. `rev` alone does not name that choice: each
   * writer writes one past the `rev` it read, so two racing writes can land
   * at the SAME `rev` with different modes. A reader that follows changes
   * compares `(rev, mode)` (`HostLifecycleService.observe`), never `rev`
   * alone. Throws when the write fails; the caller reports it and commits
   * nothing else.
   */
  async writePolicy(mode: HostLifecycleMode): Promise<HostLifecyclePolicy> {
    const previous = await this.readPolicy();
    const policy: HostLifecyclePolicy = {
      v: 1,
      rev: previous.rev + 1,
      mode,
      updatedAt: this.now().toISOString(),
      updatedBy: "desktop",
    };
    await writeTextAtomically(
      this.policyPath,
      serializeHostLifecyclePolicy(policy),
    );
    log.info("[host-lifecycle] policy written", {
      mode: policy.mode,
      rev: policy.rev,
    });
    return policy;
  }

  /**
   * Whether the running supervisor enforces the policy. A capable
   * supervisor's `supervisor.json` says so while that supervisor lives
   * (`readLiveSupervisorRecord`); without a live one, a host that is
   * nonetheless running (`pid.json` present) is under an older supervisor.
   */
  async readSupervisorState(): Promise<HostLifecycleSupervisorState> {
    return (await this.readSupervisorRun()).state;
  }

  /**
   * `readSupervisorState`, with the live supervisor's pid and how its run was
   * started (`admittedAs`) read from the same record. Both are `null` unless
   * the state is `enforcing`; `admittedAs` is `null` too for a record written
   * before the field existed. Never throws.
   */
  async readSupervisorRun(): Promise<SupervisorRunRead> {
    const record = await this.readLiveSupervisorRecord();
    if (record !== null) {
      return {
        state: "enforcing",
        supervisorPid: record.pid,
        admittedAs: record.admittedAs,
      };
    }
    const pid = await readPidMetadataState(this.pidMetadataFile);
    return {
      state: pid.kind === "absent" ? "not-running" : "not-enforcing",
      supervisorPid: null,
      admittedAs: null,
    };
  }

  /**
   * The live supervisor's pid, only when its record carries a start identity
   * and the process at that pid still has it - `null` for anything else, a
   * record from before the field included.
   *
   * The health monitor's hold key (`E_HOST_NOT_SERVICE_RUN`: leave that run
   * alone until it is gone). It asks for exactly the evidence the CLI's own
   * refusal needs - `readLiveSupervisorRun` refuses only over a supervisor
   * whose recorded identity is `current` - so a hold is never keyed on a pid
   * that only liveness vouches for, which a reissued pid would keep forever.
   */
  async readIdentifiedSupervisorPid(): Promise<number | null> {
    const record = await this.readLiveSupervisorRecord();
    return record !== null && record.startIdentity !== null ? record.pid : null;
  }

  /**
   * `supervisor.json` when it describes a running, capable supervisor: the
   * capability advertised, and the process it names not provably gone.
   * The record is removed only on a clean exit, so one a killed supervisor
   * left behind (SIGKILL, power loss, a Windows session end) is checked
   * against the process it names - otherwise `→ linked` would read a dead
   * supervisor as enforcing and never bring the host up.
   */
  private async readLiveSupervisorRecord(): Promise<SupervisorRecord | null> {
    const text = await readTextOrNull(this.supervisorPath);
    const record = text === null ? null : parseSupervisorRecordText(text);
    if (
      record === null ||
      !supervisorRecordHasCapability(
        record,
        SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
      ) ||
      (await this.supervisorRecordIsStale(record))
    ) {
      return null;
    }
    return record;
  }

  /**
   * Whether `record` provably no longer describes a running supervisor: its
   * pid is dead, or the pid is alive but its start identity differs from the
   * one the supervisor recorded (the OS handed the pid to another process -
   * after a reboot, typically). Positive evidence only: a probe that cannot
   * tell keeps the record's word, and a record written before `startIdentity`
   * existed is judged on its pid's liveness alone.
   *
   * A previous full probe's verdict on the same record is reused for less than
   * `SUPERVISOR_VERDICT_REUSE_MS`, and only while the spawn-free existence
   * probe agrees with it - the pid still `exists` for a live verdict, is still
   * `gone` for a dead one. Existence never stands in for identity
   * (`probeProcessExistenceWithoutSpawn`): a pid the OS reissued `exists` too,
   * which is what the age bound is for. Anything else - a new record, an
   * expired verdict, a clock that stepped backward - takes the full probe.
   */
  private async supervisorRecordIsStale(
    record: SupervisorRecord,
  ): Promise<boolean> {
    const key = `${record.pid}:${record.startIdentity ?? ""}`;
    const nowMs = this.now().getTime();
    const memo = this.supervisorVerdict;
    const reusable =
      memo !== null &&
      memo.key === key &&
      // A backward clock step makes the age negative; that re-probes too.
      nowMs - memo.probedAtMs >= 0 &&
      nowMs - memo.probedAtMs < SUPERVISOR_VERDICT_REUSE_MS &&
      (memo.verdict === "dead"
        ? probeProcessExistenceWithoutSpawn(record.pid) === "gone"
        : probeProcessExistenceWithoutSpawn(record.pid) === "exists");
    let verdict: ProcessIdentityVerdict;
    if (reusable) {
      verdict = memo.verdict;
    } else {
      verdict = await verifyProcessIdentityAsync({
        pid: record.pid,
        startedAtMs: null,
        startIdentity: record.startIdentity,
      });
      // Stamped with when the probe began, so the bound counts its duration.
      this.supervisorVerdict = { key, verdict, probedAtMs: nowMs };
    }
    return verdict === "dead" || verdict === "alive-different";
  }

  async readPresence(): Promise<DesktopPresence | null> {
    const text = await readTextOrNull(this.presencePath);
    return text === null ? null : parseDesktopPresenceText(text);
  }

  /**
   * Publish this process's presence with `onExit`, stamped with the policy
   * `rev` the verdict was derived from. A new desktop always overwrites
   * whatever record is there, so a record a crashed instance left behind is
   * replaced rather than reasoned about.
   *
   * `identity-unavailable` is returned, not logged: the caller retries it and
   * owns how often that is worth a line (`HostLifecycleService`).
   */
  async writePresence(
    onExit: DesktopPresenceOnExit,
    policyRev: number,
  ): Promise<DesktopPresenceWriteOutcome> {
    const identity = await this.readOwnStartIdentity();
    if (identity === null) return "identity-unavailable";
    const presence: DesktopPresence = {
      v: 1,
      pid: this.ownPid,
      processStartIdentity: identity,
      onExit,
      policyRev,
      writtenAt: this.now().toISOString(),
    };
    await writeTextAtomically(
      this.presencePath,
      serializeDesktopPresence(presence),
    );
    log.info("[host-lifecycle] presence written", { onExit, rev: policyRev });
    return "written";
  }

  /**
   * Remove the presence record, only while it still names THIS process.
   * A record another desktop instance wrote is its own and is left alone.
   *
   * The one-winner claim `removeSupervisorRecords` uses: rename to a private
   * name, check the owner, and put back a record that is not ours only while
   * the canonical name is still vacant, so a record written in between is
   * never overwritten. Best-effort: a failure leaves our record, which the
   * supervisor reads by pid + identity once this process is gone.
   */
  async removeOwnPresence(): Promise<void> {
    const identity = await this.readOwnStartIdentity();
    const claimed = `${this.presencePath}.${this.ownPid}.${randomUUID()}.release`;
    try {
      await rename(this.presencePath, claimed);
    } catch {
      return;
    }
    const text = await readTextOrNull(claimed);
    const presence = text === null ? null : parseDesktopPresenceText(text);
    if (
      presence !== null &&
      presence.pid === this.ownPid &&
      identity !== null &&
      presence.processStartIdentity === identity
    ) {
      await rm(claimed, { force: true }).catch(() => undefined);
      log.info("[host-lifecycle] presence removed", {
        rev: presence.policyRev,
      });
      return;
    }
    try {
      await link(claimed, this.presencePath);
    } catch {
      // The canonical name was taken in between: that newer record wins.
    }
    await rm(claimed, { force: true }).catch(() => undefined);
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const read = await readRegularFileNoFollow(path);
    return read.kind === "text" ? read.text : null;
  } catch {
    return null;
  }
}

function salvageRev(text: string): number {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 0;
  }
  const salvaged = salvagedRevSchema.safeParse(value);
  return salvaged.success ? salvaged.data.rev : 0;
}

async function writeTextAtomically(
  destination: string,
  text: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(
    dirname(destination),
    `.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    // Retried on win32: a watcher re-reading this file on its last change
    // holds a handle on it for the length of that read, and `MoveFileExW`
    // will not replace a file with an open handle. Without the retry, that
    // collision fails the write, and a policy or presence change is lost.
    await renameWithWindowsRetry(temporary, destination, 0);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
