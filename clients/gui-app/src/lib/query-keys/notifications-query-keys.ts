import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";

const INDICATOR_METHOD = "host.notifications.indicatorState";

export const notificationsQueryKeys = {
  indicatorScope: (hostId: string | null) =>
    hostQueryKeys.methodScope(hostId, INDICATOR_METHOD),
  indicatorIdentity: (userId: string) =>
    `notifications:indicator-state:${userId}`,
  isIndicatorQuery: (queryKey: readonly unknown[]) =>
    queryKey[0] === "host" && queryKey[2] === INDICATOR_METHOD,
  isIndicatorQueryForEntity: (
    queryKey: readonly unknown[],
    entity: HostNotificationsEntityRef,
  ) => {
    if (!notificationsQueryKeys.isIndicatorQuery(queryKey)) return false;
    const request = queryKey[3];
    if (!isRecord(request)) return false;
    const hasEpic =
      Array.isArray(request.epicIds) && request.epicIds.includes(entity.epicId);
    const hasChat =
      entity.chatId !== undefined &&
      Array.isArray(request.chatIds) &&
      request.chatIds.includes(entity.chatId);
    return hasEpic || hasChat;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
