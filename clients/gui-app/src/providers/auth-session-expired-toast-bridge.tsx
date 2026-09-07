import { useEffect } from "react";
import { AUTH_ERROR_SESSION_EXPIRED } from "@/lib/auth/auth-service";
import { useAuthServiceError } from "@/hooks/auth/use-auth-service-error";
import { useAuthService } from "@/lib/host";
import { authSessionExpiredToast } from "@/lib/toast/channels";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Signed-out + session-expired: toast once, then clear lastError so surfaces do not keep stale inline copy. */
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
