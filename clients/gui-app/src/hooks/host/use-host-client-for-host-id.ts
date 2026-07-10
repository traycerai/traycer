import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

/**
 * Resolves the `HostClient` a caller mounted OUTSIDE `<TabHostProvider>`
 * should target for an explicit host id captured elsewhere (e.g. a tab's
 * bound host, threaded through as a plain id) - falling back to the app-wide
 * default host's client when `hostId` is `null`. Every globally-mounted
 * surface that must agree on "which host does this id resolve to" (the
 * picker's create-profile capability gate, `ProviderProfileAddFlowHost`
 * itself) shares this one resolution so they can never disagree about the
 * target host.
 */
export function useHostClientForHostId(
  hostId: string | null,
): HostClient<HostRpcRegistry> | null {
  const defaultClient = useHostClient();
  const directory = useHostDirectoryList();
  const targetEntry = useMemo(
    () =>
      hostId === null
        ? null
        : ((directory.data ?? []).find((entry) => entry.hostId === hostId) ??
          null),
    [directory.data, hostId],
  );
  const transientClient = useHostClientFor(targetEntry);
  return hostId === null ? defaultClient : transientClient;
}
