import { useMemo } from "react";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import { createStreamAuthRevalidator } from "@/lib/auth/stream-auth-revalidator";
import { useAuthService } from "@/lib/host";

/**
 * Stream-side auth recovery shared by every LONG-LIVED host stream: the
 * app-wide epic stream (`HostStreamProvider`) and the per-tab chat/terminal
 * streams (`useHostStreamClientFor`).
 *
 * When the host rejects an open frame with `UNAUTHORIZED` - the bearer
 * expired during an overnight sleep, or rotated mid-session - the transport
 * revalidates through the SAME single-flight call unary RPC uses and reconnects
 * on the normalized outcome instead of going terminal. No client-side `exp`
 * parsing; the host's check stays authoritative. The mapping itself lives in
 * `createStreamAuthRevalidator` (lib/auth) so non-React owners share it.
 *
 * The returned object is referentially stable for a given `AuthService`, so
 * callers can pass it straight into a `WsStreamClient` memo without churning
 * the client.
 */
export function useStreamAuthRevalidator(): StreamAuthRevalidator {
  const authService = useAuthService();
  return useMemo<StreamAuthRevalidator>(
    () => createStreamAuthRevalidator(authService),
    [authService],
  );
}
