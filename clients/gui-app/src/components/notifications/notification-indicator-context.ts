import { createContext, useCallback, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  selectNotificationIndicatorState,
  type NotificationIndicatorState,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";

const EMPTY_INDICATORS: SurfaceNotificationIndicators = {
  epics: {},
  chats: {},
};

/**
 * A provider's indicator map, held in a store rather than as the context value.
 * The store's identity never changes, so a new answer reaches only the readers
 * whose selection changed: a 2,000-chat sidebar re-renders the rows whose
 * indicator an answer altered, not every row.
 */
export type NotificationIndicatorsStore =
  StoreApi<SurfaceNotificationIndicators>;

export function createNotificationIndicatorsStore(
  indicators: SurfaceNotificationIndicators,
): NotificationIndicatorsStore {
  return createStore<SurfaceNotificationIndicators>()(() => indicators);
}

export const NotificationIndicatorsContext =
  createContext<NotificationIndicatorsStore>(
    createNotificationIndicatorsStore(EMPTY_INDICATORS),
  );

/** The whole map, for a reader that folds all of it (a provider layer, a
 * strip's sections); it re-renders on every change. */
export function useNotificationIndicatorsSnapshot(): SurfaceNotificationIndicators {
  return useStore(useContext(NotificationIndicatorsContext));
}

/** A value derived from the map; the reader re-renders only when `equal`
 * says the derived value changed. */
export function useNotificationIndicatorsSelector<T>(
  selector: (indicators: SurfaceNotificationIndicators) => T,
  equal: (left: T, right: T) => boolean,
): T {
  return useStoreWithEqualityFn(
    useContext(NotificationIndicatorsContext),
    selector,
    equal,
  );
}

export function useSurfaceNotificationIndicatorState(
  entity: HostNotificationsEntityRef,
  originHostId: string | null,
): NotificationIndicatorState {
  const byId = useAppLocalNotificationsStore((state) => state.byId);
  const { epicId, chatId } = entity;
  const select = useCallback(
    (indicators: SurfaceNotificationIndicators): NotificationIndicatorState =>
      selectNotificationIndicatorState(
        { byId },
        chatId === undefined ? { epicId } : { epicId, chatId },
        originHostId,
        indicators,
      ),
    [byId, epicId, chatId, originHostId],
  );
  return useNotificationIndicatorsSelector(select, sameIndicatorState);
}

export function sameIndicatorState(
  left: NotificationIndicatorState,
  right: NotificationIndicatorState,
): boolean {
  return (
    left.unreadFailure === right.unreadFailure &&
    left.unreadNonTerminalFailure === right.unreadNonTerminalFailure &&
    left.unreadTerminalFailure === right.unreadTerminalFailure &&
    left.pendingFork === right.pendingFork &&
    left.pendingApproval === right.pendingApproval &&
    left.pendingInterview === right.pendingInterview &&
    left.unreadDone === right.unreadDone
  );
}
