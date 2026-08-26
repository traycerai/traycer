import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
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
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  authenticatedHostStreamKey,
  authenticatedOwnerIdentityKey,
} from "@/hooks/host/use-host-stream-client-for";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { surfaceAgentTab } from "@/lib/browser-view/agent-tab-surfacing";
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
import {
  BrowserSessionsContext,
  type BrowserSessionsLifecycle,
  type OpenBrowserTabResult,
  type BrowserSessionsState,
} from "./browser-sessions-context";

type PendingCloseRequest = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

type PendingOpenRequest = {
  readonly resolve: (result: OpenBrowserTabResult) => void;
  readonly reject: (error: Error) => void;
};

interface BrowserSessionsOwner {
  readonly hostId: string;
  readonly identityKey: string;
}

interface BrowserSessionsActionChannel {
  readonly owner: BrowserSessionsOwner;
  lifecycle: BrowserSessionsLifecycle;
  readonly sendClientFrame: (
    frame: BrowserSessionsClientFrame,
    binaryPayload: Uint8Array | null,
  ) => void;
}

interface BrowserSessionsCoordinatorRuntime {
  readonly browserView: BrowserViewBridge | null;
  readonly openTransport: (hostId: string) => DurableStreamTransport;
}

interface BrowserSessionsCoordinator {
  readonly owner: BrowserSessionsOwner;
  state: BrowserSessionsState;
  upsertConsumer: (
    consumerId: symbol,
    runtime: BrowserSessionsCoordinatorRuntime,
  ) => void;
  release: (consumerId: symbol) => number;
  dispose: () => void;
}

const browserSessionsCoordinators = new Map<
  string,
  BrowserSessionsCoordinator
>();
const browserSessionsCoordinatorListeners = new Map<string, Set<() => void>>();

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
  const owner = useMemo<BrowserSessionsOwner | null>(
    () =>
      hostId === null || ownerIdentityKey === null
        ? null
        : { hostId, identityKey: ownerIdentityKey },
    [hostId, ownerIdentityKey],
  );
  const ownerCoordinatorKey =
    owner === null ? null : browserSessionsCoordinatorKey(epicId, owner);
  const coordinatorKey =
    ownerCoordinatorKey !== null &&
    (transportReady || browserSessionsCoordinators.has(ownerCoordinatorKey))
      ? ownerCoordinatorKey
      : null;
  const [consumerId] = useState(() => Symbol("browser-sessions-consumer"));
  const acquireCoordinator = useEffectEvent(
    (key: string, selectedOwner: BrowserSessionsOwner): (() => void) =>
      acquireBrowserSessionsCoordinator({
        key,
        consumerId,
        epicId,
        owner: selectedOwner,
        runtime: { browserView, openTransport },
        createIfMissing: transportReady,
      }),
  );

  useEffect(() => {
    if (coordinatorKey === null || owner === null) return;
    return acquireCoordinator(coordinatorKey, owner);
  }, [consumerId, coordinatorKey, epicId, owner]);

  useEffect(() => {
    if (coordinatorKey === null) return;
    browserSessionsCoordinators
      .get(coordinatorKey)
      ?.upsertConsumer(consumerId, { browserView, openTransport });
  }, [browserView, consumerId, coordinatorKey, openTransport]);

  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeToBrowserSessionsCoordinator(coordinatorKey, listener),
    [coordinatorKey],
  );
  const getSnapshot = useCallback(
    () =>
      coordinatorKey === null
        ? null
        : (browserSessionsCoordinators.get(coordinatorKey)?.state ?? null),
    [coordinatorKey],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const unavailableState = useMemo(
    () => unavailableBrowserSessionsState(hostId),
    [hostId],
  );
  return state ?? unavailableState;
}

function browserSessionsCoordinatorKey(
  epicId: string,
  owner: BrowserSessionsOwner,
): string {
  return JSON.stringify([epicId, owner.hostId, owner.identityKey]);
}

function acquireBrowserSessionsCoordinator(args: {
  readonly key: string;
  readonly consumerId: symbol;
  readonly epicId: string;
  readonly owner: BrowserSessionsOwner;
  readonly runtime: BrowserSessionsCoordinatorRuntime;
  readonly createIfMissing: boolean;
}): () => void {
  let coordinator = browserSessionsCoordinators.get(args.key);
  if (coordinator === undefined) {
    if (!args.createIfMissing) return () => undefined;
    coordinator = createBrowserSessionsCoordinator(args);
    browserSessionsCoordinators.set(args.key, coordinator);
  } else {
    coordinator.upsertConsumer(args.consumerId, args.runtime);
  }
  notifyBrowserSessionsCoordinator(args.key);

  const acquired = coordinator;
  return () => {
    if (browserSessionsCoordinators.get(args.key) !== acquired) return;
    if (acquired.release(args.consumerId) !== 0) return;
    browserSessionsCoordinators.delete(args.key);
    acquired.dispose();
    notifyBrowserSessionsCoordinator(args.key);
  };
}

