import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { ElectronTabSurface } from "./agent-browser-tile";
import { BrowserPeekTile } from "./browser-peek-tile";
import { BrowserSessionsHostProvider } from "./browser-session-dock";
import { useBrowserSessionsContext } from "./browser-sessions-context";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useElectronTabBindingOnHost,
  type ElectronTabBinding,
} from "@/lib/browser-view/electron-tabs";
import { appLogger } from "@/lib/logger";
import type {
  BrowserPeekTileRef,
  BrowserSessionTileRef,
} from "@/stores/epics/canvas/types";

export interface BrowserSessionTileProps {
  readonly node: BrowserSessionTileRef;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly epicId: string;
}

function resolveSwapState(args: {
  readonly migrationRuntime:
    NonNullable<BrowserSessionInfo["migration"]>["runtime"] | undefined;
  readonly bindingRegistrationId: string | null;
  readonly terminalBindingRegistrationId: string | null;
  readonly castMigrated: boolean;
}): { readonly renderHeadless: boolean; readonly holdReason: string | null } {
  const renderHeadless =
    args.migrationRuntime === "headless" ||
    args.bindingRegistrationId === null ||
    (args.castMigrated &&
      args.bindingRegistrationId === args.terminalBindingRegistrationId);
  if (!renderHeadless) return { renderHeadless, holdReason: null };
  return {
    renderHeadless,
    holdReason:
      args.bindingRegistrationId === null
        ? "binding-missing"
        : "registration-unchanged",
  };
}

function useBrowserSessionSwap(input: {
  readonly session: BrowserSessionInfo | undefined;
  readonly bindingRegistrationId: string | null;
  readonly sessionId: string;
  readonly tabId: string;
}): {
  readonly renderHeadless: boolean;
  readonly castGeneration: number;
  readonly onMigrated: () => void;
} {
  const [castMigrated, setCastMigrated] = useState(false);
  const [castGeneration, setCastGeneration] = useState(0);
  const [terminalBindingRegistrationId, setTerminalBindingRegistrationId] =
    useState<string | null>(null);
  const bindingRegistrationIdRef = useRef<string | null>(null);
  const latestMigrationRevisionRef = useRef(0);
  const terminalMigrationRevisionRef = useRef(0);
  const swapDecisionSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    bindingRegistrationIdRef.current = input.bindingRegistrationId;
    latestMigrationRevisionRef.current =
      input.session?.migration?.revision ?? 0;
  }, [input.bindingRegistrationId, input.session?.migration?.revision]);

  const onMigrated = useCallback(() => {
    setTerminalBindingRegistrationId(bindingRegistrationIdRef.current);
    terminalMigrationRevisionRef.current = latestMigrationRevisionRef.current;
    setCastMigrated(true);
  }, []);

  useEffect(() => {
    if (
      !castMigrated ||
      input.session?.migration?.runtime !== "headless" ||
      input.session.migration.revision <= terminalMigrationRevisionRef.current
    ) {
      return;
    }
    setCastMigrated(false);
    setCastGeneration((current) => current + 1);
  }, [castMigrated, input.session?.migration]);

  const { renderHeadless, holdReason } = resolveSwapState({
    migrationRuntime: input.session?.migration?.runtime,
    bindingRegistrationId: input.bindingRegistrationId,
    terminalBindingRegistrationId,
    castMigrated,
  });

  useEffect(() => {
    if (!castMigrated) {
      swapDecisionSignatureRef.current = null;
      return;
    }
    const settlementRevision = input.session?.migration?.revision ?? 0;
    const verdict = renderHeadless ? "hold" : "swap";
    const signature = [
      terminalBindingRegistrationId,
      input.bindingRegistrationId,
      settlementRevision,
      verdict,
      holdReason,
    ].join("|");
    if (swapDecisionSignatureRef.current === signature) return;
    swapDecisionSignatureRef.current = signature;
    appLogger.info("Browser runtime swap decision", {
      event: "browser_runtime_swap_decision",
      sessionId: input.sessionId,
      tabId: input.tabId,
      terminalRegistrationId: terminalBindingRegistrationId,
      candidateRegistrationId: input.bindingRegistrationId,
      settlementRevision,
      verdict,
      holdReason,
    });
  }, [
    castMigrated,
    holdReason,
    input.bindingRegistrationId,
    input.session?.migration?.revision,
    input.sessionId,
    input.tabId,
    renderHeadless,
    terminalBindingRegistrationId,
  ]);

  return {
    renderHeadless,
    castGeneration,
    onMigrated,
  };
}

interface BrowserSessionTileBodyProps extends BrowserSessionTileProps {
  readonly session: BrowserSessionInfo | undefined;
  readonly tab: BrowserSessionInfo["tabs"][number] | undefined;
  readonly binding: ElectronTabBinding | null;
  readonly routingChatId: string | null;
  readonly renderHeadless: boolean;
  readonly castGeneration: number;
  readonly onMigrated: () => void;
}

function BrowserSessionTileBody(props: BrowserSessionTileBodyProps) {
  if (props.session === undefined || props.tab === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-ui-sm text-muted-foreground">
        Browser tab is no longer available.
      </div>
    );
  }

  if (props.renderHeadless || props.binding === null) {
    const peek: BrowserPeekTileRef = {
      id: props.node.id,
      instanceId: props.node.instanceId,
      type: "browser-peek",
      name: props.tab.title ?? props.node.name,
      hostId: props.node.hostId,
      chatId: props.routingChatId ?? props.session.createdBy.chatId,
      sessionId: props.node.sessionId,
      tabId: props.node.tabId,
      initialUrl: props.tab.url,
    };
    return (
      <BrowserPeekTile
        key={props.castGeneration}
        epicId={props.epicId}
        node={peek}
        viewTabId={props.viewTabId}
        paneId={props.paneId}
        onMigrated={props.onMigrated}
      />
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
  const wasAvailableRef = useRef(false);
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.paneId,
    props.node.instanceId,
  );
  useEffect(() => {
    if (session !== undefined && tab !== undefined) {
      wasAvailableRef.current = true;
      return;
    }
    if (!wasAvailableRef.current || sessions.lifecycle !== "live") return;
    closeCanvasTile();
  }, [
    closeCanvasTile,
    session,
    sessions.lifecycle,
    tab,
  ]);
  const { renderHeadless, castGeneration, onMigrated } =
    useBrowserSessionSwap({
      session,
      bindingRegistrationId: binding?.registrationId ?? null,
      sessionId: props.node.sessionId,
      tabId: props.node.tabId,
    });

  return (
    <BrowserSessionTileBody
      {...props}
      session={session}
      tab={tab}
      binding={binding}
      routingChatId={sessions.routingChatId}
      renderHeadless={renderHeadless}
      castGeneration={castGeneration}
      onMigrated={onMigrated}
    />
  );
}

function CrossHostBrowserSessionTile(props: BrowserSessionTileProps) {
  const currentSessions = useBrowserSessionsContext();
  const hostClient = useTabHostClient();
  return (
    <BrowserSessionsHostProvider
      hostId={props.node.hostId}
      hostClient={hostClient}
      epicId={props.epicId}
      routingChatId={currentSessions.routingChatId}
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
