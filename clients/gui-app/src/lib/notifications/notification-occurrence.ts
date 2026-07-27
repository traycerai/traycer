export interface NotificationOccurrenceInput {
  readonly feedId: string;
  readonly createdAt: number;
}

/**
 * Identifies one arrival of a feed row for live-arrival/N-new detection. A
 * recurrence that reuses the same feed ID with a new `createdAt` mints a new
 * occurrence key (counts as a new arrival); a content-only retitle at the
 * unchanged `createdAt` keeps the same key (not new).
 */
export function occurrenceKeyForNotification(
  row: NotificationOccurrenceInput,
): string {
  return `${row.feedId}@${row.createdAt}`;
}
