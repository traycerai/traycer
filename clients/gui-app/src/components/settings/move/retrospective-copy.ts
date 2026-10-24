import { formatEvidenceDate } from "@/components/settings/move/format-evidence-date";
import { NO_MOVE_SHEET_ACCEPTANCE } from "@/components/settings/move/overview-dated-lines";

export { NO_MOVE_SHEET_ACCEPTANCE };

export const RETROSPECTIVE_EVIDENCE_UNKNOWN = "unknown";

export const RETROSPECTIVE_RECORD_LINE =
  'This is a record of what happened, not a consent: nothing here is accepted by closing it, and the record keeps reading "No move-sheet acceptance recorded". A choice on a row below records that one choice, for that item, with its time.';

export const RETROSPECTIVE_DISCLOSURE =
  "Rows without a choice stay unused until you choose, here or from Personal ▸ Secrets. Remove from Personal, on each row's page, shows what it would remove before it does. Stored encrypted in Traycer's cloud; computers running Personal received them as values. Stop sharing returns this computer to its own settings and deletes nothing in Personal.";

export const RETROSPECTIVE_GOT_IT = "Got it";
export const RETROSPECTIVE_STOP_SHARING = "Stop sharing from this computer";
export const RETROSPECTIVE_MOVE_TO_PERSONAL = "Move to Personal";

export const RETROSPECTIVE_SHARED_IN_USE = "Shared, in use";
export const RETROSPECTIVE_SHARED_FROM_ROOM = "Shared from the room";
export const RETROSPECTIVE_APPLIED_ON = "Applied on";
export const RETROSPECTIVE_HELD_NOT_IN_USE = "Held, not in use";
export const RETROSPECTIVE_HELD_HOOK = "Held hook";
export const RETROSPECTIVE_STILL_ON_THIS_COMPUTER = "Still on this computer";

export const INCLUDING_MAIL_PASSWORD =
  "including the mail password as a secret";

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

export const HELD_HOOK_CHOICES: readonly HeldChoiceAction[] = [
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
 * The sheet's first line is the observed upload evidence. Either field
 * missing, and the line is `unknown`.
 */
export function retrospectiveEvidenceLine(evidence: ReviewEvidence): string {
  if (evidence.version === null || evidence.at === null) {
    return RETROSPECTIVE_EVIDENCE_UNKNOWN;
  }
  return `Traycer ${evidence.version} uploaded these into Personal on ${formatEvidenceDate(evidence.at)} without asking you.`;
}
