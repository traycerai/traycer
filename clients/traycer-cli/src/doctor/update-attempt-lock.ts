import {
  readLockHolder,
  type LockMetadata,
} from "@traycer-clients/shared/host-lock/cross-process-lock";
import type {
  ProcessIdentityToken,
  ProcessIdentityVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
import { DOCTOR_ISSUE_CODES, type DoctorIssue } from "./issues";

// The update-attempt lock as a doctor probe, for the one state its own
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
// install and uninstall, is refused meanwhile with "another host update
// contender is in progress", and nothing else says why.
//
// Read-only. Doctor never removes the file: the remedy needs the one fact no
// probe here can establish, that no installer is running.

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
 * An issue only when the publisher has provably exited (dead, or its pid now
 * belongs to another process) AND the lock's rule still answers
 * `indeterminate` - a record no acquisition will ever break. `null` for no
 * lock, an unreadable or partial one, a publisher that is alive or cannot be
 * judged (a live installer is a real contender), a record the rule will break
 * now that its publisher is gone, and a lock that changed while it was read.
 */
export async function probeUpdateAttemptLock(
  opts: ProbeUpdateAttemptLockOptions,
): Promise<DoctorIssue | null> {
  const first = await readLockHolder(opts.lockPath);
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
    message: `The host update-attempt lock at ${lockPath} was left by pid ${String(holder.pid)} (${holder.reason}, since ${holder.startedAt}), ${gone}. ${tree}, so no install, update or uninstall will break the lock. While it stays, every 'traycer host maintenance-lease' - every scripted desktop install and uninstall - is refused with "another host update contender is in progress". If no Traycer installer, uninstaller or update is running, remove the file; the next one then proceeds.`,
    fixAction: null,
    terminalCommand: null,
    details: {
      lockPath,
      holder,
      publisher,
    },
  };
}
