import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import {
  browserSessionsServerFrameSchema,
  type BrowserSessionInfo,
  type BrowserSessionsClientFrame,
  type BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  authenticatedHostStreamKey,
  authenticatedOwnerIdentityKey,
} from "@/hooks/host/use-host-stream-client-for";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import {
  collectNewAgentTabsFromSessionFrame,
  decideAgentTabDisposition,
  forgetSeenAgentTabsForSession,
  isEpicSurfaceVisible,
  isManualPipActive,
  openAgentTabInPip,
  placeAgentElectronTile,
  rememberElectronTabCreate,
  surfaceAgentTabsFromSessionFrame,
  trackAgentTabSurfaced,
} from "@/lib/browser-view/agent-tab-surfacing";
import {
  createElectronTabs,
  type ElectronTabs,
} from "@/lib/browser-view/electron-tabs";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import { appLogger } from "@/lib/logger";
import {
  applyPipCaption,
  applyPipHostLifecycle,
} from "@/lib/browser-view/pip-store";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  BrowserSessionsContext,
  type BrowserSessionsLifecycle,
  type BrowserSessionsState,
} from "./browser-sessions-context";

type PendingCloseRequest = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

interface BrowserSessionsRenderState {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly items: readonly BrowserSessionInfo[];
  readonly lifecycle: BrowserSessionsLifecycle;
  readonly inventoryReady: boolean;
  readonly errorMessage: string | null;
}

function browserSessionsOwnerIdentityKey(
  hostClient: HostClient<HostRpcRegistry> | null,
  hostEntry: HostDirectoryEntry | null,
): string | null {
  return hostClient === null
    ? null
    : authenticatedOwnerIdentityKey(hostClient, hostEntry);
}

