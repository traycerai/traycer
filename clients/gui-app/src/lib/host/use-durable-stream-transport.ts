import { useCallback, useEffect, useRef } from "react";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  openDurableStreamTransport,
  type DurableStreamTransport,
} from "@/lib/host/durable-stream-transport";
import { dialableHostEndpoint } from "@/lib/host/transport-key";

/**
 * Returns a referentially-STABLE opener that a session store calls to build the
 * durable transport for a given `hostId` (chat and terminal both use it).
 *
 * The opener is invoked by a session store that OUTLIVES the tile that created
 * it - warm lease-free sessions, and chat's `retry()` long after first render.
 * Every dependency is therefore read through a ref refreshed each render, so a
 * (re)build always wires the LIVE auth revalidator, runner host, credential
 * source, and host directory - never values captured at the render that first
 * created the session. This is why the chat/terminal acquire effects do NOT
 * need these in their dependency arrays: a stale capture is impossible.
 */
export function useDurableStreamTransportFactory(): (
  hostId: string,
) => DurableStreamTransport {
  const directory = useHostDirectory();
  const globalClient = useHostClient();
  const runnerHost = useRunnerHost();
  const auth = useStreamAuthRevalidator();
  const liveRef = useRef({ directory, globalClient, runnerHost, auth });
  useEffect(() => {
    liveRef.current = { directory, globalClient, runnerHost, auth };
  });
  return useCallback((hostId: string) => {
    const target = liveRef.current.directory.findById(hostId);
    if (target === null) {
      // The durable session registries only invoke this opener once their own
      // readiness gate (`authenticatedHostStreamKey`) has already confirmed a
      // dialable directory entry for `hostId` exists — an absent entry here
      // would mean that gate and the directory disagreed, which is a bug in
      // the caller, not a runtime condition to degrade gracefully from.
      throw new Error(`No directory entry for host ${hostId}`);
    }
    const userId = liveRef.current.globalClient.getRequestContextUserId();
    if (userId === null) {
      // Same gate as above (`authenticatedHostStreamKey`) also confirms a
      // bound user before this opener runs - a null here is likewise a
      // caller-gate bug, not a runtime condition to degrade from.
      throw new Error(`No signed-in user for host ${hostId}`);
    }
    return openDurableStreamTransport({
      target,
      userId,
      endpoint: () =>
        dialableHostEndpoint(liveRef.current.directory.findById(hostId)),
      bearer: () =>
        liveRef.current.globalClient.getRequestContext()?.credentials ?? null,
      auth: liveRef.current.auth,
      runnerHost: liveRef.current.runnerHost,
      subscribeBearerRotation: (onRotation) =>
        liveRef.current.globalClient.onBearerRotated(onRotation),
      // Fires on any directory change; `openDurableStreamTransport` filters it
      // down to a genuine endpoint MOVE for THIS `hostId` before re-dialing,
      // so a host restart / re-provision reconnects the session at once
      // instead of waiting out the pong timeout on a half-open socket.
      subscribeEndpointChange: (onChange) => {
        const subscription = liveRef.current.directory.onChange(onChange);
        return () => subscription.dispose();
      },
    });
  }, []);
}
