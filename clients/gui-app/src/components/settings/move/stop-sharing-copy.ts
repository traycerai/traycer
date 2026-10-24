export const STOP_SHARING_TITLE = "Stop sharing from this computer";

export const STOP_SHARING_CONFIRM = "Stop sharing";
export const STOP_SHARING_KEEP = "Keep sharing";

export const STOP_SHARING_MANAGED = "Personal manages here";
export const STOP_SHARING_NEEDS_CHOICE = "Needs a choice";
export const STOP_SHARING_MANAGED_EMPTY =
  "Nothing of Personal's is on this computer.";

export const KEEP_LOCALLY = "Keep locally";
export const REMOVE_FROM_THIS_COMPUTER = "Remove from this computer";
export const RESOLVE = "Resolve";

export type StopChoice =
  | "keep_locally"
  | "remove_from_this_computer"
  | "resolve";

export type StopChoiceReason = "edited_here" | "depended_on";

export interface StopChoiceAction {
  readonly choice: StopChoice;
  readonly label: string;
}

export const STOP_CHOICES: readonly StopChoiceAction[] = [
  { choice: "keep_locally", label: KEEP_LOCALLY },
  { choice: "remove_from_this_computer", label: REMOVE_FROM_THIS_COMPUTER },
  { choice: "resolve", label: RESOLVE },
];

export function stopSharingDescription(hostName: string): string {
  return `Returns ${hostName} to its own settings: it stops receiving Personal and reporting to it. Shows what Personal manages here first. Nothing in Personal is deleted.`;
}

/**
 * The host refused the stop because what it touches changed after the sheet
 * read it; `labels` are the rows that need a choice now.
 */
export function stopPreviewChangedLine(labels: readonly string[]): string {
  const changed = "What stopping sharing touches changed since you opened it.";
  return labels.length === 0
    ? changed
    : `${changed} Now needs a choice: ${labels.join(", ")}.`;
}

export function stopChoiceReasonLine(reason: StopChoiceReason): string {
  switch (reason) {
    case "edited_here":
      return "Edited on this computer.";
    case "depended_on":
      return "Other items depend on this.";
  }
}
