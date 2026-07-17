import { useCallback, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { appLocalNotificationsKey } from "@/lib/persist";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { clearAppLocalDisplayReceipts } from "@/lib/notifications/app-local-display-receipts";

export interface AppLocalNotificationsPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function AppLocalNotificationsPersistLifecycleBridge(
  props: AppLocalNotificationsPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      const transitionUserId = transition.email;
      retargetPersistedStore({
        store: useAppLocalNotificationsStore,
        name: appLocalNotificationsKey(transitionUserId),
      });
      if (transitionUserId !== null) {
        // `retargetPersistedStore` rehydrates from localStorage synchronously for
        // this JSON storage, so the stored bucket is already captured before
        // this activate set writes the non-persisted active identity.
        useAppLocalNotificationsStore
          .getState()
          .activateIdentity(transitionUserId);
      } else {
        useAppLocalNotificationsStore.getState().deactivateIdentity();
      }
      return;
    }
    const activeUserId = useAppLocalNotificationsStore.getState().activeUserId;
    if (activeUserId !== null) {
      clearAppLocalDisplayReceipts(activeUserId);
    }
    clearAndResetPersistedStore({
      store: useAppLocalNotificationsStore,
      anonymousName: appLocalNotificationsKey(null),
    });
    useAppLocalNotificationsStore.getState().deactivateIdentity();
    useAppLocalNotificationsStore.persist.clearStorage();
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
