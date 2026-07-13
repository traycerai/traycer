import type {
  HostNotificationsEntityRef,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import {
  notificationPayloadBelongsToEntity,
  notificationPayloadBelongsToEpic,
} from "@/lib/notifications";
import {
  useAppLocalNotificationsStore,
  type AppLocalNotificationsState,
} from "@/stores/notifications/app-local-notifications-store";

export interface NotificationIndicatorState {
  readonly unreadFailure: boolean;
  readonly pendingPrompt: boolean;
  readonly unreadDone: boolean;
}

export const EMPTY_NOTIFICATION_INDICATOR_STATE: NotificationIndicatorState = {
  unreadFailure: false,
  pendingPrompt: false,
  unreadDone: false,
};

const EMPTY_HOST_INDICATOR_STATE = EMPTY_NOTIFICATION_INDICATOR_STATE;

export function selectNotificationIndicatorState(
  state: Pick<AppLocalNotificationsState, "byId">,
  entity: HostNotificationsEntityRef,
  indicators: HostNotificationsIndicatorStateResponse,
): NotificationIndicatorState {
  const hostState =
    entity.chatId === undefined
      ? (indicators.epics[entity.epicId] ?? EMPTY_HOST_INDICATOR_STATE)
      : (indicators.chats[entity.chatId] ?? EMPTY_HOST_INDICATOR_STATE);
  const unreadLocalFailure = Object.values(state.byId).some(
    (entry) =>
      entry.readAt === null &&
      (entity.chatId === undefined
        ? notificationPayloadBelongsToEpic(entry.payload, entity.epicId)
        : notificationPayloadBelongsToEntity(entry.payload, entity)),
  );
  if (!unreadLocalFailure && hostState === EMPTY_HOST_INDICATOR_STATE) {
    return EMPTY_NOTIFICATION_INDICATOR_STATE;
  }
  return {
    unreadFailure: unreadLocalFailure || hostState.unreadFailure,
    pendingPrompt: hostState.pendingPrompt,
    unreadDone: hostState.unreadDone,
  };
}

export function useNotificationIndicatorState(
  entity: HostNotificationsEntityRef,
  indicators: HostNotificationsIndicatorStateResponse,
): NotificationIndicatorState {
  const byId = useAppLocalNotificationsStore((state) => state.byId);
  return selectNotificationIndicatorState({ byId }, entity, indicators);
}
