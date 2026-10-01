import { useCallback, type ReactNode } from "react";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import { profileCopyOperationsKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

/**
 * Identity-scopes the profile-copy operation handles (T6). A handle names an
 * account's source host and copy operation; left standing across a switch it
 * would list - and reopen - another account's copy. Renders nothing: it
 * wraps no subtree, so it sits beside the other bridges rather than inside
 * the nest.
 */
export function ProfileCopyOperationsPersistLifecycleBridge(): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useProfileCopyOperationsStore,
        name: profileCopyOperationsKey(transition.userId),
        // New in this release: nothing email-keyed was ever written.
        legacyName: null,
      });
      return;
    }
    clearAndResetPersistedStore({
      store: useProfileCopyOperationsStore,
      anonymousName: profileCopyOperationsKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  return null;
}
