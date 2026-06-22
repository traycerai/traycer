import { useCallback, type ReactNode } from "react";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { worktreeIntentMemoryKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface WorktreeIntentMemoryPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function WorktreeIntentMemoryPersistLifecycleBridge(
  props: WorktreeIntentMemoryPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useWorktreeIntentMemoryStore,
        name: worktreeIntentMemoryKey(transition.email),
      });
      return;
    }
    // signedOut: wipe the current user's bucket and reset to anonymous. Worktree
    // memory carries local paths and per-epic intent, so it must not survive a
    // user switch on a shared install.
    clearAndResetPersistedStore({
      store: useWorktreeIntentMemoryStore,
      anonymousName: worktreeIntentMemoryKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, email, onTransition);

  return <>{props.children}</>;
}
