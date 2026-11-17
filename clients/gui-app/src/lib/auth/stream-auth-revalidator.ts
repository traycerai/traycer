import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type { AuthService } from "@/lib/auth/auth-service";
import { appLogger } from "@/lib/logger";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

/**
 * Maps `AuthService.revalidateCurrentContext()` onto the transport-facing
 * `StreamAuthRevalidator` contract - the single normalization every
 * UNAUTHORIZED-recovering host transport uses (the local `/stream` client and
 * the remote session's session-fatal recovery). Non-hook so non-React owners
 * (the runtime host messenger, session stores) can build one; the
 * `useStreamAuthRevalidator` hook wraps this for render-path consumers.
 *
 * Lives beside `AuthService` (not under `lib/host/`) so the runtime provider
 * can import it without re-entering the `@/lib/host` barrel it itself feeds.
 */
export function createStreamAuthRevalidator(
  authService: AuthService,
): StreamAuthRevalidator {
  const revalidate = async (): Promise<RevalidateOutcome> => {
    const outcome = await authService.revalidateCurrentContext();
    if (outcome === null) {
      // Re-dialing without a credential is futile.
      appLogger.warn("[stream-auth] reconnect revalidation rejected", {
        reason: "no-context",
      });
      return "rejected";
    }
    if (outcome.kind === "valid") {
      appLogger.debug("[stream-auth] reconnect revalidation accepted", {
        outcome: "valid",
      });
      return "rotated";
    }
    if (outcome.kind === "superseded") {
      // Stay in backoff, where the next re-dial revalidates; `rejected` would close this stream for good.
      appLogger.debug("[stream-auth] reconnect revalidation superseded", {});
      return "network-error";
    }
    if (outcome.kind === "network-error") {
      appLogger.warn("[stream-auth] reconnect revalidation network error", {});
      return "network-error";
    }
    // A terminal verdict on a held identity demotes rather than clears, so `rejected` is
    // the credential's verdict: a session that still admits the local plane keeps the
    // local stream open.
    if (admitsLocalPlane(useAuthStore.getState().status)) {
      appLogger.warn("[stream-auth] reconnect revalidation demoted", {
        reason: "cloud-verdict-withdrawn",
      });
      // The service decides whether that ends the local plane, so unary and stream apply one rule.
      authService.noteHostRefusedHeldBearer();
      return "local-plane-retained";
    }
    appLogger.warn("[stream-auth] reconnect revalidation rejected", {
      reason: "auth-rejected",
    });
    return "rejected";
  };
  return {
    revalidateForReconnect: revalidate,
    // Only the server pool opens with the sign-in; a host-only token recovers through
    // `revalidateForReconnect` alone.
    revalidateRefused: () => revalidate(),
  };
}
