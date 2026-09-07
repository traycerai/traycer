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
 * A fourth state was hiding inside `unavailable`: a tile that has not been
 * ANSWERED yet. `subscribeAnswered` separates it out, so the placeholder now
 * also covers the window between the tree rendering and the body lane's first
 * frame - measured at 100-1400 ms on a cold open, every millisecond of it
 * spent telling the reader the document could not be opened.
 *
 * A pure function in its own module so the copy can be asserted without a
 * Y.Doc, and so `collab-tile-body.tsx` keeps Fast Refresh (its neighbour
 * `chat-tile-runtime-gate.tsx` exists for the same reason).
 */
export function collabTileNotice(
  availability: EpicArtifactRoomAvailability,
  budgetElapsed: boolean,
  subscribeAnswered: boolean,
): string | null {
  // Both room-level verdicts are claims about an ANSWER, so neither may be
  // spoken before one exists. `availability` cannot make that distinction on
  // its own: the union has no "not asked yet" member, so every layer below
  // reads an artifact the body plane has not mentioned as `"unavailable"`, and
  // this notice was reporting a host refusal for the 100-1400 ms a cold tile
  // spends waiting for its first frame. See
  // `useEpicArtifactBodySubscribeAnswered`.
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
  // Reached both by a body that is genuinely slow and by one nothing has been
  // said about, and it is the same sentence for both because it is the same
  // fact: this has taken too long. It is also what stops the un-answered case
  // pulsing forever, which is the defect this module was written to fix.
  if (budgetElapsed) {
    return "This document hasn't loaded yet.";
  }
  return null;
}
