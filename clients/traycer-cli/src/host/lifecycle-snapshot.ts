import type { DesktopPresenceOnExit } from "@traycer/protocol/config/desktop-presence";
import type {
  HostLifecycleMode,
  HostLifecyclePolicyWriter,
} from "@traycer/protocol/config/host-lifecycle-policy";
import {
  SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
  supervisorRecordHasCapability,
} from "@traycer/protocol/config/supervisor-record";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { Environment } from "../runner/environment";
import { verifyProcessIdentityAsync } from "../store/process-identity";
import {
  effectiveModeOf,
  hostLifecyclePolicyFilePath,
  probeDesktopPresenceLiveness,
  readDesktopPresence,
  readHostLifecyclePolicy,
  readSupervisorRecord,
  readSupervisorRunState,
  type DesktopPresenceLiveness,
  type ObservedDesktopPresence,
  type SupervisorRunAdmission,
} from "./lifecycle-files";
import type { HostStartOrigin } from "./lifecycle-origin";

// What `host status`, `host doctor` and `host lifecycle get` report about the
// host lifecycle policy: the desired mode, the desktop presence, and whether
// the RUNNING supervisor enforces any of it (lifecycle mechanics, D7). One
// reader, so the three commands can never describe the same machine two ways.
//
// Read-only and never throws, like every read under `lifecycle-files.ts`.

/** A record file's condition, for reporting; decisions never use it. */
export type LifecycleRecordState =
  | "absent"
  | "valid"
  | "invalid"
  | "unreadable";

export interface HostLifecyclePolicySnapshot {
  readonly state: LifecycleRecordState;
  /** The mode in force: the record's, or `background` for any other state. */
  readonly mode: HostLifecycleMode;
  readonly rev: number | null;
  readonly updatedAt: string | null;
  readonly updatedBy: HostLifecyclePolicyWriter | null;
  readonly path: string;
}

export interface DesktopPresenceSnapshot {
  readonly state: LifecycleRecordState;
  readonly pid: number | null;
  readonly onExit: DesktopPresenceOnExit | null;
  readonly policyRev: number | null;
  /** `null` when there is no valid record to probe. */
  readonly liveness: DesktopPresenceLiveness | null;
}

/**
 * - `running` - the recorded pid is alive and is the process that wrote the
 *   run state (start identity matches).
 * - `unverified` - the pid is alive but there is nothing to match its identity
 *   against, or the probe could not tell.
 * - `stale` - positive evidence the recorded supervisor is gone: its pid is
 *   dead or now belongs to another process. It exited without removing its
 *   record (a crash, a SIGKILL).
 */
export type SupervisorLiveness = "running" | "unverified" | "stale";

export interface SupervisorSnapshot {
  readonly state: LifecycleRecordState;
  readonly pid: number | null;
  readonly cliVersion: string | null;
  readonly capabilities: readonly string[];
  /** `null` when there is no valid record. */
  readonly liveness: SupervisorLiveness | null;
  /**
   * A live supervisor advertises `lifecycle-policy-v1`. False for an old
   * supervisor (no record) and a stale record alike: in both cases nothing is
   * enforcing the policy right now, and the fix is a host restart.
   */
  readonly enforcesLifecyclePolicy: boolean;
}

export interface SupervisorRunSnapshot {
  readonly admission: SupervisorRunAdmission;
  readonly origin: HostStartOrigin | null;
  readonly adopted: boolean;
  readonly lastPresence: ObservedDesktopPresence | null;
}

/**
 * Who owns the running host's lifetime.
 *
 * - `desktop` - a live desktop presence was observed during this run, so the
 *   host follows that desktop's on-exit verdict.
 * - `none` - nothing owns it: no desktop has been observed (a terminal-started
 *   host stays this way), or no supervisor runs at all.
 * - `unknown` - a host is running under a supervisor that records no run
 *   state (one that predates the lifecycle policy), or the record cannot be
 *   attributed to the running supervisor.
 */
