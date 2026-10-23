import { appLogger, describeLogError } from "@/lib/logger";
import {
  markBrowserCanvasHydrated,
  markBrowserCanvasHydrating,
  isBrowserCanvasHydrated,
} from "@/lib/tab-sync/browser-canvas-hydration";
import { configureTabRecoveryHistory } from "@/lib/tab-recovery/history";
import { useCallback, useEffect, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useEpicCanvasStore,
  setEpicCanvasBrowserPersistenceStorage,
  setEpicCanvasBrowserPersistenceHydrating,
} from "@/stores/epics/canvas/store";
import { createCanvasBrowserStorage } from "@/stores/epics/canvas/canvas-browser-storage";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { epicCanvasKey } from "@/lib/persist";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { useWindowsBridge } from "@/providers/windows-bridge-context";

/**
 * Renderer-side bridge that retargets the persisted Epic canvas bucket
 * whenever the signed-in identity changes. The store itself stays global;
 * only the IndexedDB bucket is switched per user.
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
      );
      if (windowsBridge !== null) return;
      void hydrateBrowserCanvas(transition, legacyEmail);
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
      isBrowserCanvasHydrated() ||
      browserHydrationInProgress
    )
      return;
    void configureTabRecoveryHistory(null);
    markBrowserCanvasHydrated();
  }, [status, windowsBridge]);

  return <>{props.children}</>;
}

let browserHydrationGeneration = 0;
let browserHydrationInProgress = false;

async function hydrateBrowserCanvas(
  transition: AuthIdentityTransition,
  legacyEmail: string | null,
): Promise<void> {
  const generation = ++browserHydrationGeneration;
  browserHydrationInProgress = true;
  markBrowserCanvasHydrating();
  setEpicCanvasBrowserPersistenceHydrating(true);
  let hydrationError: unknown;
  try {
    if (transition.kind === "signedOut") {
      useEpicCanvasStore.persist.clearStorage();
    }
    setEpicCanvasBrowserPersistenceStorage(
      createCanvasBrowserStorage(
        transition.kind === "signedOut" || legacyEmail === null
          ? null
          : epicCanvasKey(legacyEmail),
      ),
    );
    useEpicCanvasStore.persist.setOptions({
      name: epicCanvasKey(
        transition.kind === "signedOut" ? null : transition.userId,
      ),
      onRehydrateStorage: () => (_state, error) => {
        hydrationError = error;
      },
    });
    // Do not expose the outgoing account while reading the incoming one, or
    // write this temporary empty state over its saved layout.
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState());
    // Starts immediately: Zustand cancels an earlier account's hydration even
    // if its database read completes later. The readiness signal is awaited.
    await useEpicCanvasStore.persist.rehydrate();
    if (generation !== browserHydrationGeneration) return;
    if (!useEpicCanvasStore.persist.hasHydrated()) {
      throw hydrationError instanceof Error
        ? hydrationError
        : new Error("Saved tabs could not be restored.");
    }
    setEpicCanvasBrowserPersistenceHydrating(false);
  } catch (error) {
    if (generation !== browserHydrationGeneration) return;
    appLogger.warn("[epic-canvas] browser hydration failed", {
      error: describeLogError(error),
    });
    // Keep writes blocked so an unreadable saved layout cannot be replaced
    // by the empty screen. The app remains usable for reload or storage reset.
    toastFromRunnerError(
      error,
      "Saved tabs could not be restored. Reload to try again; tab changes will not be saved until then.",
    );
  } finally {
    if (generation === browserHydrationGeneration) {
      browserHydrationInProgress = false;
      markBrowserCanvasHydrated();
    }
  }
}
