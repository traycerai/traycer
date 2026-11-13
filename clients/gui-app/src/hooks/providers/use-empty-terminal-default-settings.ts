import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useMemo } from "react";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { withEmptyTerminalDefault } from "@/lib/composer/empty-terminal-default";
import type { HostRpcRegistry } from "@/lib/host";

export interface EmptyTerminalDefaultSettings {
  readonly settings: ChatRunSettings | null;
  /**
   * The list that decides is still loading, so `settings` may still move. A
   * caller that copies the default somewhere it stops being a default (a
   * draft) waits this out; a failed list is not pending and leaves the input.
   */
  readonly pending: boolean;
}

/**
 * `withEmptyTerminalDefault` for a seed nobody chose (`isDefault`), read from
 * the `providers.list` of the host the chat is created on and kept loaded
 * while it can move something. Settings someone chose pass through untouched.
 *
 * `client` is the host the chat is created on, for the reason
 * `useResolvedSeededProfileId` takes one.
 */
export function useEmptyTerminalDefaultSettings(
  settings: ChatRunSettings | null,
  isDefault: boolean,
  active: boolean,
  client: HostClient<HostRpcRegistry> | null,
): EmptyTerminalDefaultSettings {
  const applies = isDefault && settings !== null && settings.profileId === null;
  const enabled = active && applies && client !== null;
  const providersQuery = useProvidersListForClient(client, {
    enabled,
    subscribed: enabled,
  });
  const providers = applies ? providersQuery.data?.providers : undefined;
  const pending = enabled && providersQuery.isPending;
  return useMemo(
    () => ({
      settings: withEmptyTerminalDefault(settings, providers),
      pending,
    }),
    [settings, providers, pending],
  );
}
