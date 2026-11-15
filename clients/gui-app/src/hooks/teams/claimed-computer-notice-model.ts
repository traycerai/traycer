/** The first line of a claimed computer's notice: who claimed it. */
export function claimedComputerTitle(claimantName: string): string {
  return `${claimantName} claimed this computer`;
}

/** The second line of a claimed computer's notice: the team it left. */
export function claimedComputerDetail(teamName: string): string {
  return `It no longer belongs to ${teamName}.`;
}

/**
 * The owner's sentence for a claimed computer (14 Nov): the one notice
 * teammates get, and what a teammate connected to it sees.
 */
export function claimedComputerSentence(
  claimantName: string,
  teamName: string,
): string {
  return `${claimedComputerTitle(claimantName)}. ${claimedComputerDetail(teamName)}`;
}
