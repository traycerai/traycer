import { useCallback, type ReactNode } from "react";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { composerRunSettingsKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface ComposerRunSettingsPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function ComposerRunSettingsPersistLifecycleBridge(
  props: ComposerRunSettingsPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useComposerRunSettingsStore,
        name: composerRunSettingsKey(transition.email),
      });
      return;
    }
    // signedOut: wipe the current user's bucket and reset to anonymous. Unlike
    // the Epic canvas (which the desktop windows bridge projects per-window),
    // composer run-settings have no desktop-side owner, so this localStorage
    // bridge owns the per-user bucket on every platform - including desktop.
    clearAndResetPersistedStore({
      store: useComposerRunSettingsStore,
      anonymousName: composerRunSettingsKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, email, onTransition);

  return <>{props.children}</>;
}
