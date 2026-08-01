import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

/**
 * Resolves the `HostClient` a caller mounted OUTSIDE `<TabHostProvider>`
 * should target for an explicit host id captured elsewhere (e.g. a tab's
 * bound host, threaded through as a plain id) - reusing the app-wide default
 * host's client when `hostId` is `null` or already names that bound host.
 * Every globally-mounted surface that must agree on "which host does this id
 * resolve to" (the picker's create-profile capability gate,
 * `ProviderProfileAddFlowHost` itself) shares this one resolution so they can
 * never disagree about the target host.
 */
export function useHostClientForHostId(
  hostId: string | null,
): HostClient<HostRpcRegistry> | null {
  const defaultClient = useHostClient();
  const defaultHostId = defaultClient.getActiveHostId();
  const directory = useHostDirectoryList();
  const targetEntry = useMemo(
    () =>
      hostId === null || hostId === defaultHostId
        ? null
        : ((directory.data ?? []).find((entry) => entry.hostId === hostId) ??
          null),
    [defaultHostId, directory.data, hostId],
  );
  const transientClient = useHostClientFor(targetEntry);
  return hostId === null || hostId === defaultHostId
    ? defaultClient
    : transientClient;
}
