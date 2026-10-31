import {
  isBotConversationAttention,
  isBotThreadVerdictNotification,
  RETIRED_HOST_NOTIFICATION_KINDS,
  type HostNotificationKind,
} from "@traycer/protocol/host/notifications/contracts";
import {
  HOST_OPERATION_WORKTREE_AUTO_CLEANUP,
  HOST_OPERATION_WORKTREE_DELETION,
} from "@traycer/protocol/host/notifications/payloads";

/**
 * The notification center carries agent states only. Sandbox, environment,
 * team, secret and notification-hook state is read on its own page. A host on
 * this protocol already leaves the retired kinds out; a row of them that an
 * older host or the cloud feed still holds is dropped wherever rows enter the
 * merged list.
 */
const DROPPED_NOTIFICATION_KINDS: ReadonlySet<HostNotificationKind> = new Set(
  RETIRED_HOST_NOTIFICATION_KINDS,
);

/**
 * The `host.operation.finished` operations no agent produces: a session
 * import, a worktree deletion or automatic cleanup, a provider-pack update.
 * Their results stay where the operation shows them. The kind itself still
 * carries agent rows (a parked delivery, a chat fork, a bot's answer), so a
 * row is dropped by its payload's `operation`, never by its kind.
 */
const DROPPED_HOST_OPERATIONS: ReadonlySet<string> = new Set([
  HOST_OPERATION_WORKTREE_DELETION,
  HOST_OPERATION_WORKTREE_AUTO_CLEANUP,
  "session.import.outputs",
  "provider.pack.update_available",
  "provider.pack.security_floor",
  "provider.pack.pin_lifecycle",
]);

function isDroppedHostOperation(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "operation" in payload &&
    typeof payload.operation === "string" &&
    DROPPED_HOST_OPERATIONS.has(payload.operation)
  );
}

/**
 * Whether a feed row is one the notification center no longer shows. A cloud
 * push entry for a sandbox is keyed `sandbox-<kind>:<sandboxId>:<stage>`
 * whatever its row kind, so its `entryId` drops it too; host rows have no
 * such key and pass `null`.
 */
export function isDroppedNotification(
  entry: { readonly kind: HostNotificationKind; readonly payload: unknown },
  cloudEntryId: string | null,
): boolean {
  return (
    DROPPED_NOTIFICATION_KINDS.has(entry.kind) ||
    (entry.kind === "host.operation.finished" &&
      isDroppedHostOperation(entry.payload)) ||
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
    isBotThreadVerdictNotification(entry) ||
    isBotConversationAttention(entry);
  return { unread: 1, attention: attention ? 1 : 0 };
}