function subscribeToBrowserSessionsCoordinator(
  key: string | null,
  listener: () => void,
): () => void {
  if (key === null) return () => undefined;
  let listeners = browserSessionsCoordinatorListeners.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    browserSessionsCoordinatorListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = browserSessionsCoordinatorListeners.get(key);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) browserSessionsCoordinatorListeners.delete(key);
  };
}

function notifyBrowserSessionsCoordinator(key: string): void {
  browserSessionsCoordinatorListeners
    .get(key)
    ?.forEach((listener) => listener());
}

function unavailableBrowserSessionsState(
  hostId: string | null,
): BrowserSessionsState {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error("Browser sessions stream is not ready."));
  return {
    hostId,
    lifecycle: "connecting",
    inventoryReady: false,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: unavailable,
    closeTab: unavailable,
  };
}

function createBrowserSessionsCoordinator(args: {
  readonly key: string;
  readonly consumerId: symbol;
  readonly epicId: string;
  readonly owner: BrowserSessionsOwner;
  readonly runtime: BrowserSessionsCoordinatorRuntime;
}): BrowserSessionsCoordinator {
  const pendingCloses = new Map<string, PendingCloseRequest>();
  const pendingOpens = new Map<string, PendingOpenRequest>();
  const runtimes = new Map<symbol, BrowserSessionsCoordinatorRuntime>([
    [args.consumerId, args.runtime],
  ]);
  let activeConsumerId: symbol | null = args.consumerId;
  let runtime = args.runtime;
  let actionChannel: BrowserSessionsActionChannel | null = null;
  let stopCurrentStream = (): void => undefined;
  let disposed = false;
  const publish = (state: BrowserSessionsState): void => {
    if (disposed) return;
    coordinator.state = state;
    notifyBrowserSessionsCoordinator(args.key);
  };

  const patchState = (
    patch: Partial<
      Pick<
        BrowserSessionsState,
        "errorMessage" | "inventoryReady" | "items" | "lifecycle"
      >
    >,
  ): void => {
    publish({ ...coordinator.state, ...patch });
  };

  const activeChannel = (): BrowserSessionsActionChannel | null => {
    const channel = actionChannel;
    return channel !== null &&
      channel.lifecycle === "live" &&
      channel.owner === args.owner
      ? channel
      : null;
  };

  const closeTab = (sessionId: string, tabId: string): Promise<void> => {
    const channel = activeChannel();
    if (channel === null) {
      return Promise.reject(new Error("Browser sessions stream is not ready."));
    }
    const requestId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      pendingCloses.set(requestId, { resolve, reject });
      try {
        channel.sendClientFrame(
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
  };

  const openTab = (
    sessionId: string | null,
    url: string,
  ): Promise<OpenBrowserTabResult> => {
    const channel = activeChannel();
    if (channel === null) {
      return Promise.reject(new Error("Browser sessions stream is not ready."));
    }
    const requestId = crypto.randomUUID();
    return new Promise<OpenBrowserTabResult>((resolve, reject) => {
      pendingOpens.set(requestId, { resolve, reject });
      try {
        channel.sendClientFrame(
          {
            kind: "openTab",
            hasBinaryPayload: false,
            requestId,
            sessionId,
            url,
          },
          null,
        );
      } catch (error) {
        pendingOpens.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const start = (): void => {
    patchState({
      items: [],
      lifecycle: "connecting",
      inventoryReady: false,
      errorMessage: null,
    });
    const transport = runtime.openTransport(args.owner.hostId);
    const stream = (() => {
      try {
        return transport.wsStreamClient.subscribe("browser.sessions", {
          epicId: args.epicId,
        });
      } catch (cause) {
        transport.close();
        throw cause;
      }
    })();
    const channel: BrowserSessionsActionChannel = {
      owner: args.owner,
      lifecycle: "connecting",
      sendClientFrame: (frame, binaryPayload) => {
        stream.sendClientFrame(frame, binaryPayload);
      },
    };
    actionChannel = channel;
    const browserView = runtime.browserView;
    const electronTabs = createElectronTabs({
      hostId: args.owner.hostId,
      native: browserView,
      sendFrame: (frame) => {
        if (actionChannel !== channel) return;
        stream.sendClientFrame(frame, null);
      },
    });
    let electronLifecycleReadySentForConnection = false;
    let snapshotReadyForConnection = false;
    let connectionStatus: StreamConnectionStatus = "connecting";
    let connectionGeneration = 0;
    const sendLifecycleReadyIfReady = (): void => {
      if (
        actionChannel !== channel ||
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
      if (actionChannel !== channel) return;
      const wasOpen = connectionStatus === "open";
      connectionStatus = status;
      const lifecycle = browserSessionsLifecycle(status, reason);
      applyPipHostLifecycle(args.epicId, args.owner.hostId, lifecycle);
      channel.lifecycle = lifecycle;
      if (status === "open") {
        electronTabs.connect();
        sendLifecycleReadyIfReady();
      } else {
        if (wasOpen) connectionGeneration += 1;
        electronTabs.disconnect();
        electronLifecycleReadySentForConnection = false;
        snapshotReadyForConnection = false;
        rejectPendingRequests(
          pendingCloses,
          new Error("Browser sessions stream closed."),
        );
        rejectPendingRequests(
          pendingOpens,
          new Error("Browser sessions stream closed."),
        );
      }
      patchState({
        lifecycle,
        inventoryReady: status === "open" && coordinator.state.inventoryReady,
        errorMessage: browserSessionsError(status, reason),
      });
    });

    stream.onServerFrame((envelope, binaryPayload) => {
      if (actionChannel !== channel) return;
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
        epicId: args.epicId,
        hostId: args.owner.hostId,
        setItems: (value) => {
          const nextItems =
            typeof value === "function"
              ? value(coordinator.state.items)
              : value;
          patchState({
            items: nextItems,
            inventoryReady:
              parsed.data.kind === "snapshot" ||
              coordinator.state.inventoryReady,
          });
        },
        pendingCloses,
        pendingOpens,
        browserView,
        electronTabs,
        sendClientFrame: (frame) => {
          if (
            actionChannel !== channel ||
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

    stopCurrentStream = () => {
      if (actionChannel === channel) actionChannel = null;
      electronTabs.dispose();
      stream.close();
      transport.close();
      rejectPendingRequests(
        pendingCloses,
        new Error("Browser sessions stream closed."),
      );
      rejectPendingRequests(
        pendingOpens,
        new Error("Browser sessions stream closed."),
      );
    };
  };

  const restart = (): void => {
    if (disposed) return;
    stopCurrentStream();
    stopCurrentStream = (): void => undefined;
    start();
  };

  const coordinator: BrowserSessionsCoordinator = {
    owner: args.owner,
    state: {
      hostId: args.owner.hostId,
      lifecycle: "connecting",
      inventoryReady: false,
      items: [],
      errorMessage: null,
      retry: restart,
      openTab,
      closeTab,
    },
    upsertConsumer: (consumerId, nextRuntime) => {
      runtimes.set(consumerId, nextRuntime);
      if (activeConsumerId !== consumerId) return;
      const browserViewChanged =
        runtime.browserView !== nextRuntime.browserView;
      runtime = nextRuntime;
      if (browserViewChanged) restart();
    },
    release: (consumerId) => {
      runtimes.delete(consumerId);
      if (activeConsumerId !== consumerId) return runtimes.size;
      const next = runtimes.entries().next().value;
      if (next === undefined) {
        activeConsumerId = null;
        return 0;
      }
      const [nextConsumerId, nextRuntime] = next;
      activeConsumerId = nextConsumerId;
      const browserViewChanged =
        runtime.browserView !== nextRuntime.browserView;
      runtime = nextRuntime;
      if (browserViewChanged) restart();
      return runtimes.size;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopCurrentStream();
      stopCurrentStream = (): void => undefined;
    },
  };
  start();
  return coordinator;
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
  readonly pendingOpens: Map<string, PendingOpenRequest>;
  readonly browserView: BrowserViewBridge | null;
  readonly electronTabs: ElectronTabs;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
  if (args.frame.kind === "openTabResult") {
    const pending = args.pendingOpens.get(args.frame.requestId);
    if (pending === undefined) return;
    args.pendingOpens.delete(args.frame.requestId);
    if (args.frame.result.ok) pending.resolve(args.frame.result);
    else pending.reject(new Error(args.frame.result.reason));
    return;
  }
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
  if (args.frame.kind === "agentTabOpened") {
    surfaceAgentTab({
      epicId: args.epicId,
      hostId: args.hostId,
      sessionId: args.frame.sessionId,
      tabId: args.frame.tabId,
    });
    return;
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
    args.setItems(args.frame.sessions);
    return true;
  }
  if (args.frame.kind === "sessionCreated") {
    const session = args.frame.session;
    args.setItems((current) => upsertSession(current, session));
    return true;
  }
  if (args.frame.kind === "sessionUpdated") {
    const session = args.frame.session;
    args.setItems((current) => upsertSession(current, session));
    return true;
  }
  if (args.frame.kind === "sessionClosed") {
    const sessionId = args.frame.sessionId;
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
