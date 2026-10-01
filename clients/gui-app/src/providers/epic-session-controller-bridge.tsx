import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useAuthService,
  useHostBinding,
  type HostRpcRegistry,
} from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import {
  installEpicSessionControllerEnvironment,
  uninstallEpicSessionControllerEnvironment,
  type EpicSessionControllerEnvironment,
} from "@/lib/registries/epic-session-controller";
// For its side effect: membership is live from the moment the controller has
// an environment to acquire with, whether or not a tab host has rendered.
import "@/lib/epics/epic-parking-open-tabs";

/**
 * Hands the epic session controller the things it needs from the app that
 * only React can reach: the durable transport opener (the runner host is
 * context-only), a requester for a named host off the app binding, and auth
 * revalidation.
 *
 * App-level on purpose, and NOT a provider callback: the controller acquires
 * sessions for tabs no surface is mounted for, so its environment has to
 * exist for as long as the authenticated runtime does rather than for as long
 * as some epic happens to be on screen. Everything that is a fact about a tab
 * or a session - ownership, host selection, retry, backoff - is controller
 * state and is not passed through here.
 */
export function EpicSessionControllerBridge(): ReactNode {
  const openTransport = useDurableStreamTransportFactory();
  const binding = useHostBinding();
  const authService = useAuthService();
  // App-lifetime, like everything else here: the History, task-context and
  // home write-throughs belong to the live session, not to a mounted surface.
  const queryClient = useQueryClient();

  const environment = useMemo((): EpicSessionControllerEnvironment => {
    // One requester per host for the life of this binding: every consumer of
    // a host must address one client object, and `handleHostClients` is
    // compared by identity. A new binding is a new map, which is exactly when
    // the requesters legitimately rotate.
    const clients = new Map<string, HostClient<HostRpcRegistry> | null>();
    return {
      openTransport,
      resolveHostClient: (hostId) => {
        if (clients.has(hostId)) return clients.get(hostId) ?? null;
        const client = resolveNamedHostClient(binding, hostId);
        clients.set(hostId, client);
        return client;
      },
      revalidateAuth: () => {
        void authService.revalidateCurrentContext();
      },
      queryClient,
    };
  }, [authService, binding, openTransport, queryClient]);

  // Counts installs so a deferred cleanup can tell "this environment was
  // torn down" from "this environment was re-installed after my cleanup ran".
  // React StrictMode (dev) mounts, cleans up and re-mounts the effect with the
  // SAME environment object; a deferred uninstall keyed on identity alone then
  // nulls the environment the re-mount just installed, and no epic session can
  // start for the rest of the window.
  const installSeq = useRef(0);
  useEffect(() => {
    installSeq.current += 1;
    const seq = installSeq.current;
    installEpicSessionControllerEnvironment(environment);
    return () => {
      // Deferred, and only if still current: a binding change runs this
      // cleanup a moment before the next environment installs, and a `null`
      // in between would cancel every in-flight re-point for nothing.
      queueMicrotask(() => {
        if (installSeq.current !== seq) return;
        uninstallEpicSessionControllerEnvironment(environment);
      });
    };
  }, [environment]);

  return null;
}