export type HostRunOwner =
  | { readonly kind: "desktop"; readonly pid: number | null }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

export interface HostLifecycleSnapshot {
  readonly policy: HostLifecyclePolicySnapshot;
  readonly presence: DesktopPresenceSnapshot;
  readonly supervisor: SupervisorSnapshot;
  /** The running supervisor's run state; `null` when none is attributable. */
  readonly run: SupervisorRunSnapshot | null;
  readonly owner: HostRunOwner;
}

/**
 * @param hostRunning whether a host process is serving right now (the
 *   caller's own pid.json liveness read). It is what tells "no supervisor
 *   record because nothing is running" from "a host is running under a
 *   supervisor too old to write one".
 */
export async function readHostLifecycleSnapshot(
  environment: Environment,
  hostRunning: boolean,
): Promise<HostLifecycleSnapshot> {
  const [policyRead, presenceRead, supervisorRead, runRead] = await Promise.all(
    [
      readHostLifecyclePolicy(environment),
      readDesktopPresence(environment),
      readSupervisorRecord(environment),
      readSupervisorRunState(environment),
    ],
  );

  const policyRecord = policyRead.kind === "valid" ? policyRead.record : null;
  const policy: HostLifecyclePolicySnapshot = {
    state: policyRead.kind,
    mode: effectiveModeOf(policyRead),
    rev: policyRecord?.rev ?? null,
    updatedAt: policyRecord?.updatedAt ?? null,
    updatedBy: policyRecord?.updatedBy ?? null,
    path: hostLifecyclePolicyFilePath(environment),
  };

  const presenceRecord =
    presenceRead.kind === "valid" ? presenceRead.record : null;
  const presence: DesktopPresenceSnapshot = {
    state: presenceRead.kind,
    pid: presenceRecord?.pid ?? null,
    onExit: presenceRecord?.onExit ?? null,
    policyRev: presenceRecord?.policyRev ?? null,
    liveness:
      presenceRecord === null
        ? null
        : await probeDesktopPresenceLiveness(presenceRecord),
  };

  const supervisorRecord =
    supervisorRead.kind === "valid" ? supervisorRead.record : null;
  // The run state belongs to THIS supervisor only if it names the same pid;
  // anything else is a leftover and is not attributed.
  const runState =
    runRead.kind === "valid" &&
    supervisorRecord !== null &&
    runRead.record.supervisorPid === supervisorRecord.pid
      ? runRead.record
      : null;
  const liveness: SupervisorLiveness | null =
    supervisorRecord === null
      ? null
      : await probeSupervisorLiveness(
          supervisorRecord.pid,
          runState?.supervisorStartIdentity ?? null,
        );
  const supervisorLive = liveness === "running" || liveness === "unverified";
  const supervisor: SupervisorSnapshot = {
    state: supervisorRead.kind,
    pid: supervisorRecord?.pid ?? null,
    cliVersion: supervisorRecord?.cliVersion ?? null,
    capabilities: supervisorRecord?.capabilities ?? [],
    liveness,
    enforcesLifecyclePolicy:
      supervisorLive &&
      supervisorRecordHasCapability(
        supervisorRecord,
        SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
      ),
  };

  const run: SupervisorRunSnapshot | null =
    runState !== null && supervisorLive
      ? {
          admission: runState.admission,
          origin: runState.origin,
          adopted: runState.adopted,
          lastPresence: runState.lastPresence,
        }
      : null;

  return {
    policy,
    presence,
    supervisor,
    run,
    owner: ownerOf(run, supervisorLive, hostRunning),
  };
}

