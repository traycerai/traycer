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
      // No live signed-in context to revalidate (signed out / provider
      // torn down). Re-dialing without a credential is futile, and the
      // provider rebuilds dependent clients on sign-out anyway.
      appLogger.warn("[stream-auth] reconnect revalidation rejected", {
        reason: "no-context",
      });
      return "rejected";
    }
    if (outcome.kind === "valid") {
      // AuthnV3 accepts the credential (it may have rotated the bearer in
      // place). Re-dial; the open frame reads the live, possibly-fresh
      // bearer.
      appLogger.debug("[stream-auth] reconnect revalidation accepted", {
        outcome: "valid",
      });
      return "rotated";
    }
    if (outcome.kind === "superseded") {
      // The answer is stale under a live context: something newer overtook
      // the check, or an interactive sign-in is settling the session. Stay
      // in the reconnect backoff, where the next re-dial revalidates the
      // live state; `rejected` would close this stream for good.
      appLogger.debug("[stream-auth] reconnect revalidation superseded", {});
      return "network-error";
    }
    if (outcome.kind === "network-error") {
      appLogger.warn("[stream-auth] reconnect revalidation network error", {});
      return "network-error";
    }
    // outcome.kind === "rejected". A terminal verdict on a held identity
    // demotes rather than clears (`demoteVerifiedSessionToUnverified`), keeping
    // the session and its local-plane admission, silently. So read the
    // projected status, committed before `revalidateCurrentContext` resolves:
    // `rejected` is the credential's verdict, not the session's. A session that
    // still `admitsLocalPlane` (a demotion, or a store-unavailable rotate that
    // stays `signed-in`) keeps the local host's stream open.
    if (admitsLocalPlane(useAuthStore.getState().status)) {
      appLogger.warn("[stream-auth] reconnect revalidation demoted", {
        reason: "cloud-verdict-withdrawn",
      });
      // A host refused (or, pre-dial, would refuse) the held bearer. The
      // service decides whether that ends the local plane, so the unary path
      // and this one apply one rule.
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
    // Only the server pool opens with the sign-in, and its refusal is recovered
    // by `revalidate`; a host-only token's recovery calls
    // `revalidateForReconnect` alone.
    revalidateRefused: () => revalidate(),
  };
}
