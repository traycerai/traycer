import type { ReactNode } from "react";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";

interface NotificationIndicatorsProviderProps {
  readonly indicators: HostNotificationsIndicatorStateResponse;
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
