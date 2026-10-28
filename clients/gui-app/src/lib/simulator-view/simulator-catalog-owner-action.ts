import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import type { SimulatorCatalogRecord } from "@traycer/protocol/host/simulator/catalog-contracts";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The machine one row's sessions run on, as an action needs it: the signed-in
 * viewer, a host the directory still names and can reach, and its client. An
 * offline host refuses the action up front, as the browser owner action does,
 * and the row stays until the host is back or its next start retires it.
 */
export interface SimulatorCatalogOwner {
  readonly userId: string | null;
  readonly entry: HostDirectoryEntry | null;
  readonly client: HostClient<HostRpcRegistry> | null;
}

function assertSignedIn(userId: string | null): void {
  if (
    userId === null ||
    useAuthStore.getState().contextMetadata?.userId !== userId
  )
    throw new Error("Sign in to use this simulator.");
}

function readyClient(
  hostId: string,
  owner: SimulatorCatalogOwner,
): HostClient<HostRpcRegistry> {
  assertSignedIn(owner.userId);
  if (owner.entry === null || owner.client === null)
    throw new Error("Couldn't find this device. Try again.");
  if (
    hostUnavailability(owner.entry) === "offline" &&
    !hasReadyRemoteSession(hostId)
  )
    throw new Error("This device is offline.");
  return owner.client;
}

/**
 * Ends every session in `records` with `close@1.1 { sessionId }`, once each:
 * a row's Close ends the person's session and the agent's alike, and a closed
 * row's Dismiss retires the one ended record. Every record in the viewer's
 * snapshot is one the viewer owns: the catalog is read per user.
 */
export async function closeSimulatorCatalogSessions(args: {
  readonly epicId: string;
  readonly hostId: string;
  readonly records: readonly SimulatorCatalogRecord[];
  readonly owner: SimulatorCatalogOwner;
}): Promise<void> {
  const client = readyClient(args.hostId, args.owner);
  for (const record of args.records) {
    if (record.hostId !== args.hostId || record.epicId !== args.epicId)
      throw new Error("Simulator session owner does not match.");
  }
  await Promise.all(
    args.records.map((record) =>
      client.requestWithOptions(
        "simulator.close",
        {
          epicId: args.epicId,
          simulatorId: record.simulatorId,
          shutdown: false,
          sessionId: record.sessionId,
        },
        {
          idempotencyKey: null,
          responseTimeoutMs: null,
          requiredHostMethodVersion: {
            method: "simulator.close",
            version: { major: 1, minor: 1 },
          },
          signal: undefined,
        },
      ),
    ),
  );
}
