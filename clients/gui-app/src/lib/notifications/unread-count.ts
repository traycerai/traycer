/** Above this a count reads `99+`, as the bell's badge caps it. */
const UNREAD_COUNT_CAP = 99;

/** A count as an unread badge prints it. */
export function formatUnreadCount(count: number): string {
  return count > UNREAD_COUNT_CAP ? `${UNREAD_COUNT_CAP}+` : String(count);
}

/**
 * An accessible name with how many of its notifications are unread, when
 * there are any: "Tracy, 3 unread".
 */
export function labelWithUnreadCount(
  label: string,
  unreadCount: number | null,
): string {
  return unreadCount === null || unreadCount <= 0
    ? label
    : `${label}, ${formatUnreadCount(unreadCount)} unread`;
}
