import { useLayoutEffect, useState, type ReactNode } from "react";
import {
  createNotificationIndicatorsStore,
  NotificationIndicatorsContext,
} from "@/components/notifications/notification-indicator-context";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";

interface NotificationIndicatorsProviderProps {
  readonly indicators: SurfaceNotificationIndicators;
  readonly children: ReactNode;
}

/**
 * Hands `indicators` to the readers below through one store per provider. A
 * new map is written in a layout effect, so the readers it changes render
 * before the frame is painted, as they did when the map was the context value.
 */
export function NotificationIndicatorsProvider(
  props: NotificationIndicatorsProviderProps,
): ReactNode {
  const [store] = useState(() =>
    createNotificationIndicatorsStore(props.indicators),
  );
  const { indicators } = props;
  useLayoutEffect(() => {
    store.setState(indicators, true);
  }, [store, indicators]);
  return (
    <NotificationIndicatorsContext.Provider value={store}>
      {props.children}
    </NotificationIndicatorsContext.Provider>
  );
}
