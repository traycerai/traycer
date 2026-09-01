import { z } from "zod";

import { chatSessionAnchorSchema } from "@traycer/protocol/persistence/epic/senders";

/**
 * # What a row renders WITH
 *
 * The host projects a row against whole history. A range serves that row's
 * records ALONE. Anything the renderer derives by looking at the rows AROUND
 * the one it is drawing therefore gets a different answer from an isolated
 * span - silently, and differently depending on where the reader happened to
 * have scrolled.
 *
 * A cold review found seven of these at once. They split by what is missing,
 * and the split is the whole design:
 *
 * - the row under-reports the RECORDS it needs -> `rowRecordIds` serves more
 *   records, and nothing here changes;
 * - the row under-reports a DERIVED value -> it travels here.
 *
 * The second kind cannot be repaired by shipping records, and the setup card is
 * the proof: re-deriving `windowIndex` needs EVERY PRECEDING setup window, so
 * "send the records it was derived from" is unbounded and deletes the point of
 * windowing. Carrying the answer is bounded by construction.
 *
 * ## Why this rides the range and not the skeleton
 *
 * Context is needed to RENDER a row, and only hydrated rows render. On the
 * skeleton it would ride every entry of a 20k-row chat to be read by the few
 * hundred hydrated at a time. Every field here is a small scalar for the same
 * reason the skeleton's are: this rides a frame with a byte budget.
 *
 * ## Absent means "nothing to say"
 *
 * Every field is optional and most rows carry none - a row with an empty
 * context is not serialized at all. An absent field is NOT "the default": it is
 * the projection declining to speak, and a consumer must fall back to its own
 * derivation rather than read a value into the silence. That is what keeps a
 * host predating a field from silently asserting one, and it is why these are
 * `.optional()` rather than nullable with a sentinel.
 *
 * ## This schema is the source of truth
 *
 * `row-projection.ts` builds these and takes its TYPE from here rather than
 * declaring a matching interface beside it. A hand-written type that agrees
 * with its wire schema by inspection is exactly the drift this whole area of
 * the codebase keeps paying for.
 */
export const transcriptRowContextSchema = z.object({
  /**
   * The projection's anchor for this row, when it did NOT come from the turn's
   * own `startedAt`.
   *
   * Present only for a turn persisted before `startedAt` existed, whose anchor
   * came from the preceding user record's timestamp. The renderer's settled
   * walk re-derives that from a running `lastUserTimestamp`, which an isolated
   * range does not have - so it falls back to the assistant record's COMPLETION
   * stamp, disagreeing with the skeleton's `createdAt` and shrinking the
   * displayed elapsed time, often to zero.
   *
   * Omitted whenever `startedAt` supplied the anchor, which is every modern
   * turn: there is nothing the renderer can get wrong in that case, so speaking
   * would be bytes on every row of every chat.
   */
  legacyRowAnchorAt: z.number().optional(),
  /**
   * The session anchor in effect for this assistant turn.
   *
   * The renderer keeps the last anchor active across continuation messages, so
   * a turn whose anchor was established by an older user record outside the
   * span loses its saved profile label. Carried as the ANCHOR rather than the
   * derived label, so the label derivation - and the `harnessId` agreement
   * check that gates it - stays in one place.
   */
  sessionAnchor: chatSessionAnchorSchema.optional(),
  /**
   * Whether any LATER checkpoint rewrites a file this row's checkpoint also
   * touches, computed over whole history.
   *
   * The renderer computes overlap from the checkpoints it can see, so a span
   * without the later ones concludes `false` and the restore dialog drops its
   * warning that files modified in later turns will also be rewound. A missing
   * warning on a destructive action is the one item here that costs a user
   * something irreversible.
   */
  hasLaterOverlappingChanges: z.boolean().optional(),
  /**
   * The setup card's window index, and whether that window is still open.
   *
   * Both come from a partition over the chat's WHOLE event log. Re-running it
   * over one window's events renumbers the card to 0 and can revive a
   * historically closed window as active - and the renumber changes the card's
   * generated row id, so it stops matching the skeleton, its ordinal is
   * suppressed, and it draws unplaced at the tail.
   */
  setupWindowIndex: z.number().int().nonnegative().optional(),
  setupWindowIsActive: z.boolean().optional(),
  /**
   * This user row completed an interrupt-restart steer, so it renders the
   * steer badge.
   *
   * A running fold over the chat's `queue.*` lifecycle
   * (`steeredMessageIdsFromEvents`), which a later `queue.fallback` can
   * retract - so the answer depends on events arbitrarily far from the row and
   * `rowRecordIds` cannot bound them. A user row is served with its message and
   * NO events at all, so a client hydrating one from cold history re-derives
   * "not steered" and drops a badge the live session showed.
   *
   * Carried only when TRUE, like the other flags here: `false` is what the
   * renderer's own fold already produces from an isolated span, so speaking it
   * would be bytes asserting the answer the reader reaches anyway.
   */
  completedSteer: z.boolean().optional(),
});

export type TranscriptRowContext = z.infer<typeof transcriptRowContextSchema>;

/** The many rows whose rendering depends on nothing around them. */
export const EMPTY_ROW_CONTEXT: TranscriptRowContext = {};
