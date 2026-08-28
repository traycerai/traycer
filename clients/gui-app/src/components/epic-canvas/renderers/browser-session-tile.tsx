import { useEffect } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { ElectronTabSurface } from "./agent-browser-tile";
import { BrowserPeekTile, type BrowserPeekNode } from "./browser-peek-tile";
import { BrowserSessionsHostBoundary } from "./browser-sessions-provider";
import { useBrowserSessionsContext } from "./browser-sessions-context";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import {
  useElectronTabBindingOnHost,
  type ElectronTabBinding,
} from "@/lib/browser-view/sessions/electron-tabs";
import type { BrowserSessionTileRef } from "@/stores/epics/canvas/types";

interface BrowserSessionTileProps {
  readonly node: BrowserSessionTileRef;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly epicId: string;
}

interface BrowserSessionTileBodyProps extends BrowserSessionTileProps {
  readonly session: BrowserSessionInfo | undefined;
  readonly tab: BrowserSessionInfo["tabs"][number] | undefined;
  readonly binding: ElectronTabBinding | null;
  readonly inventoryReady: boolean;
}

function BrowserSessionTileBody(props: BrowserSessionTileBodyProps) {
  if (!props.inventoryReady) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-ui-sm text-muted-foreground">
        Loading browser session…
      </div>
    );
  }
  if (props.session === undefined || props.tab === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-ui-sm text-muted-foreground">
        Browser tab is no longer available.
      </div>
    );
  }

  if (props.session.runtime.kind !== "electron") {
    const peek: BrowserPeekNode = {
      id: props.node.id,
      instanceId: props.node.instanceId,
      hostId: props.node.hostId,
      sessionId: props.node.sessionId,
      tabId: props.node.tabId,
      initialUrl: props.tab.url,
    };
    return (
      <BrowserPeekTile
        key={props.session.runtime.revision}
        epicId={props.epicId}
        node={peek}
        viewTabId={props.viewTabId}
        paneId={props.paneId}
      />
    );
  }

  if (props.binding === null) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-ui-sm text-muted-foreground">
        Reconnecting browser tab…
      </div>
    );
  }

  const native = {
    id: props.node.id,
    sessionId: props.node.sessionId,
    instanceId: props.node.instanceId,
    name: props.tab.title ?? "Browser",
    hostId: props.node.hostId,
    url: props.tab.url,
    viewportPreset: props.node.viewportPreset,
  };
  return (
    <ElectronTabSurface
      node={native}
      binding={props.binding}
      viewTabId={props.viewTabId}
      paneId={props.paneId}
    />
  );
}

function BrowserSessionTileFromProvider(props: BrowserSessionTileProps) {
  const sessions = useBrowserSessionsContext();
  const session = sessions.items.find(
    (item) => item.sessionId === props.node.sessionId,
  );
  const tab = session?.tabs.find((item) => item.tabId === props.node.tabId);
  const binding = useElectronTabBindingOnHost(
    props.node.sessionId,
    props.node.tabId,
    props.node.hostId,
  );
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.paneId,
    props.node.instanceId,
  );
  useEffect(() => {
    if (session !== undefined && tab !== undefined) return;
    if (sessions.lifecycle !== "live" || !sessions.inventoryReady) return;
    closeCanvasTile();
  }, [
    closeCanvasTile,
    sessions.inventoryReady,
    session,
    sessions.lifecycle,
    tab,
  ]);
  return (
    <BrowserSessionTileBody
      {...props}
      session={session}
      tab={tab}
      binding={binding}
      inventoryReady={sessions.inventoryReady}
    />
  );
}

export function BrowserSessionTile(props: BrowserSessionTileProps) {
  return (
    <BrowserSessionsHostBoundary
      hostId={props.node.hostId}
      epicId={props.epicId}
    >
      <BrowserSessionTileFromProvider {...props} />
    </BrowserSessionsHostBoundary>
  );
}
