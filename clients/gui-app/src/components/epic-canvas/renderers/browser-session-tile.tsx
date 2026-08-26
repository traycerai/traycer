import { useEffect } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { ElectronTabSurface } from "./agent-browser-tile";
import { BrowserPeekTile } from "./browser-peek-tile";
import { BrowserSessionsHostProvider } from "./browser-sessions-provider";
import { useBrowserSessionsContext } from "./browser-sessions-context";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useElectronTabBindingOnHost,
  type ElectronTabBinding,
} from "@/lib/browser-view/electron-tabs";
import type {
  BrowserPeekTileRef,
  BrowserSessionTileRef,
} from "@/stores/epics/canvas/types";

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
    const peek: BrowserPeekTileRef = {
      id: props.node.id,
      instanceId: props.node.instanceId,
      type: "browser-peek",
      name: props.tab.title ?? props.node.name,
      hostId: props.node.hostId,
      chatId: props.session.createdBy.chatId,
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
    name: props.tab.title ?? props.node.name,
    hostId: props.node.hostId,
    url: props.tab.url,
    viewportPreset: "responsive",
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

function CrossHostBrowserSessionTile(props: BrowserSessionTileProps) {
  const hostClient = useTabHostClient();
  return (
    <BrowserSessionsHostProvider
      hostId={props.node.hostId}
      hostClient={hostClient}
      epicId={props.epicId}
    >
      <BrowserSessionTileFromProvider {...props} />
    </BrowserSessionsHostProvider>
  );
}

export function BrowserSessionTile(props: BrowserSessionTileProps) {
  const canvasHostId = useCanvasHostId();
  return props.node.hostId === canvasHostId ? (
    <BrowserSessionTileFromProvider {...props} />
  ) : (
    <CrossHostBrowserSessionTile {...props} />
  );
}
