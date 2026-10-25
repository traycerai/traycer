import { formatEvidenceDate } from "@/components/settings/move/format-evidence-date";
import { NO_MOVE_SHEET_ACCEPTANCE } from "@/components/settings/move/overview-dated-lines";

export { NO_MOVE_SHEET_ACCEPTANCE };

export const RETROSPECTIVE_RECORD_LINE =
  'This is a record of what happened, not a consent: nothing here is accepted by closing it, and the record keeps reading "You never approved this upload." A choice on a row below records that one choice, for that item, with its time.';

export const RETROSPECTIVE_DISCLOSURE =
  "Rows without a choice stay unused until you choose, here or from Personal ▸ Secrets. Remove from Personal, on each row's page, shows what it would remove before it does. Stored encrypted in Traycer's cloud; computers running Personal received them as values. Stop using Personal returns this computer to its own settings and deletes nothing in Personal.";

export const RETROSPECTIVE_GOT_IT = "Got it";
export const RETROSPECTIVE_STOP_SHARING =
  "Stop using Personal on this computer";
export const RETROSPECTIVE_MOVE_TO_PERSONAL = "Move to Personal";

export const RETROSPECTIVE_SHARED_IN_USE = "Shared, in use";
export const RETROSPECTIVE_SHARED_FROM_ROOM = "Shared files";
export const RETROSPECTIVE_APPLIED_ON = "Applied on";
export const RETROSPECTIVE_HELD_NOT_IN_USE = "On hold until you choose";
export const RETROSPECTIVE_HELD_COMMANDS = "Commands on hold";
export const RETROSPECTIVE_STILL_ON_THIS_COMPUTER = "Still on this computer";

export const KEEP_AS_SECRET = "Keep as a secret";
export const KEEP_AS_VARIABLE = "Keep as a variable";
export const LEAVE_ON_THIS_COMPUTER_ONLY = "Leave on this computer only";
export const DISCARD = "Discard";
export const APPROVE = "Approve";

export type HeldApplyChoice =
  | "secret"
  | "variable"
  | "stays"
  | "discard"
  | "approve";

export interface HeldChoiceAction {
  readonly choice: HeldApplyChoice;
  readonly label: string;
}

export const HELD_VALUE_CHOICES: readonly HeldChoiceAction[] = [
  { choice: "secret", label: KEEP_AS_SECRET },
  { choice: "variable", label: KEEP_AS_VARIABLE },
  { choice: "stays", label: LEAVE_ON_THIS_COMPUTER_ONLY },
  { choice: "discard", label: DISCARD },
];

export const HELD_COMMAND_CHOICES: readonly HeldChoiceAction[] = [
  { choice: "approve", label: APPROVE },
  { choice: "discard", label: DISCARD },
];

export function retrospectiveTitle(hostName: string): string {
  return `What an earlier version already shared from ${hostName}`;
}

export interface ReviewEvidence {
  readonly version: string | null;
  readonly at: number | null;
}

/**
 * The sheet's first line is the observed upload evidence: the earlier
 * version and the date it shared, each where the record holds it. Neither is
 * ever written as a bare `unknown`.
 */
export function retrospectiveEvidenceLine(evidence: ReviewEvidence): string {
  const { version, at } = evidence;
  if (version !== null && at !== null) {
    return `Traycer ${version} shared this computer's settings into Personal on ${formatEvidenceDate(at)} without asking.`;
  }
  if (at !== null) {
    return `An earlier version of Traycer shared this computer's settings into Personal on ${formatEvidenceDate(at)} without asking.`;
  }
  if (version !== null) {
    return `Traycer ${version} shared this computer's settings into Personal without asking; the date wasn't recorded.`;
  }
  return "An earlier version of Traycer shared this computer's settings into Personal without asking; the date wasn't recorded.";
}
