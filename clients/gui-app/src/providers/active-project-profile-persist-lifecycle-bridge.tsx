import { useCallback, type ReactNode } from "react";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { activeProjectProfileKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface ActiveProjectProfilePersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function ActiveProjectProfilePersistLifecycleBridge(
  props: ActiveProjectProfilePersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useActiveProjectProfileStore,
        name: activeProjectProfileKey(transition.email),
      });
      return;
    }
    clearAndResetPersistedStore({
      store: useActiveProjectProfileStore,
      anonymousName: activeProjectProfileKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, email, onTransition);

  return <>{props.children}</>;
}
