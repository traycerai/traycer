/**
 * HOW A NAME IS CUT FOR A TAG, in the one place that decides it.
 *
 * Two modules letter the same row of seats. The scene writes the tag under a
 * seated agent; a painter writes the plate on the desk that agent has left, and
 * the Floor painter's own comment says why the two must agree - "exactly where
 * the seated character's own label was, so the desk does not appear to shift
 * when its owner leaves". A name cut to a different length in the two is the
 * same shift by another route: the person walks away and their name gets
 * longer.
 *
 * Both had a private `MAX_LABEL_CHARS = 14` and a private, byte-identical
 * `truncate`. This is that pair, once. {@link OFFICE_LABEL_GAP} is the other
 * half of the same agreement - where the lettering sits rather than what it
 * says.
 */

/**
 * THE MOST CHARACTERS A NAME TAG CARRIES before it is cut.
 *
 * A character is sixteen pixels wide and a tag is centred on it, so a long name
 * reaches across the desks on either side long before it runs out of room to be
 * drawn in. Fourteen is what fits over a seat without naming its neighbours.
 *
 * A SIGN'S plate is a different budget on purpose - it is measured in PIXELS
 * against the room it names (`OFFICE_SIGN_PLATE_MAX_CHARS` and the ladder in
 * `office-signs.ts`), because a plate has tiles of its own to fit inside and a
 * tag does not.
 */
export const OFFICE_MAX_LABEL_CHARS = 14;

/**
 * `text` cut to `maxChars`, with the last character spent on an ellipsis.
 *
 * The ellipsis is inside the budget rather than added to it: a tag cut to its
 * limit and then given a fifteenth character is a tag that overflows exactly
 * where the limit said it would not.
 */
export function officeTruncateLabel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
