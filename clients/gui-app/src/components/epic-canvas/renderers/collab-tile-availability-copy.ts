import type { EpicArtifactRoomAvailability } from "@/stores/epics/open-epic/types";

/**
 * What a collab tile says before its editor exists.
 *
 * These states used to be ONE: `unavailable` and `loading` rendered
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
 * `retrying` is the placeholder too, and deliberately so. On the wire it means
 * "an open attempt is in flight": the host moves a room slot to `retrying` the
 * moment anything wants it opened, first attempt included, and a tile that
 * attaches during that attempt is answered with a non-terminal `unavailable`
 * that translates to exactly this value. So on a cold open it is the FIRST
 * answer most tiles get, and this module used to turn it into "Reconnecting to
 * this document…" at once - a sentence about a connection that had never
 * existed, replacing the skeleton one frame after it appeared. A genuine drop
 * after the editor mounted never reaches this notice at all (the editor stays
 * mounted), and a host that has given up is `unavailable`, which still speaks.
 * What is left for `retrying` is "still coming", which is what the bars say,
 * and the load budget below is what keeps that from pulsing forever.
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
  // The room-level verdict is a claim about an ANSWER, so it may not be
  // spoken before one exists. `availability` cannot make that distinction on
  // its own: the union has no "not asked yet" member, so every layer below
  // reads an artifact the body plane has not mentioned as `"unavailable"`, and
  // this notice was reporting a host refusal for the 100-1400 ms a cold tile
  // spends waiting for its first frame. See
  // `useEpicArtifactBodySubscribeAnswered`.
  if (subscribeAnswered && availability === "unavailable") {
    // Says the room is what failed, and does not promise a later load: the
    // host declined to materialize it, which is not a slow network.
    return "This document isn't available right now. It couldn't be opened on its host.";
  }
  // Reached by a body that is genuinely slow, by one nothing has been said
  // about, and by one whose open attempt is still in flight (`retrying`), and
  // it is the same sentence for all three because it is the same fact: this
  // has taken too long. It is also what stops the un-answered case pulsing
  // forever, which is the defect this module was written to fix.
  if (budgetElapsed) {
    return "This document hasn't loaded yet.";
  }
  return null;
}
