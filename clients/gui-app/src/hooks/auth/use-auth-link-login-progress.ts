import { useCallback, useSyncExternalStore } from "react";
import type { AuthService, LinkLoginProgress } from "@/lib/auth/auth-service";

/** Drives the approval wait's countdown so the phone shows a loop that is visibly running rather than a silent spinner. */
export function useAuthLinkLoginProgress(
  auth: AuthService,
): LinkLoginProgress | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = auth.onLinkLoginProgressChange(() => {
        onStoreChange();
      });
      return () => {
        subscription.dispose();
      };
    },
    [auth],
  );
  const getSnapshot = useCallback(() => auth.getLinkLoginProgress(), [auth]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
