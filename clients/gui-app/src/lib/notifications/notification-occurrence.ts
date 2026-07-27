export interface NotificationOccurrenceInput {
  readonly feedId: string;
  readonly createdAt: number;
  readonly sourceRef: string | null;
}

/**
 * Identifies one arrival of a feed row for live-arrival/N-new detection. A new
 * arrival is minted when the same feed ID reappears with a new `createdAt`, OR
 * with the same `createdAt` but a different `sourceRef` - the same-millisecond
 * prompt supersede case, where an approval/interview row is reopened within one
 * `Date.now()` tick under a fresh source ref. A content-only retitle keeps the
 * `feedId`, `createdAt`, AND `sourceRef` unchanged, so it keeps the same key
 * (not counted as new). `JSON.stringify` gives a null-safe, delimiter-safe
 * encoding: a null `sourceRef` is distinct from the empty string and from any
 * real ref, and no ref value can collide across the three fields.
 */
export function occurrenceKeyForNotification(
  row: NotificationOccurrenceInput,
): string {
  return JSON.stringify([row.feedId, row.createdAt, row.sourceRef]);
}
