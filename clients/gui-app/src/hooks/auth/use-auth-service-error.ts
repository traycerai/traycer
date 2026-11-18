import { useCallback, useSyncExternalStore } from "react";
import type { AuthService } from "@/lib/auth/auth-service";

export function useAuthServiceError(auth: AuthService): string | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = auth.onErrorChange(() => {
        onStoreChange();
      });
      return () => {
        subscription.dispose();
      };
    },
    [auth],
  );
  const getSnapshot = useCallback(() => auth.getLastError(), [auth]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
