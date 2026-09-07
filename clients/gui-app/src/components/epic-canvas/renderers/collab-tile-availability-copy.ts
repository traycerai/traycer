import type { EpicArtifactRoomAvailability } from "@/stores/epics/open-epic/types";

/**
 * What a collab tile says before its editor exists.
 * A document whose room the host had refused looked exactly like a document that was about to appear, and the only way to tell them apart was to keep waiting: indefinitely, since neither state ended.
 */
export function collabTileNotice(
  availability: EpicArtifactRoomAvailability,
  budgetElapsed: boolean,
  subscribeAnswered: boolean,
): string | null {
  // Both room-level verdicts are claims about an ANSWER, so neither may be spoken before one exists.
  // `availability` cannot make that distinction on its own: the union has no "not asked yet" member, so every layer below reads an artifact the body plane has not mentioned as `"unavailable"`, and this notice was reporting a host refusal for the 100-1400 ms a cold tile spends waiting for its first frame.
  if (subscribeAnswered) {
    if (availability === "unavailable") {
      // Says the room is what failed, and does not promise a later load: the
      // host declined to materialize it, which is not a slow network.
      return "This document isn't available right now. It couldn't be opened on its host.";
    }
    if (availability === "retrying") {
      return "Reconnecting to this document…";
    }
  }
  // Reached both by a body that is genuinely slow and by one nothing has been said about, and it is the same sentence for both because it is the same fact: this has taken too long.
  // It is also what stops the un-answered case pulsing forever, which is the defect this module was written to fix.
  if (budgetElapsed) {
    return "This document hasn't loaded yet.";
  }
  return null;
}
