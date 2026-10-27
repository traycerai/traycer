import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import { useAuthStore } from "@/stores/auth/auth-store";
import { browserCatalogDiscovery } from "./browser-catalog-discovery";
import { browserCatalogInventory } from "./browser-catalog-inventory";
import {
  browserSessionsOwnerSupportsInventory,
  browserSessionsRetirementRevision,
  subscribeToBrowserSessionsCoordinator,
} from "./browser-sessions-coordinator";

/** Runtime absence can retire a durable tab only after its matching evidence is saved. */
export function useBrowserTabRetirement(args: {
  readonly coordinatorKey: string | null;
  readonly scope: HostResourceScope;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): { readonly canRetire: boolean; readonly refresh: () => void } {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const epicId = args.scope.kind === "epic" ? args.scope.epicId : null;
  const { coordinatorKey, hostId, sessionId, tabId } = args;
  useEffect(() => {
    if (userId === null || epicId === null) return;
    return browserCatalogDiscovery({ userId, epicId }).retainProbe({
      epicId,
      hostId,
      sessionId,
    });
  }, [epicId, hostId, sessionId, userId]);
  const refresh = useCallback(() => {
    if (userId !== null && epicId !== null)
      browserCatalogDiscovery({ userId, epicId }).refresh();
  }, [epicId, userId]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const inventory = browserCatalogInventory.subscribe(listener);
      const coordinator = subscribeToBrowserSessionsCoordinator(
        coordinatorKey,
        listener,
      );
      return () => {
        inventory();
        coordinator();
      };
    },
    [coordinatorKey],
  );
  const read = useCallback((): boolean => {
    if (
      epicId === null ||
      coordinatorKey === null ||
      !browserSessionsOwnerSupportsInventory(coordinatorKey)
    )
      return true;
    if (userId === null) return false;
    const scope = { userId, epicId };
    if (browserCatalogInventory.read(scope).status === "local-only")
      return true;
    return browserCatalogInventory.confirmsTabClosed(scope, {
      hostId,
      sessionId,
      tabId,
      minimumRevision: browserSessionsRetirementRevision(
        coordinatorKey,
        sessionId,
      ),
    });
  }, [coordinatorKey, epicId, hostId, sessionId, tabId, userId]);
  const canRetire = useSyncExternalStore(subscribe, read, () => false);
  return { canRetire, refresh };
}
