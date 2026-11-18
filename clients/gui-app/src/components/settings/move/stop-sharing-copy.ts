export const STOP_SHARING_TITLE = "Stop using Personal on this computer";

export const STOP_SHARING_CONFIRM = "Stop using Personal";
export const STOP_SHARING_KEEP = "Cancel";

export const STOP_SHARING_NEEDS_CHOICE = "Choose what stays on this computer";
export const STOP_SHARING_REMOVED = "Removed from this computer when you stop";
export const STOP_SHARING_REMOVED_LINE =
  "These came from Personal. Stopping removes them from this computer only; they stay in Personal and come back if you move this computer to Personal again.";
export const STOP_SHARING_MANAGED_EMPTY =
  "Nothing from Personal is on this computer.";

export const KEEP_ON_THIS_COMPUTER = "Keep on this computer";
export const REMOVE_FROM_THIS_COMPUTER = "Remove from this computer";

export type StopChoice = "keep_locally" | "remove_from_this_computer";

export type StopChoiceOrigin =
  | "from_this_computer"
  | "changed_here"
  | "depended_on";

export interface StopChoiceAction {
  readonly choice: StopChoice;
  readonly label: string;
}

export const STOP_CHOICES: readonly StopChoiceAction[] = [
  { choice: "keep_locally", label: KEEP_ON_THIS_COMPUTER },
  { choice: "remove_from_this_computer", label: REMOVE_FROM_THIS_COMPUTER },
];

export function stopSharingDescription(hostName: string): string {
  return `Returns ${hostName} to its own settings: it stops receiving Personal and reporting to it. Shows what Personal manages here first. Nothing in Personal is deleted.`;
}

/**
 * The host refused the stop because what it touches changed after the sheet
 * read it; `labels` are the rows that need a choice now.
 */
export function stopPreviewChangedLine(labels: readonly string[]): string {
  const changed =
    "What stopping using Personal touches changed since you opened it.";
  return labels.length === 0
    ? changed
    : `${changed} Now needs a choice: ${labels.join(", ")}.`;
}

const CHOOSE_HERE = "Choose what happens to it here when you stop.";

/**
 * Why a row needs a choice. `usedBy` names what depends on it; a host that
 * names none (a `@1.0` host) reads the general line.
 */
export function stopChoiceReasonLine(
  origin: StopChoiceOrigin,
  usedBy: readonly string[],
): string {
  switch (origin) {
    case "from_this_computer":
      return `Came from this computer. ${CHOOSE_HERE}`;
    case "changed_here":
      return `Changed on this computer. ${CHOOSE_HERE}`;
    case "depended_on":
      return usedBy.length === 0
        ? `Other settings use it. ${CHOOSE_HERE}`
        : `Used by ${usedBy.join(", ")}. ${CHOOSE_HERE}`;
  }
}
