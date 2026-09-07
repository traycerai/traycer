import { useCallback, type ReactNode } from "react";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { surfaceHostSelectionKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface SurfaceHostSelectionPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/** Identity-scope surface pins. A leftover pin would open the next sign-in on a vanished host. */
export function SurfaceHostSelectionPersistLifecycleBridge(
  props: SurfaceHostSelectionPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useSurfaceHostSelectionStore,
        name: surfaceHostSelectionKey(transition.userId),
        // New in this release: no email-keyed predecessor was ever written, so there is nothing to adopt.
        legacyName: null,
      });
      return;
    }
    clearAndResetPersistedStore({
      store: useSurfaceHostSelectionStore,
      anonymousName: surfaceHostSelectionKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
