import { useCallback, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { epicCanvasKey } from "@/lib/persist";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

/**
 * Renderer-side bridge that retargets the persisted Epic canvas bucket
 * whenever the signed-in identity changes. The store itself stays global;
 * only the localStorage key is switched per user.
 */
export interface EpicCanvasPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function EpicCanvasPersistLifecycleBridge(
  props: EpicCanvasPersistLifecycleBridgeProps,
): ReactNode {
  const windowsBridge = useWindowsBridge();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  // Only to name the pre-userId key for one-time adoption; NOT an identity.
  const legacyEmail = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (windowsBridge !== null) return;
      if (
        transition.kind === "signedIn" ||
        transition.kind === "userSwitched"
      ) {
        retargetPersistedStore({
          store: useEpicCanvasStore,
          name: epicCanvasKey(transition.userId),
          // Never the anonymous bucket: a null email must not adopt shared state into an account.
          legacyName: legacyEmail === null ? null : epicCanvasKey(legacyEmail),
        });
        return;
      }
      // signedOut: wipe the current user's bucket and reset to anonymous.
      clearAndResetPersistedStore({
        store: useEpicCanvasStore,
        anonymousName: epicCanvasKey(null),
      });
    },
    [windowsBridge, legacyEmail],
  );

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
