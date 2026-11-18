import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useGuiHarnessesQueryForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useOnTeamSandbox } from "@/hooks/sandboxes/use-on-team-sandbox";
import type { HostRpcRegistry } from "@/lib/host";
import { teamSandboxHarnessBlocked } from "@/lib/sandboxes/team-sandbox-harness";

/**
 * Which harnesses `hostId` does not offer when it is a team's sandbox, as a
 * predicate over a harness id. Fails closed while the host's harness list has
 * not answered, and for a harness the list does not carry. Blocks nothing on
 * any other host.
 */
export function useTeamSandboxHarnessGate(input: {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
}): (harnessId: string) => boolean {
  const onTeamSandbox = useOnTeamSandbox(input.hostId);
  const harnessesQuery = useGuiHarnessesQueryForClient(input.client, {
    enabled: onTeamSandbox,
    subscribed: onTeamSandbox,
  });
  const harnesses = harnessesQuery.data?.harnesses ?? null;
  return useCallback(
    (harnessId: string) => {
      if (!onTeamSandbox) return false;
      const entry = harnesses?.find((harness) => harness.id === harnessId);
      return teamSandboxHarnessBlocked(
        entry?.sandboxCredentialMode ?? null,
        true,
      );
    },
    [harnesses, onTeamSandbox],
  );
}

/** `useTeamSandboxHarnessGate` for one harness; `false` with none. */
export function useTeamSandboxHarnessBlocked(input: {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly harnessId: string | null;
}): boolean {
  const blocked = useTeamSandboxHarnessGate({
    hostId: input.hostId,
    client: input.client,
  });
  return input.harnessId !== null && blocked(input.harnessId);
}
