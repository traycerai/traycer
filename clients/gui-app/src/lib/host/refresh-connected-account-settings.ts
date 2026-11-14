import { hostAccountSettingsRefreshV10 } from "@traycer/protocol/host/account-settings/contracts";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { StreamRuntimeBinding } from "./stream-runtime-context";
import { readyHostStreamHostIds } from "./host-stream-client-cache";
import { resolveNamedHostClient } from "./binding-host-client";

/** A save nudges only connections this window already holds; it never dials the fleet. */
export async function refreshConnectedAccountSettings(
  binding: HostRuntimeBinding<HostRpcRegistry>,
  stream: StreamRuntimeBinding | null,
  viewerId: string,
  onOriginSignIn: () => boolean,
): Promise<void> {
  const hosts = new Set(readyHostStreamHostIds(viewerId));
  if (
    stream?.hostId !== null &&
    stream?.hostId !== undefined &&
    !stream.wsStreamClient.isClosed() &&
    stream.wsStreamClient.isReady()
  )
    hosts.add(stream.hostId);
  const entries = await binding.directory.list();
  for (const entry of entries) {
    if (
      isRemoteHostDirectoryEntry(entry) &&
      hasReadyRemoteSession(entry.hostId)
    )
      hosts.add(entry.hostId);
  }
  if (!onOriginSignIn()) return;
  await Promise.allSettled(
    [...hosts].map(async (hostId) => {
      const client = resolveNamedHostClient(binding, hostId);
      if (client !== null)
        await client.request(hostAccountSettingsRefreshV10.method, {});
    }),
  );
}
