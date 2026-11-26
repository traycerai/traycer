import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import { recordMcpPromoteIntent } from "@traycer-clients/shared/environment/mcp-promote-intent";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

interface McpPromoteClick {
  readonly hostId: string | null;
  readonly expectedEnvironmentId: string | null;
  readonly operationId: string;
  readonly serverName: string;
  readonly sourceSelector: string | undefined;
}

/** Records the click on the same computer, environment and sign-in it began on. */
export async function recordMcpPromoteIntentForHost(
  client: HostRequester<HostRpcRegistry>,
  operation: EnvironmentCloud,
  click: McpPromoteClick,
): Promise<string | null> {
  if (
    click.hostId === null ||
    client.getActiveHostId() !== click.hostId ||
    !operation.onOriginSignIn()
  )
    return null;
  const binding = await client.request("environment.host.read", {});
  const environmentId = binding.environment.environmentId;
  if (
    binding.hostId !== click.hostId ||
    binding.sharingGeneration === null ||
    (click.expectedEnvironmentId !== null &&
      environmentId !== click.expectedEnvironmentId) ||
    !operation.onOriginSignIn()
  )
    return null;
  try {
    await recordMcpPromoteIntent(operation, environmentId, {
      operationId: click.operationId,
      sourceHostId: binding.hostId,
      sourceSharingGeneration: binding.sharingGeneration,
      serverName: click.serverName,
      ...(click.sourceSelector === undefined
        ? {}
        : { sourceSelector: click.sourceSelector }),
    });
  } catch {
    return null;
  }
  return environmentId;
}
