import { useLayoutEffect, useState, type ReactNode } from "react";
import {
  NotificationIndicatorsContext,
  NotificationIndicatorStoreContext,
  type ReadonlyIndicatorsStore,
} from "@/components/notifications/notification-indicator-context";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";

interface NotificationIndicatorsProviderProps {
  readonly indicators: SurfaceNotificationIndicators;
  readonly children: ReactNode;
}

interface IndicatorsStore extends ReadonlyIndicatorsStore {
  /** Replaces the state without telling subscribers. */
  readonly publish: (next: SurfaceNotificationIndicators) => void;
  readonly notify: () => void;
}

function createIndicatorsStore(
  initial: SurfaceNotificationIndicators,
): IndicatorsStore {
  let state = initial;
  let announced = initial;
  const listeners = new Set<
    (
      state: SurfaceNotificationIndicators,
      previous: SurfaceNotificationIndicators,
    ) => void
  >();
  return {
    getState: () => state,
    getInitialState: () => initial,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (next) => {
      state = next;
    },
    notify: () => {
      const previous = announced;
      announced = state;
      for (const listener of listeners) listener(state, previous);
    },
  };
}

export function NotificationIndicatorsProvider(
  props: NotificationIndicatorsProviderProps,
): ReactNode {
  const [store] = useState(() => createIndicatorsStore(props.indicators));
  // Published while rendering and announced in the layout effect: a row that
  // mounts in this very commit (a task moved to another section remounts
  // there) reads the new state at once, and does not see its own state change
  // one commit later - which is what the waiting pulse is keyed on. The
  // subscribers already mounted are woken by the effect, once.
  store.publish(props.indicators);
  useLayoutEffect(() => {
    store.notify();
  }, [store, props.indicators]);
  return (
    <NotificationIndicatorStoreContext.Provider value={store}>
      <NotificationIndicatorsContext.Provider value={props.indicators}>
        {props.children}
      </NotificationIndicatorsContext.Provider>
    </NotificationIndicatorStoreContext.Provider>
  );
}
