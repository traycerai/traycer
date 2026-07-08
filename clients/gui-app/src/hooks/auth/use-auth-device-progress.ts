import { useCallback, useSyncExternalStore } from "react";
import type { AuthService, DeviceFlowProgress } from "@/lib/auth/auth-service";

/**
 * Subscribes the header sign-in surface to the active device-flow attempt's
 * progress (user code + verification URI + expiry), or `null` when no device
 * attempt is in flight. Drives the "enter this code" panel so a device fallback
 * is never a silent spinner.
 */
export function useAuthDeviceProgress(
  auth: AuthService,
): DeviceFlowProgress | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = auth.onDeviceProgressChange(() => {
        onStoreChange();
      });
      return () => {
        subscription.dispose();
      };
    },
    [auth],
  );
  const getSnapshot = useCallback(() => auth.getDeviceProgress(), [auth]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
