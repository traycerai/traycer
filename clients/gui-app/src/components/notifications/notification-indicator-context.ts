import { createContext, useContext } from "react";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import {
  useNotificationIndicatorState,
  type NotificationIndicatorState,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";

const EMPTY_INDICATORS: SurfaceNotificationIndicators = {
  epics: {},
  chats: {},
};

export const NotificationIndicatorsContext =
  createContext<SurfaceNotificationIndicators>(EMPTY_INDICATORS);

export function useSurfaceNotificationIndicatorState(
  entity: HostNotificationsEntityRef,
  originHostId: string | null,
): NotificationIndicatorState {
  const indicators = useContext(NotificationIndicatorsContext);
  return useNotificationIndicatorState(entity, originHostId, indicators);
}
