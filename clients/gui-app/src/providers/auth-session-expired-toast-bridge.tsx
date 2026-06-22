import { useEffect } from "react";
import { AUTH_ERROR_SESSION_EXPIRED } from "@/lib/auth/auth-service";
import { useAuthServiceError } from "@/hooks/auth/use-auth-service-error";
import { useAuthService } from "@/lib/host";
import { authSessionExpiredToast } from "@/lib/toast/channels";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Global auth lifecycle bridge for stored-session or refresh-token expiry.
 *
 * `AuthService` owns the state transition and keeps `lastError` as the durable
 * boundary signal. This bridge consumes only the signed-out + session-expired
 * state, emits the replacement-semantics toast once, then clears the transient
 * error so display surfaces do not carry stale inline copy.
 */
export function AuthSessionExpiredToastBridge(): null {
  const auth = useAuthService();
  const status = useAuthStore((state) => state.status);
  const lastError = useAuthServiceError(auth);

  useEffect(() => {
    if (status !== "signed-out" || lastError !== AUTH_ERROR_SESSION_EXPIRED) {
      return;
    }
    authSessionExpiredToast.error("Session expired - sign in again.");
    auth.clearLastError();
  }, [auth, lastError, status]);

  return null;
}
