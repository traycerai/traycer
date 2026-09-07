import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type { AuthService } from "@/lib/auth/auth-service";
import { appLogger } from "@/lib/logger";

/**
 * Maps `AuthService.revalidateCurrentContext()` onto the transport-facing `StreamAuthRevalidator` contract - the single normalization every UNAUTHORIZED-recovering host transport uses (the local `/stream` client and the remote session's session-fatal recovery).
 */
export function createStreamAuthRevalidator(
  authService: AuthService,
): StreamAuthRevalidator {
  return {
    revalidateForReconnect: async (): Promise<RevalidateOutcome> => {
      const outcome = await authService.revalidateCurrentContext();
      if (outcome === null) {
        // No live signed-in context to revalidate (signed out / provider torn down).
        // Re-dialing without a credential is futile, and the provider rebuilds dependent clients on sign-out anyway.
        appLogger.warn("[stream-auth] reconnect revalidation rejected", {
          reason: "no-context",
        });
        return "rejected";
      }
      if (outcome.kind === "valid") {
        // AuthnV3 accepts the credential (it may have rotated the bearer in place).
        // Re-dial; the open frame reads the live, possibly-fresh bearer.
        appLogger.debug("[stream-auth] reconnect revalidation accepted", {
          outcome: "valid",
        });
        return "rotated";
      }
      if (outcome.kind === "network-error") {
        appLogger.warn(
          "[stream-auth] reconnect revalidation network error",
          {},
        );
        return "network-error";
      }
      // outcome.kind === "rejected": revalidate has already signed out.
      appLogger.warn("[stream-auth] reconnect revalidation rejected", {
        reason: "auth-rejected",
      });
      return "rejected";
    },
  };
}
