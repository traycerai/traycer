import { hostAccountSettingsRefreshV10 } from "@traycer/protocol/host/account-settings/contracts";
import { tryAcquireReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
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
    if (isRemoteHostDirectoryEntry(entry)) hosts.add(entry.hostId);
  }
  await Promise.allSettled(
    [...hosts].map(async (hostId) => {
      if (!onOriginSignIn()) return;
      const entry = binding.directory.findById(hostId);
      if (entry === null) return;
      if (isRemoteHostDirectoryEntry(entry)) {
        // The directory's readiness can be stale by dispatch. Borrowing has no
        // factory and refuses closed, superseded and zero-owner lingering sessions.
        const borrowed = tryAcquireReadyRemoteSession<HostRpcRegistry>(hostId);
        if (borrowed === null) return;
        try {
          if (borrowed.identity.userId !== viewerId) return;
          await borrowed.sendUnary(
            hostAccountSettingsRefreshV10.method,
            {},
            null,
            undefined,
          );
        } finally {
          borrowed.release();
        }
        return;
      }
      if (entry.kind !== "local") return;
      const client = resolveNamedHostClient(binding, hostId);
      if (client !== null)
        await client.request(hostAccountSettingsRefreshV10.method, {});
    }),
  );
}
