import type { ReactNode } from "react";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";

interface NotificationIndicatorsProviderProps {
  readonly indicators: SurfaceNotificationIndicators;
  readonly children: ReactNode;
}

export function NotificationIndicatorsProvider(
  props: NotificationIndicatorsProviderProps,
): ReactNode {
  return (
    <NotificationIndicatorsContext.Provider value={props.indicators}>
      {props.children}
    </NotificationIndicatorsContext.Provider>
  );
}
