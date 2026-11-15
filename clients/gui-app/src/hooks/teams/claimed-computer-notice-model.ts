/**
 * The owner's sentence for a claimed computer (14 Nov): the one notice
 * teammates get, and what a teammate connected to it sees.
 */
export function claimedComputerSentence(
  claimantName: string,
  teamName: string,
): string {
  return `${claimantName} claimed this computer. It no longer belongs to ${teamName}.`;
}
