import { useCallback, type ReactNode } from "react";
import { useProfileTabWorkspacesStore } from "@/stores/profiles/profile-tab-workspaces-store";
import { profileTabWorkspacesKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

/** Account-scoped re-key for per-profile tab workspaces. Renders null. */
export function ProfileTabWorkspacesPersistLifecycleBridge(): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useProfileTabWorkspacesStore,
        name: profileTabWorkspacesKey(transition.email),
      });
      return;
    }
    clearAndResetPersistedStore({
      store: useProfileTabWorkspacesStore,
      anonymousName: profileTabWorkspacesKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, email, onTransition);

  return null;
}
