import { useCallback, useSyncExternalStore } from "react";
import type { AuthService, LinkLoginProgress } from "@/lib/auth/auth-service";

/**
 * Subscribes the QR sign-in surface to the active link-login poll's progress
 * (when the next `/link/token` poll fires, and whether one is outstanding), or
 * `null` when no link poll is running. Drives the approval wait's countdown so
 * the phone shows a loop that is visibly running rather than a silent spinner.
 */
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
