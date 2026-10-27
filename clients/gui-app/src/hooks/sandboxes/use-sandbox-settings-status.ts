import { useState } from "react";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { sandboxSettingsReady } from "@traycer/protocol/host/sandbox-settings";

let evidenceSequence = 0;
const statusRequests = new WeakMap<EnvironmentStatusResponseV11, number>();

/** A wake or connection change needs its own receipt; background polls keep that receipt valid. */
export function useSandboxSettingsStatus(
  hostId: string | null,
  enabled: boolean,
  lastTransitionAt: number | null,
) {
  const client = useHostClientForHostId(hostId);
  const host = useHostDirectoryEntry(hostId);
  const supported = useHostMethodSupport(hostId, "environment.status");
  const identity = JSON.stringify([
    hostId, enabled, lastTransitionAt, host?.websocketUrl,
    host?.version, host?.transportDialability,
    client?.getRequestContextUserId(),
  ]);
  const [episode, setEpisode] = useState(() => ({identity, started: ++evidenceSequence}));
  let currentEpisode = episode;
  if (episode.identity !== identity) {
    currentEpisode = {identity, started: ++evidenceSequence};
    setEpisode(currentEpisode);
  }
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry, "environment.status", EnvironmentStatusResponseV11, number
  >({
    cacheKeyIdentity: ["sandbox-settings", identity],
    client,
    method: "environment.status",
    params: {},
    captureRequestContext: () => ++evidenceSequence,
    mapResponse: ({response, requestContext}) => {
      statusRequests.set(response, requestContext ?? 0);
      return response;
    },
    options: {
      enabled: enabled && hostId !== null && supported === true,
      poll: true,
      staleTime: 0,
      refetchOnMount: "always",
      structuralSharing: false,
    },
  });
  const ready = supported === false || (
    supported === true && query.data !== undefined &&
    (statusRequests.get(query.data) ?? 0) > currentEpisode.started &&
    query.data.receivedRevision !== null && sandboxSettingsReady(query.data.items)
  );
  return { ...query, ready };
}
