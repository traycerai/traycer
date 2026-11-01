import { onSettingsDate } from "@/lib/settings/settings-date";

/**
 * Overview settings-card lines. E4 draws `Moved to Personal on …`
 * and the card draws the `Details` verb; this file is the dated copy only.
 */

export const RETURNED_FROM_TEAM_LINE =
  "This computer went back to your own settings.";

export const SHARED_BY_EARLIER_VERSION_LINE = "Shared by an earlier version";

export const SHARED_BY_EARLIER_VERSION_DETAILS_LABEL = "Details";

export const NO_MOVE_SHEET_ACCEPTANCE = "You never approved this upload.";

export function stoppedSharingLine(at: number): string {
  return `This computer stopped using Personal ${onSettingsDate(at)}`;
}

/**
 * The dated lines drawn on Overview, in this order. Empty when none of
 * the three facts are present. `Details` is a verb on the earlier-version
 * line, not a line of its own.
 */
export function overviewDatedCopy(input: {
  readonly returnedFromTeamAt: number | null;
  readonly sharedUnrecorded: boolean;
  readonly stoppedAt: number | null;
}): readonly string[] {
  const lines: string[] = [];
  if (input.sharedUnrecorded) lines.push(SHARED_BY_EARLIER_VERSION_LINE);
  if (input.stoppedAt !== null) lines.push(stoppedSharingLine(input.stoppedAt));
  if (input.returnedFromTeamAt !== null) lines.push(RETURNED_FROM_TEAM_LINE);
  return lines;
}
