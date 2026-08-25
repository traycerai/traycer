import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserScreencastServerFrame,
  BrowserSessionInfo,
} from "@traycer/protocol/host/browser/contracts";
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
import { appLogger } from "@/lib/logger";
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

type BrowserScreencastCompleteCause = Extract<
  BrowserScreencastServerFrame,
  { readonly kind: "complete" }
>["cause"];

function resolveSwapState(args: {
  readonly runtimeKind: BrowserSessionInfo["runtime"]["kind"] | undefined;
  readonly bindingRegistrationId: string | null;
  readonly terminalBindingRegistrationId: string | null;
  readonly castPlacedInElectron: boolean;
}): { readonly renderPeek: boolean; readonly holdReason: string | null } {
  const renderPeek =
    args.runtimeKind === "headless" ||
    args.bindingRegistrationId === null ||
    (args.castPlacedInElectron &&
      args.bindingRegistrationId === args.terminalBindingRegistrationId);
  if (!renderPeek) return { renderPeek, holdReason: null };
  return {
    renderPeek,
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
  readonly renderPeek: boolean;
  readonly castGeneration: number;
  readonly onComplete: (cause: BrowserScreencastCompleteCause) => void;
} {
  const [castPlacedInElectron, setCastPlacedInElectron] = useState(false);
  const [castGeneration, setCastGeneration] = useState(0);
  const [terminalBindingRegistrationId, setTerminalBindingRegistrationId] =
    useState<string | null>(null);
  const bindingRegistrationIdRef = useRef<string | null>(null);
  const runtimeKindRef = useRef(input.session?.runtime.kind);
  const latestRuntimeRevisionRef = useRef(0);
  const terminalRuntimeRevisionRef = useRef(0);
  const swapDecisionSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    bindingRegistrationIdRef.current = input.bindingRegistrationId;
    runtimeKindRef.current = input.session?.runtime.kind;
    latestRuntimeRevisionRef.current = input.session?.runtime.revision ?? 0;
  }, [input.bindingRegistrationId, input.session?.runtime]);

  const onComplete = useCallback((cause: BrowserScreencastCompleteCause) => {
    if (cause === null) {
      if (runtimeKindRef.current === "headless") {
        setCastGeneration((current) => current + 1);
      }
      return;
    }
    setTerminalBindingRegistrationId(bindingRegistrationIdRef.current);
    terminalRuntimeRevisionRef.current = latestRuntimeRevisionRef.current;
    setCastPlacedInElectron(true);
  }, []);

  useEffect(() => {
    if (
      !castPlacedInElectron ||
      input.session?.runtime.kind !== "headless" ||
      input.session.runtime.revision <= terminalRuntimeRevisionRef.current
    ) {
      return;
    }
    setCastPlacedInElectron(false);
    setCastGeneration((current) => current + 1);
  }, [castPlacedInElectron, input.session?.runtime]);

  const { renderPeek, holdReason } = resolveSwapState({
    runtimeKind: input.session?.runtime.kind,
    bindingRegistrationId: input.bindingRegistrationId,
    terminalBindingRegistrationId,
    castPlacedInElectron,
  });

  useEffect(() => {
    if (!castPlacedInElectron) {
      swapDecisionSignatureRef.current = null;
      return;
    }
    const settlementRevision = input.session?.runtime.revision ?? 0;
    const verdict = renderPeek ? "hold" : "swap";
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
    castPlacedInElectron,
    holdReason,
    input.bindingRegistrationId,
    input.session?.runtime.revision,
    input.sessionId,
    input.tabId,
    renderPeek,
    terminalBindingRegistrationId,
  ]);

  return {
    renderPeek,
    castGeneration,
    onComplete,
  };
}

interface BrowserSessionTileBodyProps extends BrowserSessionTileProps {
  readonly session: BrowserSessionInfo | undefined;
  readonly tab: BrowserSessionInfo["tabs"][number] | undefined;
  readonly binding: ElectronTabBinding | null;
  readonly renderPeek: boolean;
  readonly castGeneration: number;
  readonly onComplete: (cause: BrowserScreencastCompleteCause) => void;
}

function BrowserSessionTileBody(props: BrowserSessionTileBodyProps) {
  if (props.session === undefined || props.tab === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-ui-sm text-muted-foreground">
        Browser tab is no longer available.
      </div>
    );
  }

  if (props.renderPeek || props.binding === null) {
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
        key={props.castGeneration}
        epicId={props.epicId}
        node={peek}
        viewTabId={props.viewTabId}
        paneId={props.paneId}
        onComplete={props.onComplete}
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
  const { renderPeek, castGeneration, onComplete } = useBrowserSessionSwap({
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
      renderPeek={renderPeek}
      castGeneration={castGeneration}
      onComplete={onComplete}
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
