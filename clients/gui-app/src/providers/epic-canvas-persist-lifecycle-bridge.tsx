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
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (windowsBridge !== null) return;
      if (
        transition.kind === "signedIn" ||
        transition.kind === "userSwitched"
      ) {
        retargetPersistedStore({
          store: useEpicCanvasStore,
          name: epicCanvasKey(transition.email),
        });
        return;
      }
      // signedOut: wipe the current user's bucket and reset to anonymous.
      clearAndResetPersistedStore({
        store: useEpicCanvasStore,
        anonymousName: epicCanvasKey(null),
      });
    },
    [windowsBridge],
  );

  useAuthIdentityTransition(status, email, onTransition);

  return <>{props.children}</>;
}
