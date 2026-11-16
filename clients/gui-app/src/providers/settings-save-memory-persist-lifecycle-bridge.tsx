import { useCallback, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { settingsSaveMemoryKey } from "@/lib/persist";
import { installCrossWindowRehydrate } from "@/lib/persist/cross-window-rehydrate";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";
import { useSettingsSaveMemoryStore } from "@/stores/settings/settings-save-memory-store";

export interface SettingsSaveMemoryPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/**
 * Points the settings-save memory at the signed-in account, and wipes it on
 * sign-out: a save remembered for one account is never applied for another.
 */
export function SettingsSaveMemoryPersistLifecycleBridge(
  props: SettingsSaveMemoryPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      const name = settingsSaveMemoryKey(transition.userId);
      retargetPersistedStore({
        store: useSettingsSaveMemoryStore,
        name,
        legacyName: null,
      });
      // Always read the account's records, even when it has none yet, so the
      // record storage forgets which records the previous account held.
      void useSettingsSaveMemoryStore.persist.rehydrate();
      installCrossWindowRehydrate(useSettingsSaveMemoryStore, name);
      return;
    }
    clearAndResetPersistedStore({
      store: useSettingsSaveMemoryStore,
      anonymousName: settingsSaveMemoryKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
