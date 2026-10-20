import type { IncompatibilityUpgradeGuidance } from "@traycer/protocol/framework/index";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";

/**
 * What a fatal chat close says, decided once for every surface that reports
 * it: the chat tile's body and the notification. Both ask the same two
 * questions in the same order, host update first, so one close never reads
 * as two different verdicts.
 */
export interface FatalCloseFacts {
  readonly code: string;
  readonly upgradeGuidance: IncompatibilityUpgradeGuidance | null;
}

/**
 * Whether the host has said, one way or the other, that IT is the leg that has
 * to move. The code is the authoritative form; the guidance is the general
 * one, and covers a future code this build has never heard of whose host still
 * marked the direction. Neither is a version comparison.
 */
export function fatalRemedyIsHostUpdate(details: FatalCloseFacts): boolean {
  if (details.code === HOST_OLDER_THAN_DATA_FATAL_CODE) return true;
  const guidance = details.upgradeGuidance;
  if (guidance === null) return false;
  return guidance.hostShouldUpgrade && !guidance.clientShouldUpgrade;
}

/**
 * The words for a close that is the cloud's verdict on the task itself. The
 * host's reason for these codes is written for logs, so no surface shows it.
 */
export interface TaskVerdictCopy {
  readonly headline: string;
  /** The headline as a title, without its full stop. */
  readonly title: string;
  /** The notification's second line: what this costs, or what to do. */
  readonly notificationDetail: string;
  /**
   * A deleted task offers no Try again, since no attempt can open it; missing
   * access keeps it, because the task can be shared.
   */
  readonly offersTryAgain: boolean;
}

/**
 * The verdict copy for a fatal close, or `null` when the close is not a task
 * verdict or the host has to be updated first.
 */
export function taskVerdictCopy(
  details: FatalCloseFacts,
): TaskVerdictCopy | null {
  if (fatalRemedyIsHostUpdate(details)) return null;
  switch (details.code) {
    case "EPIC_NOT_FOUND":
      return {
        headline: "This task was deleted.",
        title: "This task was deleted",
        notificationDetail: "This agent can no longer be opened.",
        offersTryAgain: false,
      };
    case "EPIC_ACCESS_DENIED":
      return {
        headline: "You don't have access to this task.",
        title: "You don't have access to this task",
        notificationDetail: "Ask someone with access to share it with you.",
        offersTryAgain: true,
      };
  }
  return null;
}
