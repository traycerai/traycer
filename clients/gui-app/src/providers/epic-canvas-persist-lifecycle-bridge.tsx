import { appLogger, describeLogError } from "@/lib/logger";
import {
  markBrowserCanvasHydrated,
  isBrowserCanvasHydrated,
} from "@/lib/tab-sync/browser-canvas-hydration";
import { configureTabRecoveryHistory } from "@/lib/tab-recovery/history";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { useCallback, useEffect, type ReactNode } from "react";
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
      void configureTabRecoveryHistory(
        transition.kind === "signedOut" ? null : transition.userId,
      ).then(scheduleLandingImageReconcile);
      if (windowsBridge !== null) return;
      hydrateBrowserCanvas(transition, legacyEmail);
    },
    [windowsBridge, legacyEmail],
  );

  useAuthIdentityTransition(status, userId, onTransition);

  useEffect(() => {
    // This bridge mounts after HostRuntimeProvider awaits auth.start(). An
    // initially signed-out session emits no identity transition, but still
    // completes hydration. Do not treat a later held sign-in failure as logout.
    if (
      windowsBridge !== null ||
      status !== "signed-out" ||
      isBrowserCanvasHydrated()
    )
      return;
    void configureTabRecoveryHistory(null).then(scheduleLandingImageReconcile);
    markBrowserCanvasHydrated();
  }, [status, windowsBridge]);

  return <>{props.children}</>;
}

function hydrateBrowserCanvas(
  transition: AuthIdentityTransition,
  legacyEmail: string | null,
): void {
  try {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useEpicCanvasStore,
        name: epicCanvasKey(transition.userId),
        // Never adopt shared anonymous state into an account.
        legacyName: legacyEmail === null ? null : epicCanvasKey(legacyEmail),
      });
    } else {
      clearAndResetPersistedStore({
        store: useEpicCanvasStore,
        anonymousName: epicCanvasKey(null),
      });
    }
  } catch (error) {
    appLogger.warn("[epic-canvas] browser hydration failed", {
      error: describeLogError(error),
    });
  } finally {
    markBrowserCanvasHydrated();
  }
}
