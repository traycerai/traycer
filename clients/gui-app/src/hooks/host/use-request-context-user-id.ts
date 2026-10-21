import { useCallback, useSyncExternalStore } from "react";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

/**
 * The user `client`'s request context is signed in as, as a value - `null`
 * when signed out or the credential lease is released.
 *
 * Read it here, never off the client at render time. `setRequestContext`
 * swaps the context INSIDE the one client object, so the compiled renderer
 * memoizes a render-time read on the client's identity and keeps the first
 * answer: a sign-in or an account switch with no host move left every
 * transport key and owner identity derived from it on the previous user.
 * The client announces the swap (`onChange`, reason `auth-changed`), and the
 * snapshot is a string compared by value, so its other change events
 * re-render nothing.
 */
export function useRequestContextUserId<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): string | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      client === null ? () => undefined : client.onChange(onStoreChange),
    [client],
  );
  const getSnapshot = useCallback(
    () => client?.getRequestContextUserId() ?? null,
    [client],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
