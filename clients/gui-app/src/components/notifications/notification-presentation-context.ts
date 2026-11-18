import { createContext, use } from "react";
import type { NotificationPresentation } from "@/lib/notifications/notification-groups";
import { useMergedNotificationRow } from "@/stores/notifications/merged-notifications";

export const NotificationPresentationContext = createContext<
  ReadonlyMap<string, NotificationPresentation>
>(new Map());

export function useNotificationPresentation(
  key: string,
): NotificationPresentation | null {
  const presentations = use(NotificationPresentationContext);
  const raw = useMergedNotificationRow(key);
  return (
    presentations.get(key) ??
    (raw === null ? null : { key, row: raw, members: [raw], group: null })
  );
}
