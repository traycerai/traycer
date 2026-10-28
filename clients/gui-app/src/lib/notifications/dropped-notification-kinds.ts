import {
  isBotThreadVerdictNotification,
  RETIRED_HOST_NOTIFICATION_KINDS,
  type HostNotificationKind,
} from "@traycer/protocol/host/notifications/contracts";

/**
 * The notification center carries agent states only. Sandbox state and
 * settings delivery are read on the Sandboxes page, the setup line and
 * Details. A host on this protocol already leaves the retired kinds out; a
 * row of them that an older host or the cloud feed still holds is dropped
 * wherever rows enter the merged list.
 */
const DROPPED_NOTIFICATION_KINDS: ReadonlySet<HostNotificationKind> = new Set(
  RETIRED_HOST_NOTIFICATION_KINDS,
);

/**
 * Whether a feed row is one the notification center no longer shows. A cloud
 * push entry for a sandbox is keyed `sandbox-<kind>:<sandboxId>:<stage>`
 * whatever its row kind, so its `entryId` drops it too; host rows have no
 * such key and pass `null`.
 */
export function isDroppedNotification(
  entry: { readonly kind: HostNotificationKind },
  cloudEntryId: string | null,
): boolean {
  return (
    DROPPED_NOTIFICATION_KINDS.has(entry.kind) ||
    (cloudEntryId?.startsWith("sandbox-") ?? false)
  );
}

/** What a held row adds to a feed summary: the summaries' own predicates. */
export function notificationSummaryContribution(entry: {
  readonly kind: HostNotificationKind;
  readonly severity: string;
  readonly readAt: number | null;
  readonly payload: unknown;
}): { readonly unread: number; readonly attention: number } {
  if (entry.readAt !== null) return { unread: 0, attention: 0 };
  const attention =
    entry.severity === "needs_action" ||
    entry.severity === "failure" ||
    isBotThreadVerdictNotification(entry);
  return { unread: 1, attention: attention ? 1 : 0 };
}