function ownerOf(
  run: SupervisorRunSnapshot | null,
  supervisorLive: boolean,
  hostRunning: boolean,
): HostRunOwner {
  if (run !== null) {
    return run.adopted
      ? { kind: "desktop", pid: run.lastPresence?.pid ?? null }
      : { kind: "none" };
  }
  // No attributable run state. If something is running - the host, or a
  // supervisor between relaunches - it is running under rules this reader
  // cannot see; if nothing is, nothing owns anything.
  return supervisorLive || hostRunning ? { kind: "unknown" } : { kind: "none" };
}

async function probeSupervisorLiveness(
  pid: number,
  startIdentity: ProcessStartIdentity | null,
): Promise<SupervisorLiveness> {
  try {
    const verdict = await verifyProcessIdentityAsync({
      pid,
      startedAtMs: null,
      startIdentity,
    });
    switch (verdict) {
      case "alive-same":
        return "running";
      case "dead":
      case "alive-different":
        return "stale";
      case "indeterminate":
        return "unverified";
    }
  } catch {
    return "unverified";
  }
}

// ---- rendering --------------------------------------------------------------

/**
 * How the running supervisor's run was admitted: the grant's origin
 * (`desktop`, `terminal`, `maintenance`), or `unattended` / `foreground`.
 */
export function describeRunOrigin(run: SupervisorRunSnapshot | null): string {
  if (run === null) return "unknown";
  switch (run.admission) {
    case "granted":
      return run.origin ?? "unknown";
    case "unattended":
      return "unattended";
    case "foreground":
      return "foreground";
  }
}

export function describeOwner(owner: HostRunOwner): string {
  switch (owner.kind) {
    case "desktop":
      return owner.pid === null ? "desktop" : `desktop pid=${owner.pid}`;
    case "none":
      return "none";
    case "unknown":
      return "unknown";
  }
}

function describePolicy(policy: HostLifecyclePolicySnapshot): string {
  switch (policy.state) {
    case "valid":
      return `${policy.mode} (rev ${policy.rev ?? "?"}, set by ${policy.updatedBy ?? "?"})`;
    case "absent":
      return `${policy.mode} (default; no policy file)`;
    case "invalid":
      return `${policy.mode} (the policy file is corrupt and reads as background)`;
    case "unreadable":
      return `${policy.mode} (the policy file cannot be read and reads as background)`;
  }
}

function describePresence(presence: DesktopPresenceSnapshot): string {
  switch (presence.state) {
    case "valid":
      return `pid ${presence.pid ?? "?"}, on exit: ${presence.onExit ?? "?"}, ${presence.liveness ?? "indeterminate"}`;
    case "absent":
      return "none";
    case "invalid":
      return "corrupt record (reads as none)";
    case "unreadable":
      return "unreadable record (reads as none)";
  }
}

function describeSupervisor(supervisor: SupervisorSnapshot): string {
  if (supervisor.state !== "valid" || supervisor.liveness === null) {
    return supervisor.state === "absent"
      ? "no lifecycle record (not running, or predates the lifecycle policy)"
      : `${supervisor.state} record (reads as a supervisor that enforces nothing)`;
  }
  if (supervisor.liveness === "stale") {
    return `stale record (pid ${supervisor.pid ?? "?"} is gone)`;
  }
  const enforcement = supervisor.enforcesLifecyclePolicy
    ? "enforces the lifecycle policy"
    : "does not enforce the lifecycle policy (restart the host to apply)";
  return `pid ${supervisor.pid ?? "?"}, CLI ${supervisor.cliVersion ?? "?"}, ${enforcement}`;
}

/** Label/value rows for a human report; callers lay them out. */
export function lifecycleSnapshotRows(
  snapshot: HostLifecycleSnapshot,
): readonly (readonly [string, string])[] {
  return [
    ["Lifecycle mode", describePolicy(snapshot.policy)],
    ["Desktop presence", describePresence(snapshot.presence)],
    ["Supervisor", describeSupervisor(snapshot.supervisor)],
    ["Run origin", describeRunOrigin(snapshot.run)],
    ["Owner", describeOwner(snapshot.owner)],
  ];
}
