import { useMemo } from "react";
import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import { useAuthService } from "@/lib/host";
import { appLogger } from "@/lib/logger";

/**
 * Stream-side auth recovery shared by every LONG-LIVED host stream: the
 * app-wide epic stream (`HostStreamProvider`) and the per-tab chat/terminal
 * streams (`useHostStreamClientFor`).
 *
 * When the host rejects an open frame with `UNAUTHORIZED` - the bearer
 * expired during an overnight sleep, or rotated mid-session - the transport
 * revalidates through the SAME single-flight call unary RPC uses and reconnects
 * on the normalized outcome instead of going terminal. No client-side `exp`
 * parsing; the host's check stays authoritative.
 *
 * The returned object is referentially stable for a given `AuthService`, so
 * callers can pass it straight into a `WsStreamClient` memo without churning
 * the client.
 */
export function useStreamAuthRevalidator(): StreamAuthRevalidator {
  const authService = useAuthService();
  return useMemo<StreamAuthRevalidator>(
    () => ({
      revalidateForReconnect: async (): Promise<RevalidateOutcome> => {
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
    }),
    [authService],
  );
}
