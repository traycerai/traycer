import { useCallback, type ReactNode } from "react";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { projectProfilesRegistryKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

/** Account-scoped re-key for the project profiles registry. Renders null. */
export function ProjectProfilesPersistLifecycleBridge(): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useProjectProfilesStore,
        name: projectProfilesRegistryKey(transition.email),
      });
      return;
    }
    clearAndResetPersistedStore({
      store: useProjectProfilesStore,
      anonymousName: projectProfilesRegistryKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, email, onTransition);

  return null;
}
