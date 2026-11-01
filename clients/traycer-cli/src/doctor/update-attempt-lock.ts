import { setTimeout as sleep } from "node:timers/promises";
import {
  readLockHolder,
  type LockHolderProbe,
  type LockMetadata,
} from "@traycer-clients/shared/host-lock/cross-process-lock";
import type {
  ProcessIdentityToken,
  ProcessIdentityVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
import { updateLockBusyMessage } from "../host/update-contender";
import { DOCTOR_ISSUE_CODES, type DoctorIssue } from "./issues";

// The update-attempt lock as a doctor probe, for the two states its own
// acquisition path can never leave.
//
// A root maintenance lease hands the lock's liveness to its supervisor and
// then to the installer tree that supervisor runs, with
// `retainOnPublisherDeath`, so a contender cannot race a reparented installer
// (an msiexec custom action) that is still mutating the install. On POSIX the
// tree is a process group and its absence is provable, so the lock heals on
// the next acquisition once the group is gone. On Windows Node has no group
// or Job-object membership proof, so the lock's rule answers `indeterminate`
// for that record forever - fail-closed on purpose, and the only thing that
// ends it is a person confirming no installer is running and removing the
// file. Every later `host maintenance-lease`, which is every scripted desktop
// install and uninstall, is refused meanwhile as if an update were running,
// and nothing else says why.
//
// A lock this user cannot read reads the same way to an acquisition: only
// positive evidence breaks a lock, so it answers busy for as long as the read
// fails. The lock is created 0600, so on POSIX this is also what a live
// contender started with administrator rights looks like to an ordinary
// doctor. One failed read proves nothing: on Windows a healthy release or
// rewrite can fail the read's identity check, and the remedy here is deleting
// the file, so a failure is reported only when a later read repeats it.
//
// Read-only. Doctor never removes the file: the remedy needs the one fact no
// probe here can establish, that no installer is running.

/** Far above a healthy release or rewrite, as the marker lock's probe waits. */
const UPDATE_ATTEMPT_LOCK_REREAD_DELAY_MS = 250;

export interface ProbeUpdateAttemptLockOptions {
  /** `updateAttemptLockPath(hostHomeDir(environment))`. */
  readonly lockPath: string;
  /** The publisher's own verdict; the engine passes `verifyProcessIdentityAsync`. */
  readonly verifyPublisher: (
    token: ProcessIdentityToken,
  ) => Promise<ProcessIdentityVerdict>;
  /**
   * The lock's own rule for a record once its publisher's verdict is known;
   * the engine passes `lockHolderLivenessGivenPublisher`, so this probe can
   * never disagree with what an acquisition would decide.
   */
  readonly livenessGivenPublisher: (
    holder: LockMetadata,
    publisher: ProcessIdentityVerdict,
  ) => ProcessIdentityVerdict;
}

/**
 * An issue for a lock that cannot be read, and for one whose publisher has
 * provably exited (dead, or its pid now belongs to another process) while the
 * lock's rule still answers `indeterminate` - a record no acquisition will
 * ever break. `null` for no lock, a partial one, a publisher that is alive or
 * cannot be judged (a live installer is a real contender), a record the rule
 * will break now that its publisher is gone, and a lock that changed while it
 * was read.
 */
export async function probeUpdateAttemptLock(
  opts: ProbeUpdateAttemptLockOptions,
): Promise<DoctorIssue | null> {
  const first = await readPastOneFailure(opts.lockPath);
  if (first.kind === "read-error") return unreadableIssue(opts.lockPath);
  if (first.kind !== "held") return null;
  const holder = first.holder;
  const publisher = await opts.verifyPublisher({
    pid: holder.pid,
    startedAtMs: holder.processStartedAtMs,
    startIdentity: holder.processStartIdentity,
  });
  if (publisher !== "dead" && publisher !== "alive-different") return null;
  if (opts.livenessGivenPublisher(holder, publisher) !== "indeterminate") {
    return null;
  }
  // Released and re-taken while the publisher was being judged: the verdict
  // above is about a record that is no longer there.
  const second = await readLockHolder(opts.lockPath);
  if (second.kind !== "held" || second.holder.token !== holder.token) {
    return null;
  }
  return unbreakableIssue(opts.lockPath, holder, publisher);
}

async function readPastOneFailure(lockPath: string): Promise<LockHolderProbe> {
  const first = await readLockHolder(lockPath);
  if (first.kind !== "read-error") return first;
  await sleep(UPDATE_ATTEMPT_LOCK_REREAD_DELAY_MS);
  return readLockHolder(lockPath);
}

function unreadableIssue(lockPath: string): DoctorIssue {
  return {
    code: DOCTOR_ISSUE_CODES.HOST_UPDATE_ATTEMPT_LOCK_UNREADABLE,
    severity: "warning",
    title: "Host update-attempt lock cannot be read",
    message: `The host update-attempt lock at ${lockPath} could not be read, so doctor cannot tell who holds it. While that lasts, a Traycer install, update or uninstall that cannot read it will not break it, and is refused with "${updateLockBusyMessage(null)}" A Traycer install, update, uninstall or maintenance lease running with administrator rights can leave a lock an ordinary user cannot read, so if one is running, let it finish and leave the file alone. Only when none is running, check what is at that path, its ownership and its permissions, and remove it, with administrator rights if it needs them; the next one should then proceed.`,
    fixAction: null,
    terminalCommand: null,
    details: { lockPath },
  };
}

function unbreakableIssue(
  lockPath: string,
  holder: LockMetadata,
  publisher: "dead" | "alive-different",
): DoctorIssue {
  const gone =
    publisher === "dead"
      ? "which has exited"
      : "whose pid now belongs to another process";
  const tree =
    holder.supervisedProcessGroupId === undefined
      ? "it asked to be kept after its own exit"
      : `it also names the installer process tree it supervised (group ${String(holder.supervisedProcessGroupId)}), and that tree's exit cannot be verified on this platform`;
  return {
    code: DOCTOR_ISSUE_CODES.HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE,
    severity: "warning",
    title:
      "Host update-attempt lock was left by an interrupted install and will not be released",
    message: `The host update-attempt lock at ${lockPath} was left by pid ${String(holder.pid)} (${holder.reason}, since ${holder.startedAt}), ${gone}. ${tree}, so no install, update or uninstall will break the lock. While it stays, every 'traycer host maintenance-lease' - every scripted desktop install and uninstall - is refused as if an update were still running, and waiting will not clear it. If no Traycer installer, uninstaller or update is running, remove the file; the next one then proceeds.`,
    fixAction: null,
    terminalCommand: null,
    details: {
      lockPath,
      holder,
      publisher,
    },
  };
}
