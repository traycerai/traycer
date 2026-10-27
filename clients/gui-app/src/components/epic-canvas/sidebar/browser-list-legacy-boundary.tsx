import type { ReactNode } from "react";
import { useBrowserCatalogContext } from "@/components/epic-canvas/renderers/browser-catalog-context";
import { BrowserSessionsHostBoundary } from "@/components/epic-canvas/renderers/browser-sessions-provider";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { useBrowserPanelPreferences } from "@/stores/epics/browser-panel-store";

/** Only explicit fallback browsing binds a list to one owner. */
export function BrowserListLegacyBoundary(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}) {
  const catalog = useBrowserCatalogContext();
  const preferences = useBrowserPanelPreferences(props.epicId);
  const pin = useSurfaceHostPin(useTabSurfaceKey("browsers", props.tabId));
  const status = catalog?.inventory.status;
  if (status === "inaccessible" || status === "local-only")
    return props.children;
  let hostId = preferences.legacyHostId;
  if (hostId === null && (status === "unsupported" || catalog === null))
    hostId = pin.resolvedHostId;
  if (hostId === null || catalog?.inventory.revokedHostIds.includes(hostId))
    return props.children;
  return (
    <BrowserSessionsHostBoundary
      hostId={hostId}
      scope={{ kind: "epic", epicId: props.epicId }}
    >
      {props.children}
    </BrowserSessionsHostBoundary>
  );
}
