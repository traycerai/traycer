import { createContext, useContext } from "react";
import type {
  HostNotificationsEntityRef,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import {
  useNotificationIndicatorState,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";

const EMPTY_INDICATORS: HostNotificationsIndicatorStateResponse = {
  epics: {},
  chats: {},
};

export const NotificationIndicatorsContext =
  createContext<HostNotificationsIndicatorStateResponse>(EMPTY_INDICATORS);

export function useSurfaceNotificationIndicatorState(
  entity: HostNotificationsEntityRef,
): NotificationIndicatorState {
  const indicators = useContext(NotificationIndicatorsContext);
  return useNotificationIndicatorState(entity, indicators);
}
