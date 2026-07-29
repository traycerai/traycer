// A staged archive is an ephemeral handoff between Desktop's download lane
// and the CLI's locked apply. The UUID is minted once when the verified tree
// is staged; keeping the encoding here makes the handoff an explicit shared
// contract rather than a Desktop copy of CLI-private stage state.

export function encodeStageFingerprint(stageId: string): string {
  return stageId;
}
