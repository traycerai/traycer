import { useCallback, type ReactNode } from "react";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { worktreeIntentStagingKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface WorktreeIntentStagingPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function WorktreeIntentStagingPersistLifecycleBridge(
  props: WorktreeIntentStagingPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useWorktreeIntentStagingStore,
        name: worktreeIntentStagingKey(transition.email),
      });
      return;
    }
    // signedOut: wipe the current user's bucket and reset to anonymous. Staged
    // intent carries local paths, so it must not survive a user switch on a
    // shared install.
    clearAndResetPersistedStore({
      store: useWorktreeIntentStagingStore,
      anonymousName: worktreeIntentStagingKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, email, onTransition);

  return <>{props.children}</>;
}
