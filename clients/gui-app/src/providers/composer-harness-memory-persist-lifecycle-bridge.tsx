import { useCallback, type ReactNode } from "react";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { composerHarnessMemoryKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface ComposerHarnessMemoryPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function ComposerHarnessMemoryPersistLifecycleBridge(
  props: ComposerHarnessMemoryPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  // Only to name the pre-userId key for one-time adoption; NOT an identity.
  const legacyEmail = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (
        transition.kind === "signedIn" ||
        transition.kind === "userSwitched"
      ) {
        retargetPersistedStore({
          store: useComposerHarnessMemoryStore,
          name: composerHarnessMemoryKey(transition.userId),
          // Never the anonymous bucket: a null email must not adopt shared state into an account.
          legacyName:
            legacyEmail === null ? null : composerHarnessMemoryKey(legacyEmail),
        });
        return;
      }
      // signedOut: wipe the current user's bucket and reset to anonymous. Mirrors
      // the run-settings bridge - harness memory has no desktop-side owner, so
      // this localStorage bridge owns the per-user bucket on every platform.
      clearAndResetPersistedStore({
        store: useComposerHarnessMemoryStore,
        anonymousName: composerHarnessMemoryKey(null),
      });
    },
    [legacyEmail],
  );

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
