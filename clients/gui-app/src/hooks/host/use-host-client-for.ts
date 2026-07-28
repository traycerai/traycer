import { useMemo } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostClient } from "@/lib/host/runtime";

/**
 * Builds a stateless `HostRequester` facade that issues RPCs against `target`
 * WITHOUT `bind()`-ing it as the app-wide active host (which would reload the
 * Epic list and swap app-wide host state).
 *
 * The facade retains only `target`. Each request returns to `globalClient`,
 * which revalidates the target against the directory and captures the shared
 * binding/request authority plus its provider-lifetime coordinator.
 *
 * Returns `null` when `target` has no websocket URL, or there is no
 * authenticated request context / bound user on `globalClient`. Plain
 * function (no hooks) so imperative call sites - a callback or `mutationFn`
 * invoked once per differing `hostId` - can resolve a routed client without
 * violating the rules of hooks; `useHostClientFor` below is the memoized
 * wrapper for render-time single-target consumers.
 */
export function buildTransientHostClient(
  globalClient: HostClient<HostRpcRegistry>,
  target: HostDirectoryEntry,
): HostClient<HostRpcRegistry> | null {
  if (target.websocketUrl === null) return null;
  const requestContext = globalClient.getRequestContext();
  // `null` when signed out or the credential lease was released - the
  // "no bound user" gate.
  const userId = globalClient.getRequestContextUserId();
  if (requestContext === null || userId === null) return null;

  return globalClient.createRequester(target);
}

/**
 * Memoized render-time wrapper over `buildTransientHostClient` for a single,
 * referentially-stable `target`. Settings ▸ Worktrees uses it to list /
 * delete worktrees on whichever host the user selects.
 *
 * Memoized on the target entry + auth identity so the same selection yields a
 * stable client across renders; callers should pass a referentially stable
 * `target` (e.g. memoized by host id).
 */
export function useHostClientFor(
  target: HostDirectoryEntry | null,
): HostClient<HostRpcRegistry> | null {
  const globalClient = useHostClient();
  const requestContext = globalClient.getRequestContext();
  const userId = globalClient.getRequestContextUserId();

  return useMemo(() => {
    // Same gates the builder re-checks internally; read here so the memo
    // rebuilds the client when the auth identity changes (the builder reads
    // both imperatively off `globalClient`).
    if (target === null || requestContext === null || userId === null) {
      return null;
    }
    return buildTransientHostClient(globalClient, target);
  }, [target, globalClient, requestContext, userId]);
}
