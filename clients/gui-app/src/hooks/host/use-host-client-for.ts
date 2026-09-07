import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostRuntimeClient } from "@/lib/host/runtime";
import {
  dialableHostEndpoint,
  dialableHostEndpointFor,
} from "@/lib/host/transport-key";
import { useRemoteSessionPollReadiness } from "@/hooks/agent/use-host-reachability";

/** Stateless requester for target; does not move app-wide host state. Returns null if undialable or unauthenticated. Plain function for mutationFn. */
export function buildDialableHostClient(
  globalClient: HostClient<HostRpcRegistry>,
  target: HostDirectoryEntry,
): HostClient<HostRpcRegistry> | null {
  if (dialableHostEndpoint(target) === null) return null;
  const requestContext = globalClient.getRequestContext();
  // `null` when signed out or the credential lease was released - the
  // "no bound user" gate.
  const userId = globalClient.getRequestContextUserId();
  if (requestContext === null || userId === null) return null;

  return globalClient.createRequester(target);
}

function buildDialableHostClientFor(
  globalClient: HostClient<HostRpcRegistry>,
  target: HostDirectoryEntry,
  hasReadySession: boolean,
): HostClient<HostRpcRegistry> | null {
  if (dialableHostEndpointFor(target, hasReadySession) === null) return null;
  const requestContext = globalClient.getRequestContext();
  const userId = globalClient.getRequestContextUserId();
  if (requestContext === null || userId === null) return null;

  return globalClient.createRequester(target);
}

/** Memoized render-time wrapper over `buildDialableHostClient` for a single, referentially-stable `target`. */
export function useHostClientFor(
  target: HostDirectoryEntry | null,
): HostClient<HostRpcRegistry> | null {
  // The SPINE, not the app-wide client: this builds a requester for an explicitly named host, so taking the effective host's requester here would make the memo churn on every activation and would resolve one host through another host's routing view.
  const globalClient = useHostRuntimeClient();
  const requestContext = globalClient.getRequestContext();
  const userId = globalClient.getRequestContextUserId();
  // Remote-session readiness changes independently of directory rows. Thread
  // the subscribed answer into the canonical predicate instead of reading its
  // pull-only cache inside this memo.
  const hasReadySession = useRemoteSessionPollReadiness(target?.hostId ?? "");

  return useMemo(() => {
    // Same gates the builder re-checks internally; read here so the memo
    // rebuilds the client when the auth identity changes (the builder reads
    // both imperatively off `globalClient`).
    if (target === null || requestContext === null || userId === null) {
      return null;
    }
    return buildDialableHostClientFor(globalClient, target, hasReadySession);
  }, [target, globalClient, hasReadySession, requestContext, userId]);
}
