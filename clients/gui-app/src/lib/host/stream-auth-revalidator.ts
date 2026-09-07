import { useMemo } from "react";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import { createStreamAuthRevalidator } from "@/lib/auth/stream-auth-revalidator";
import { useAuthService } from "@/lib/host";

/**
 * Stream-side auth recovery shared by every LONG-LIVED host stream: the app-wide epic stream (`HostStreamProvider`) and the per-tab chat/terminal streams (`useHostStreamClientFor`).
 */
export function useStreamAuthRevalidator(): StreamAuthRevalidator {
  const authService = useAuthService();
  return useMemo<StreamAuthRevalidator>(
    () => createStreamAuthRevalidator(authService),
    [authService],
  );
}
