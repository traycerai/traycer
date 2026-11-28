import { createContext, useCallback, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import {
  useAppLocalNotificationsStore,
  type AppLocalNotificationsState,
} from "@/stores/notifications/app-local-notifications-store";
import {
  notificationIndicatorStateOf,
  selectUnreadLocalFailures,
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
  const { epicId, chatId } = entity;
  // This entity's unread app-local failures alone, not every app-local row:
  // a terminal closing elsewhere re-renders no other row.
  const selectLocalFailures = useCallback(
    (state: AppLocalNotificationsState) =>
      selectUnreadLocalFailures(
        state,
        entityRefOf(epicId, chatId),
        originHostId,
      ),
    [epicId, chatId, originHostId],
  );
  const localFailures = useAppLocalNotificationsStore(selectLocalFailures);
  const select = useCallback(
    (indicators: SurfaceNotificationIndicators): NotificationIndicatorState =>
      notificationIndicatorStateOf(
        localFailures,
        entityRefOf(epicId, chatId),
        originHostId,
        indicators,
      ),
    [localFailures, epicId, chatId, originHostId],
  );
  return useNotificationIndicatorsSelector(select, sameIndicatorState);
}

function entityRefOf(
  epicId: string,
  chatId: string | undefined,
): HostNotificationsEntityRef {
  return chatId === undefined ? { epicId } : { epicId, chatId };
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
