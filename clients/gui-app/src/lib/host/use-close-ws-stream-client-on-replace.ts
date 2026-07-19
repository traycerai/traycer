import { useEffect, useRef } from "react";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Closes a tile-OWNED `WsStreamClient` when it is replaced by a different one,
 * and on unmount - but defers the unmount-close by a microtask guarded by a
 * lifecycle token, so a StrictMode double-invoke or a rapid unmount→remount
 * that hands back the SAME client does not tear down a socket that is about to
 * be reused.
 *
 * Shared by the app-wide `HostStreamProvider` and the transient per-tab
 * `useHostStreamClientBindingFor` (Settings ▸ Worktrees one-shot). Session
 * stores that OWN their transport for a non-React lifetime (chat / terminal)
 * do NOT use this - they tie the socket's teardown to the session via
 * `openDurableStreamTransport`, not to a tile's mount.
 */
export function useCloseWsStreamClientOnReplace(
  client: WsStreamClient<HostStreamRpcRegistry> | null,
): void {
  const currentClientRef = useRef<WsStreamClient<HostStreamRpcRegistry> | null>(
    null,
  );
  const lifecycleTokenRef = useRef(0);
  useEffect(() => {
    lifecycleTokenRef.current += 1;
    const previousClient = currentClientRef.current;
    if (previousClient !== null && previousClient !== client) {
      previousClient.close("replaced-by-owner");
    }
    currentClientRef.current = client;
    return () => {
      lifecycleTokenRef.current += 1;
      const cleanupToken = lifecycleTokenRef.current;
      const closingClient = client;
      queueMicrotask(() => {
        if (lifecycleTokenRef.current !== cleanupToken) {
          return;
        }
        if (currentClientRef.current !== closingClient) {
          return;
        }
        closingClient?.close("owner-unmounted");
        currentClientRef.current = null;
      });
    };
  }, [client]);
}
