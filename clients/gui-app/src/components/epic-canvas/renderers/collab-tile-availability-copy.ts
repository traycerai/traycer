import type { EpicArtifactRoomAvailability } from "@/stores/epics/open-epic/types";

/**
 * What a collab tile says before its editor exists.
 *
 * These three states used to be ONE: `unavailable` and `loading` rendered
 * byte-identical markup - the same three pulsing bars - distinguished only by
 * a `data-testid` suffix no reader can see. A document whose room the host had
 * refused looked exactly like a document that was about to appear, and the
 * only way to tell them apart was to keep waiting: indefinitely, since neither
 * state ended.
 *
 * `null` means "still plausibly arriving - show the placeholder". The pulsing
 * bars are kept for that window; they are a good placeholder for content that
 * is coming, and a sentence there would be a downgrade for the common case.
 *
 * A pure function in its own module so the copy can be asserted without a
 * Y.Doc, and so `collab-tile-body.tsx` keeps Fast Refresh (its neighbour
 * `chat-tile-runtime-gate.tsx` exists for the same reason).
 */
export function collabTileNotice(
  availability: EpicArtifactRoomAvailability,
  budgetElapsed: boolean,
): string | null {
  if (availability === "unavailable") {
    // Says the room is what failed, and does not promise a later load: the
    // host declined to materialize it, which is not a slow network.
    return "This document isn't available right now. It couldn't be opened on its host.";
  }
  if (availability === "retrying") {
    return "Reconnecting to this document…";
  }
  if (budgetElapsed) {
    return "This document hasn't loaded yet.";
  }
  return null;
}
