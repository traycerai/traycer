import { useEffect } from "react";
import {
  AUTH_ERROR_ACCOUNT_UNAVAILABLE,
  AUTH_ERROR_SESSION_EXPIRED,
  AUTH_ERROR_SIGNED_OUT_EVERYWHERE,
} from "@/lib/auth/auth-service";
import { useAuthServiceError } from "@/hooks/auth/use-auth-service-error";
import { useAuthService } from "@/lib/host";
import { authSessionExpiredToast } from "@/lib/toast/channels";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Global auth lifecycle bridge for stored-session or refresh-token expiry.
 *
 * `AuthService` owns the state transition and keeps `lastError` as the durable
 * boundary signal. This bridge consumes the session-expired state, emits the
 * replacement-semantics toast once, then clears the transient error so display
 * surfaces do not carry stale inline copy.
 *
 * `unverified` counts as much as `signed-out`, and it is the case that most
 * needs the toast: a rejected refresh now HOLDS the local plane rather than
 * tearing it down, so the user stays in a working app and there is no
 * `AuthLandingPage` left to carry the message for them. Without this arm the
 * expiry is announced NOWHERE and the user silently stops syncing.
 *
 * That coupling is load-bearing, not incidental: the decision to hold the
 * local plane through a credential-scoped rejection (see the `AuthStatus`
 * definition in `stores/auth/auth-store.ts`) was taken ON THE CONDITION that
 * the user is told. Narrowing this bridge back to `signed-out` alone does not
 * merely lose a toast - it invalidates that ruling. Change the two together
 * or not at all.
 *
 * `signing-in` is excluded because an attempt in flight is about to replace
 * this state either way.
 */
export function AuthSessionExpiredToastBridge(): null {
  const auth = useAuthService();
  const status = useAuthStore((state) => state.status);
  const lastError = useAuthServiceError(auth);

  useEffect(() => {
    const awaitingSignIn = status === "signed-out" || status === "unverified";
    if (!awaitingSignIn) {
      return;
    }
    if (lastError === AUTH_ERROR_SESSION_EXPIRED) {
      authSessionExpiredToast.error("Session expired - sign in again.");
      // Transient: the toast has delivered it, so clear the durable signal
      // before an inline surface renders stale copy.
      auth.clearLastError();
      return;
    }
    if (lastError === AUTH_ERROR_SIGNED_OUT_EVERYWHERE) {
      // The same hold and the same recovery as an expiry; only the copy
      // differs, because "expired" for something the user did themselves
      // reads as a fault.
      authSessionExpiredToast.error(
        "You signed out everywhere - sign in again to continue.",
      );
      auth.clearLastError();
      return;
    }
    if (lastError === AUTH_ERROR_ACCOUNT_UNAVAILABLE) {
      // TERMINAL, and handled differently in both halves. The copy does not say
      // "sign in again" - re-authenticating as the same account cannot succeed,
      // and signing in as a DIFFERENT one is what the sign-in control already
      // offers.
      authSessionExpiredToast.error("This account is no longer available.");
      // Deliberately NOT cleared. A terminal state has nothing to recover from,
      // so the durable signal has to survive for `SignInErrorMessage` to keep
      // rendering it; a toast the user misses would otherwise be the only
      // notice they ever get that their cloud session is over for good.
    }
  }, [auth, lastError, status]);

  return null;
}
