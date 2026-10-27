import { useCallback } from "react";
import type { BrowserCatalogIdentity } from "@traycer/protocol/host/browser/catalog-contracts";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";
import { jarBridgeForHost } from "@/components/epic-canvas/renderers/use-browser-sessions";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  closeBrowserCatalogTab,
  runBrowserCatalogOwnerAction,
} from "@/lib/browser-view/sessions/browser-catalog-owner-action";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { browserCatalogDiscovery } from "@/lib/browser-view/sessions/browser-catalog-discovery";

/** Resolve the owner at action time; merely mounting a list never dials it. */
export function useBrowserCatalogActions(epicId: string) {
  const directory = useHostDirectory();
  const client = useHostClient();
  const userId = useRequestContextUserId(client);
  const localHostId = useReactiveLocalHostId();
  const runner = useRunnerHost();
  const openTransport = useDurableStreamTransportFactory();
  const navigateNested = useEpicNestedFocusNavigation();
  const ownerContext = useCallback(
    (hostId: string) => {
      const entry = directory.findById(hostId);
      const liveUserId = client.getRequestContextUserId();
      if (userId === null || liveUserId !== userId)
        throw new Error("Sign in to use this browser tab.");
      if (entry === null)
        throw new Error("Couldn't find this device. Try again.");
      if (
        hostUnavailability(entry) === "offline" &&
        !hasReadyRemoteSession(hostId)
      )
        throw new Error("This device is offline.");
      const identityKey = remoteAwareOwnerIdentityKey(entry, userId);
      if (identityKey === null)
        throw new Error("Couldn't connect to this device. Try again.");
      return {
        owner: { hostId, identityKey },
        runtime: {
          browserView: jarBridgeForHost(runner.browserView, entry),
          userId,
          localHostId,
          presentation: null,
          navigateNested,
          openTransport,
        },
      };
    },
    [
      client,
      directory,
      localHostId,
      navigateNested,
      openTransport,
      runner.browserView,
      userId,
    ],
  );
  const closeTab = useCallback(
    async (identity: BrowserCatalogIdentity, tabId: string) => {
      if (identity.epicId !== epicId)
        throw new Error("Browser tab task does not match.");
      try {
        await closeBrowserCatalogTab({
          identity,
          tabId,
          ...ownerContext(identity.hostId),
        });
      } finally {
        if (userId !== null)
          browserCatalogDiscovery({ userId, epicId }).refresh();
      }
    },
    [epicId, ownerContext, userId],
  );
  const withOwner = useCallback(
    async <T>(
      hostId: string,
      action: (state: BrowserSessionsState) => Promise<T>,
    ): Promise<T> =>
      runBrowserCatalogOwnerAction({
        epicId,
        ...ownerContext(hostId),
        requireDurable: false,
        action,
      }),
    [epicId, ownerContext],
  );
  return { closeTab, withOwner };
}
