import { useMemo } from "react";
import { parseKnownHostNotificationPayloadForKind } from "@traycer/protocol/host/notifications/payloads";
import type { HostNotificationKind } from "@traycer/protocol/host/notifications/host-notifications";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { useHostNotificationsStore } from "@/stores/notifications/host-notifications-store";

/**
 * The member-removal receipts of `environmentId` that have completed: a
 * `team.member.removed` notice carrying the receipt `environment.members.remove`
 * answered, from either feed, with every host's three facts done. A notice with
 * no receipt completes nothing; a member is never matched by name.
 */
export function useCompletedMemberRemovalReceipts(
  environmentId: string,
): ReadonlySet<string> {
  const hostEntries = useHostNotificationsStore((state) => state.byId);
  const cloudRows = useCloudNotificationsStore((state) => state.rows);
  return useMemo(() => {
    const completed = new Set<string>();
    const consider = (kind: HostNotificationKind, payload: unknown): void => {
      if (kind !== "team.member.removed") return;
      const known = parseKnownHostNotificationPayloadForKind(kind, payload);
      if (known?.kind !== "team_member_removed") return;
      if (known.environmentId !== environmentId) return;
      const receiptId = known.receiptId ?? null;
      if (receiptId === null) return;
      const allDone = known.hosts.every(
        (host) =>
          host.stopped === "done" &&
          host.credentialClosed === "done" &&
          host.replacementDelivered === "done",
      );
      if (allDone) completed.add(receiptId);
    };
    for (const entry of Object.values(hostEntries)) {
      consider(entry.kind, entry.payload);
    }
    for (const row of Object.values(cloudRows)) {
      if (row !== undefined) consider(row.entry.kind, row.entry.payload);
    }
    return completed;
  }, [cloudRows, environmentId, hostEntries]);
}