export function BrowserSessionsProvider(props: {
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const hostId = useCanvasHostId();
  const hostClient = useEpicSessionHostClient();
  return (
    <BrowserSessionsHostProvider
      hostId={hostId}
      hostClient={hostClient}
      epicId={props.epicId}
    >
      {props.children}
    </BrowserSessionsHostProvider>
  );
}

export function BrowserSessionsHostProvider(props: {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const runnerHost = useRunnerHost();
  const browserView = runnerHost.browserView;
  const sessions = useBrowserSessions({
    hostId: props.hostId,
    hostClient: props.hostClient,
    epicId: props.epicId,
    browserView,
  });
  return (
    <BrowserSessionsContext.Provider value={sessions}>
      {props.children}
    </BrowserSessionsContext.Provider>
  );
}

interface UseBrowserSessionsArgs {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly browserView: BrowserViewBridge | null;
}

function useBrowserSessions(
  args: UseBrowserSessionsArgs,
): BrowserSessionsState {
  const { hostId, epicId, browserView } = args;
  const hostEntry = useHostDirectoryEntry(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const transportReady =
    args.hostClient !== null &&
    authenticatedHostStreamKey(args.hostClient, hostEntry) !== null;
  const ownerIdentityKey = browserSessionsOwnerIdentityKey(
    args.hostClient,
    hostEntry,
  );
  const openTransport = useDurableStreamTransportFactory();
  // Keep an already-owned transport through a restart's transient non-dialable
  // directory state; its endpoint listener will redial when the new URL lands.
  const [readyOwner, setReadyOwner] = useState<{
    readonly hostId: string;
    readonly identityKey: string;
  } | null>(null);
  if (hostId === null || ownerIdentityKey === null) {
    if (readyOwner !== null) {
      setReadyOwner(null);
    }
  } else if (
    transportReady &&
    (readyOwner?.hostId !== hostId ||
      readyOwner.identityKey !== ownerIdentityKey)
  ) {
    setReadyOwner({ hostId, identityKey: ownerIdentityKey });
  }
  const sessionRef = useRef<{
    sendClientFrame: (
      frame: BrowserSessionsClientFrame,
      binaryPayload: Uint8Array | null,
    ) => void;
  } | null>(null);
  const pendingClosesRef = useRef<Map<string, PendingCloseRequest>>(new Map());
  const [streamState, setStreamState] = useState<BrowserSessionsRenderState>(
    () => ({
      client: null,
      items: [],
      lifecycle: "connecting",
      inventoryReady: false,
      errorMessage: null,
    }),
  );
  const [retryGeneration, setRetryGeneration] = useState(0);
  const lifecycleRef = useRef(streamState.lifecycle);

  useEffect(() => {
    if (hostId === null || readyOwner?.hostId !== hostId) {
      sessionRef.current = null;
      return;
    }
    const pendingCloses = pendingClosesRef.current;
    const transport = openTransport(hostId);
    const client = transport.wsStreamClient;
    const stream = (() => {
      try {
        return client.subscribe("browser.sessions", { epicId });
      } catch (cause) {
        transport.close();
        throw cause;
      }
    })();
    sessionRef.current = stream;
    // Keep one coordinator across this durable subscription's reconnects so
    // native guests can be reused while each connection gets fresh routing.
    const electronTabs = createElectronTabs({
      hostId,
      native: browserView,
      sendFrame: (frame) => {
        stream.sendClientFrame(frame, null);
      },
      present: (frame) => {
        if (frame.reason !== "agent-open") return;
        const disposition = decideAgentTabDisposition({
          mode: useSettingsStore.getState().agentTabSurfacingMode,
          epicVisible: isEpicSurfaceVisible(epicId),
          manualPipActive: isManualPipActive(epicId),
        });
        trackAgentTabSurfaced(disposition, "electron-create");
        if (disposition.action === "tile") {
          placeAgentElectronTile({
            epicId,
            hostId,
            sessionId: frame.sessionId,
            tabId: frame.tabId,
            url: frame.requestedUrl,
          });
          return;
        }
        if (disposition.action === "float") {
          openAgentTabInPip({
            epicId,
            hostId,
            sessionId: frame.sessionId,
            tabId: frame.tabId,
          });
        }
      },
    });
    let electronLifecycleReadySentForConnection = false;
    let snapshotReadyForConnection = false;
    let connectionStatus: StreamConnectionStatus = "connecting";
    let connectionGeneration = 0;
    const sendLifecycleReadyIfReady = (): void => {
      if (
        sessionRef.current !== stream ||
        browserView === null ||
        connectionStatus !== "open" ||
        !snapshotReadyForConnection ||
        electronLifecycleReadySentForConnection
      ) {
        return;
      }
      electronLifecycleReadySentForConnection = true;
      stream.sendClientFrame(
        {
          kind: "electronTabLifecycleReady",
          hasBinaryPayload: false,
        },
        null,
      );
    };
    stream.onStatusChange((status, reason) => {
      if (sessionRef.current !== stream) return;
      const wasOpen = connectionStatus === "open";
      connectionStatus = status;
      const lifecycle = browserSessionsLifecycle(status, reason);
      applyPipHostLifecycle(epicId, hostId, lifecycle);
      lifecycleRef.current = lifecycle;
      if (status !== "open") {
        if (wasOpen) connectionGeneration += 1;
        electronTabs.disconnect();
        electronLifecycleReadySentForConnection = false;
        snapshotReadyForConnection = false;
        rejectPendingRequests(
          pendingCloses,
          new Error("Browser sessions stream closed."),
        );
      } else {
        electronTabs.connect();
        sendLifecycleReadyIfReady();
      }
      setStreamState((current) => ({
        client,
        items: current.client === client ? current.items : [],
        lifecycle,
        inventoryReady: status === "open" && current.inventoryReady,
        errorMessage: browserSessionsError(status, reason),
      }));
    });
    stream.onServerFrame((envelope, binaryPayload) => {
      if (sessionRef.current !== stream) return;
      if (binaryPayload !== null) {
        appLogger.error(
          "[browser] rejected binary browser.sessions frame",
          { byteLength: binaryPayload.byteLength },
          new Error("browser.sessions does not accept binary server frames."),
        );
        return;
      }
      const parsed = browserSessionsServerFrameSchema.safeParse(envelope);
      if (!parsed.success) {
        appLogger.error(
          "[browser] rejected invalid browser.sessions frame",
          {
            frameKind: readFrameKind(envelope),
            issues: parsed.error.message,
          },
          parsed.error,
        );
        return;
      }
      const frameGeneration = connectionGeneration;
      handleBrowserSessionsFrame({
        frame: parsed.data,
        epicId,
        hostId,
        setItems: (value) => {
          setStreamState((current) => {
            const currentItems = current.client === client ? current.items : [];
            const nextItems =
              typeof value === "function" ? value(currentItems) : value;
            return {
              client,
              items: nextItems,
              lifecycle:
                current.client === client ? current.lifecycle : "connecting",
              inventoryReady:
                parsed.data.kind === "snapshot" ||
                (current.client === client && current.inventoryReady),
              errorMessage:
                current.client === client ? current.errorMessage : null,
            };
          });
        },
        pendingCloses,
        browserView,
        electronTabs,
        sendClientFrame: (frame) => {
          if (
            sessionRef.current !== stream ||
            connectionStatus !== "open" ||
            connectionGeneration !== frameGeneration
          ) {
            appLogger.warn(
              "[browser] discarded response from an obsolete stream generation",
              { frameKind: frame.kind },
            );
            return;
          }
          stream.sendClientFrame(frame, null);
        },
      });
      if (
        parsed.data.kind === "snapshot" &&
        (connectionStatus === "connecting" || connectionStatus === "open") &&
        frameGeneration === connectionGeneration
      ) {
        snapshotReadyForConnection = true;
        sendLifecycleReadyIfReady();
      }
    });
    return () => {
      if (sessionRef.current === stream) {
        sessionRef.current = null;
      }
      electronTabs.dispose();
      stream.close();
      transport.close();
      rejectPendingRequests(
        pendingCloses,
        new Error("Browser sessions stream closed."),
      );
    };
  }, [browserView, epicId, hostId, openTransport, readyOwner, retryGeneration]);

  const retry = useCallback(() => {
    setRetryGeneration((current) => current + 1);
  }, []);

  const closeTab = useCallback(
    (sessionId: string, tabId: string): Promise<void> => {
      const session = sessionRef.current;
      if (session === null || lifecycleRef.current !== "live") {
        return Promise.reject(
          new Error("Browser sessions stream is not ready."),
        );
      }
      const pendingCloses = pendingClosesRef.current;
      const requestId = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        pendingCloses.set(requestId, { resolve, reject });
        try {
          session.sendClientFrame(
            {
              kind: "closeTab",
              hasBinaryPayload: false,
              requestId,
              sessionId,
              tabId,
            },
            null,
          );
        } catch (error) {
          pendingCloses.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    [],
  );

  const stateMatchesOwner =
    readyOwner?.hostId === hostId && streamState.client !== null;
  const lifecycle = stateMatchesOwner ? streamState.lifecycle : "connecting";
  useEffect(() => {
    lifecycleRef.current = lifecycle;
  }, [lifecycle]);

  return {
    lifecycle,
    inventoryReady: stateMatchesOwner && streamState.inventoryReady,
    items: stateMatchesOwner ? streamState.items : [],
    errorMessage: stateMatchesOwner ? streamState.errorMessage : null,
    retry,
    closeTab,
  };
}

function handleCloseAck(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly pendingCloses: Map<string, PendingCloseRequest>;
}): boolean {
  if (args.frame.kind !== "actionAck") return false;
  const pending = args.pendingCloses.get(args.frame.requestId);
  if (pending === undefined) return true;
  args.pendingCloses.delete(args.frame.requestId);
  if (args.frame.ok) pending.resolve();
  else {
    pending.reject(new Error(args.frame.reason ?? "Browser action failed."));
  }
  return true;
}

function handleBrowserSessionsFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly epicId: string;
  readonly hostId: string;
  readonly setItems: Dispatch<SetStateAction<readonly BrowserSessionInfo[]>>;
  readonly pendingCloses: Map<string, PendingCloseRequest>;
  readonly browserView: BrowserViewBridge | null;
  readonly electronTabs: ElectronTabs;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
  if (args.frame.kind === "caption") {
    applyPipCaption({
      epicId: args.epicId,
      hostId: args.hostId,
      sessionId: args.frame.sessionId,
      tabId: args.frame.tabId,
      cellTitle: args.frame.cellTitle,
    });
    return;
  }
  if (args.frame.kind === "burstStarted" || args.frame.kind === "burstEnded") {
    return;
  }
  if (args.frame.kind === "createElectronTab") {
    rememberElectronTabCreate(args.frame.sessionId, args.frame.tabId);
  }
  if (args.electronTabs.handleFrame(args.frame)) return;
  if (
    handlePrimaryProfileCaptureFrame({
      frame: args.frame,
      browserView: args.browserView,
      sendClientFrame: args.sendClientFrame,
    })
  ) {
    return;
  }
  if (
    handleBrowserSessionLifecycleFrame({
      frame: args.frame,
      setItems: args.setItems,
    })
  ) {
    return;
  }
  if (handleCloseAck(args)) return;
}

function handlePrimaryProfileCaptureFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly browserView: BrowserViewBridge | null;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): boolean {
  if (args.frame.kind !== "capturePrimaryProfile") return false;
  const requestId = args.frame.requestId;
  if (args.browserView === null) {
    args.sendClientFrame({
      kind: "primaryProfileCaptured",
      hasBinaryPayload: false,
      requestId,
      storageState: null,
      status: "unavailable",
      reason: "Desktop browser bridge is unavailable.",
    });
    return true;
  }
  void args.browserView
    .capturePrimaryProfile()
    .then((result) => {
      if (result.status === "unavailable") {
        args.sendClientFrame({
          kind: "primaryProfileCaptured",
          hasBinaryPayload: false,
          requestId,
          storageState: null,
          status: "unavailable",
          reason: result.reason,
        });
        return;
      }
      args.sendClientFrame({
        kind: "primaryProfileCaptured",
        hasBinaryPayload: false,
        requestId,
        storageState: result.storageState,
        status: "captured",
        reason: null,
      });
    })
    .catch((error: unknown) => {
      args.sendClientFrame({
        kind: "primaryProfileCaptured",
        hasBinaryPayload: false,
        requestId,
        storageState: null,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
}

function handleBrowserSessionLifecycleFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly setItems: Dispatch<SetStateAction<readonly BrowserSessionInfo[]>>;
}): boolean {
  if (args.frame.kind === "snapshot") {
    for (const session of args.frame.sessions) {
      // Seed-only: a snapshot replays the full inventory (initial load,
      // reconnect, renderer reload) and must not re-surface old tabs.
      collectNewAgentTabsFromSessionFrame(session);
    }
    args.setItems(args.frame.sessions);
    return true;
  }
  if (args.frame.kind === "sessionCreated") {
    const session = args.frame.session;
    args.setItems((current) => upsertSession(current, session));
    // A session's inaugural tab stays quiet by design ("tabs only"); this
    // seeds the seen-tab set so later openTab additions are recognized.
    collectNewAgentTabsFromSessionFrame(session);
    return true;
  }
  if (args.frame.kind === "sessionUpdated") {
    const session = args.frame.session;
    args.setItems((current) => upsertSession(current, session));
    // Diff against the last seen tabs and apply the agent-tab-surfacing
    // preference to genuinely new agent-created tabs (headless sessions
    // never emit createElectronTab frames).
    surfaceAgentTabsFromSessionFrame(session);
    return true;
  }
  if (args.frame.kind === "sessionClosed") {
    const sessionId = args.frame.sessionId;
    forgetSeenAgentTabsForSession(sessionId);
    args.setItems((current) =>
      current.filter((session) => session.sessionId !== sessionId),
    );
    return true;
  }
  return false;
}

function upsertSession(
  current: readonly BrowserSessionInfo[],
  next: BrowserSessionInfo,
): readonly BrowserSessionInfo[] {
  const existing = current.findIndex(
    (session) => session.sessionId === next.sessionId,
  );
  if (existing === -1) return [...current, next];
  return current.map((session, index) => (index === existing ? next : session));
}

function browserSessionsLifecycle(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): BrowserSessionsLifecycle {
  if (reason?.kind === "fatalError") return "failed";
  if (status === "open") return "live";
  if (status === "reconnecting") return "reconnecting";
  if (status === "closed") return "closed";
  return "connecting";
}

function browserSessionsError(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): string | null {
  if (reason?.kind === "fatalError") return reason.details.reason;
  if (status === "reconnecting") return "Reconnecting browser sessions.";
  if (status === "closed") return "Browser sessions stream closed.";
  return null;
}

function readFrameKind(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return null;
  }
  return typeof value.kind === "string" ? value.kind : null;
}

function rejectPendingRequests<
  T extends { readonly reject: (error: Error) => void },
>(pendingRequests: Map<string, T>, error: Error): void {
  pendingRequests.forEach((pending) => pending.reject(error));
  pendingRequests.clear();
}
