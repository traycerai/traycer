import { useId, useState } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { sandboxSettingsReady } from "@traycer/protocol/host/sandbox-settings";

/** A wake or connection change needs its own receipt; background polls keep that receipt valid. */
export function useSandboxSettingsStatus(sandbox: SandboxSummary | null) {
  const hostId = sandbox?.hostId ?? null;
  const client = useHostClientForHostId(hostId);
  const episode = useSettingsEpisode(sandbox, client);
  const supported = useHostMethodSupport(hostId, "environment.status");
  const capability = useHostCapabilityProbe({
    client,
    stale: episode.awake && hostId !== null && supported !== true,
    incarnation: episode.cacheIdentity,
  });
  const query = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: episode.cacheIdentity,
    client,
    method: "environment.status",
    params: {},
    options: {
      enabled: episode.awake && hostId !== null && supported === true,
      poll: true,
      staleTime: 0,
      gcTime: 0,
    },
  });
  const legacyReady = supported === false && capability.data !== undefined;
  const ready = legacyReady || (
    supported === true && query.data !== undefined &&
    query.data.sandboxSettingsOperationId !== null &&
    query.data.principal !== null && query.data.receivedRevision !== null &&
    sandboxSettingsReady(query.data.items)
  );
  return { ...query, ready };
}

/** Cache identity fences both a prior mount's evidence and requests from an earlier wake. */
function useSettingsEpisode(
  sandbox: SandboxSummary | null,
  client: HostClient<HostRpcRegistry> | null,
) {
  const host = useHostDirectoryEntry(sandbox?.hostId ?? null);
  const awake = sandbox?.state === "awake";
  const identity = JSON.stringify([
    sandbox?.hostId, awake, sandbox?.lastTransitionAt,
    host?.websocketUrl, host?.version, host?.transportDialability,
    client?.getRequestContextUserId(),
  ]);
  const mountId = useId();
  const [episode, setEpisode] = useState(() => ({identity, generation: 0}));
  let current = episode;
  if (episode.identity !== identity) {
    current = {identity, generation: episode.generation + 1};
    setEpisode(current);
  }
  return { awake, cacheIdentity: ["sandbox-settings", mountId, identity, current.generation] };
}
