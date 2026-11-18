import { useMemo } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useNotificationResolveHostId } from "@/hooks/notifications/use-notification-host";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import {
  foldNotificationGroups,
  type NotificationPresentation,
} from "@/lib/notifications/notification-groups";
import {
  classifyNotificationLifecycle,
  compareAttentionTiers,
} from "@/lib/notifications/notification-lifecycle";
import {
  compareRecentNotificationOrder,
  useMergedNotificationRows,
} from "./merged-notifications";
import { useCloudNotificationsStore } from "./cloud-notifications-store";
import { useHostNotificationsStore } from "./host-notifications-store";
import { useNotificationsPopoverStore } from "./notifications-popover-store";

interface NotificationFeedPresentation {
  readonly byKey: ReadonlyMap<string, NotificationPresentation>;
  readonly attentionIds: ReadonlyArray<string>;
  readonly recentIds: ReadonlyArray<string>;
}

export function useNotificationFeedPresentation(): NotificationFeedPresentation {
  const rows = useMergedNotificationRows();
  const accountId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const feedMode = useNotificationFeedMode();
  const localHostId = useNotificationResolveHostId();
  const localEpoch = useHostNotificationsStore((state) => state.snapshotEpoch);
  const cloudEpoch = useCloudNotificationsStore((state) => state.sessionEpoch);
  const unreadOnly = useNotificationsPopoverStore((state) => state.unreadOnly);
  const categories = useNotificationsPopoverStore((state) => state.categories);
  return useMemo(() => {
    const items = foldNotificationGroups(rows, {
      accountId,
      feedMode,
      localHostId,
      localEpoch,
      cloudEpoch,
    });
    const attention = items.filter(
      (item) => classifyNotificationLifecycle(item.row).section === "attention",
    );
    attention.sort((a, b) => {
      const left = classifyNotificationLifecycle(a.row);
      const right = classifyNotificationLifecycle(b.row);
      const tier =
        left.section === "attention" && right.section === "attention"
          ? compareAttentionTiers(left.tier, right.tier)
          : 0;
      return tier || compareRecentNotificationOrder(a.row, b.row);
    });
    const recent = items.filter(
      (item) =>
        classifyNotificationLifecycle(item.row).section === "recent" &&
        categories.has(item.row.category) &&
        (!unreadOnly || item.row.readAt === null),
    );
    recent.sort((a, b) => compareRecentNotificationOrder(a.row, b.row));
    return {
      byKey: new Map(items.map((item) => [item.key, item])),
      attentionIds: attention.map((item) => item.key),
      recentIds: recent.map((item) => item.key),
    };
  }, [
    rows,
    accountId,
    feedMode,
    localHostId,
    localEpoch,
    cloudEpoch,
    unreadOnly,
    categories,
  ]);
}
