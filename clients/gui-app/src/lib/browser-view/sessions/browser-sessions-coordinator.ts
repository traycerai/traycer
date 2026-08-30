import type {
  BrowserSessionInfo,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
  BrowserTabIdentity,
} from "@traycer/protocol/host/browser/contracts";
import { BrowserSessionsStreamClient } from "@traycer-clients/shared/host-transport/browser-sessions-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";
import { surfaceAgentTab } from "@/lib/browser-view/tiles/agent-tab-surfacing";
import {
  browserSessionsLifecycle,
  browserSessionsReducer,
  type BrowserSessionsLifecycle,
} from "@/lib/browser-view/sessions/browser-sessions-stream";
import {
  createElectronTabs,
  type ElectronTabs,
} from "@/lib/browser-view/sessions/electron-tabs";
import {
  applyPipCaption,
  applyPipHostLifecycle,
} from "@/lib/browser-view/pip/pip-store";

export interface BrowserSessionsState {
  readonly hostId: string | null;
  readonly lifecycle: BrowserSessionsLifecycle;
  /** True only after the current stream incarnation supplied its full snapshot. */
  readonly inventoryReady: boolean;
  readonly items: readonly BrowserSessionInfo[];
  readonly errorMessage: string | null;
  readonly retry: () => void;
  readonly openTab: (
    sessionId: string | null,
    url: string,
  ) => Promise<BrowserTabIdentity>;
  readonly closeTab: (sessionId: string, tabId: string) => Promise<void>;
}

/**
 * One epic's browser inventory, keyed by {epic, host, authenticated owner}.
 * The registry is module-global because several React surfaces (the canvas
 * tiles, the sidebar, the PiP bridge) subscribe to the same stream and must
 * not each open one - consumers refcount into a single coordinator.
 */
export interface BrowserSessionsOwner {
  readonly hostId: string;
  readonly identityKey: string;
}

interface BrowserSessionsCoordinatorRuntime {
  readonly browserView: BrowserViewBridge | null;
  readonly openTransport: (hostId: string) => DurableStreamTransport;
}

type PendingCloseRequest = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

type PendingOpenRequest = {
  readonly resolve: (result: BrowserTabIdentity) => void;
  readonly reject: (error: Error) => void;
};

interface BrowserSessionsActionChannel {
  readonly owner: BrowserSessionsOwner;
  lifecycle: BrowserSessionsLifecycle;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}

interface BrowserSessionsCoordinator {
  readonly owner: BrowserSessionsOwner;
  state: BrowserSessionsState;
  /** Sends `forgetLogins` if this coordinator's stream is live. */
  forgetLogins: () => boolean;
  /** Sends `clearSite` for one domain if this coordinator's stream is live. */
  clearSite: (domain: string) => boolean;
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

export function browserSessionsCoordinatorKey(
  epicId: string,
  owner: BrowserSessionsOwner,
): string {
  return JSON.stringify([epicId, owner.hostId, owner.identityKey]);
}

export function hasBrowserSessionsCoordinator(key: string): boolean {
  return browserSessionsCoordinators.has(key);
}

export function browserSessionsCoordinatorState(
  key: string | null,
): BrowserSessionsState | null {
  if (key === null) return null;
  return browserSessionsCoordinators.get(key)?.state ?? null;
}

export function upsertBrowserSessionsCoordinatorConsumer(
  key: string,
  consumerId: symbol,
  runtime: BrowserSessionsCoordinatorRuntime,
): void {
  browserSessionsCoordinators.get(key)?.upsertConsumer(consumerId, runtime);
}

export function acquireBrowserSessionsCoordinator(args: {
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

export function subscribeToBrowserSessionsCoordinator(
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

/**
 * "Forget all browser logins" (spec §6.5, ticket 08). Answers whether any live
 * stream took it, so a caller can say "not connected" rather than claim a shred
 * that never happened.
 *
 * Sent once per host, not once per coordinator: coordinators are keyed by
 * {epic, host, identity}, and the frame speaks for the user's whole slice on
 * that host, so a second one for another epic of the same host would only ask
 * for the same shred twice. Every host the user has a live browser stream to is
 * addressed - "all" is the whole point of the action, and each host keeps its
 * own key and its own slice.
 *
 * Module-level, not a tile-scoped action: the trigger is temporary (the shield
 * popover) and moves to Settings › Browser in ticket 10, which has no tile to
 * hang it off either.
 */
export function forgetAllBrowserLogins(): boolean {
  const addressedHostIds = new Set<string>();
  let sent = false;
  for (const coordinator of browserSessionsCoordinators.values()) {
    const hostId = coordinator.owner.hostId;
    if (addressedHostIds.has(hostId)) continue;
    if (!coordinator.forgetLogins()) continue;
    addressedHostIds.add(hostId);
    sent = true;
  }
  return sent;
}

/**
 * "Clear" on one row of Settings > Browser (spec section 7.3, ticket 10).
 * Answers whether any live stream took it.
 *
 * Deduped per host and addressed to every host the same way
 * {@link forgetAllBrowserLogins} is, and for the same reason: each host keeps
 * its own slice, and a site the user asked to forget is not one they meant to
 * keep on the machine they happen not to be looking at. The frame carries the
 * domain rather than a tile key - unlike the tile menu's clear-site, there is
 * no tile here whose URL could name the site, and the domain came from the
 * host's own list in the first place.
 */
export function clearSavedLoginSite(domain: string): boolean {
  const addressedHostIds = new Set<string>();
  let sent = false;
  for (const coordinator of browserSessionsCoordinators.values()) {
    const hostId = coordinator.owner.hostId;
    if (addressedHostIds.has(hostId)) continue;
    if (!coordinator.clearSite(domain)) continue;
    addressedHostIds.add(hostId);
    sent = true;
  }
  return sent;
}

function notifyBrowserSessionsCoordinator(key: string): void {
  browserSessionsCoordinatorListeners
    .get(key)
    ?.forEach((listener) => listener());
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
        channel.sendClientFrame({
          kind: "closeTab",
          hasBinaryPayload: false,
          requestId,
          sessionId,
          tabId,
        });
      } catch (error) {
        pendingCloses.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const openTab = (
    sessionId: string | null,
    url: string,
  ): Promise<BrowserTabIdentity> => {
    const channel = activeChannel();
    if (channel === null) {
      return Promise.reject(new Error("Browser sessions stream is not ready."));
    }
    const requestId = crypto.randomUUID();
    return new Promise<BrowserTabIdentity>((resolve, reject) => {
      pendingOpens.set(requestId, { resolve, reject });
      try {
        channel.sendClientFrame({
          kind: "openTab",
          hasBinaryPayload: false,
          requestId,
          sessionId,
          url,
        });
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
    let stream: BrowserSessionsStreamClient | null = null;
    const channel: BrowserSessionsActionChannel = {
      owner: args.owner,
      lifecycle: "connecting",
      sendClientFrame: (frame) => {
        stream?.sendClientFrame(frame);
      },
    };
    actionChannel = channel;
    const browserView = runtime.browserView;
    const electronTabs = createElectronTabs({
      hostId: args.owner.hostId,
      native: browserView,
      sendFrame: (frame) => {
        if (actionChannel !== channel) return;
        stream?.sendClientFrame(frame);
      },
    });
    let electronLifecycleReadySentForConnection = false;
    let snapshotReadyForConnection = false;
    let connectionStatus: StreamConnectionStatus = "connecting";
    let connectionGeneration = 0;
    // Unsolicited cookie deltas from the durable `primary` jar (spec §6.3).
    // Gated on this connection having sent `electronTabLifecycleReady`: the
    // host only hears the elected lifecycle subscriber, so a second window's
    // forward would be dropped there anyway - not sending it keeps the stream
    // honest about who speaks for the jar.
    const primaryProfileDeltas =
      browserView?.onPrimaryProfileDelta((delta) => {
        if (
          actionChannel !== channel ||
          connectionStatus !== "open" ||
          !electronLifecycleReadySentForConnection
        ) {
          return;
        }
        stream?.sendClientFrame({
          kind: "primaryProfileDelta",
          hasBinaryPayload: false,
          ...delta,
        });
      }) ?? null;
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
      stream?.sendClientFrame({
        kind: "electronTabLifecycleReady",
        hasBinaryPayload: false,
      });
      // This machine can hold the host's store key. The host answers with a
      // wrap or an unwrap request (handled below); it ignores the offer when
      // it already has the key in memory. It belongs with the frame that
      // elects this connection: the host only hears the elected subscriber.
      stream?.sendClientFrame({
        kind: "storeKeyOffer",
        hasBinaryPayload: false,
      });
    };

    const onConnectionStatus = (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ): void => {
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
    };

    const onServerFrame = (frame: BrowserSessionsServerFrame): void => {
      if (actionChannel !== channel) return;
      const frameGeneration = connectionGeneration;
      handleBrowserSessionsFrame({
        frame,
        epicId: args.epicId,
        hostId: args.owner.hostId,
        setItems: (items) => {
          patchState({
            items,
            inventoryReady:
              frame.kind === "snapshot" || coordinator.state.inventoryReady,
          });
        },
        pendingCloses,
        pendingOpens,
        browserView,
        electronTabs,
        sendClientFrame: (response) => {
          if (
            actionChannel !== channel ||
            connectionStatus !== "open" ||
            connectionGeneration !== frameGeneration
          ) {
            appLogger.warn(
              "[browser] discarded response from an obsolete stream generation",
              { frameKind: response.kind },
            );
            return;
          }
          stream?.sendClientFrame(response);
        },
        currentItems: () => coordinator.state.items,
      });
      if (
        frame.kind === "snapshot" &&
        (connectionStatus === "connecting" || connectionStatus === "open") &&
        frameGeneration === connectionGeneration
      ) {
        snapshotReadyForConnection = true;
        sendLifecycleReadyIfReady();
      }
    };

    try {
      stream = new BrowserSessionsStreamClient({
        wsStreamClient: transport.wsStreamClient,
        epicId: args.epicId,
        callbacks: { onServerFrame, onConnectionStatus },
      });
    } catch (cause) {
      primaryProfileDeltas?.dispose();
      electronTabs.dispose();
      transport.close();
      throw cause;
    }
    const opened = stream;

    stopCurrentStream = () => {
      if (actionChannel === channel) actionChannel = null;
      primaryProfileDeltas?.dispose();
      electronTabs.dispose();
      opened.close();
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
    forgetLogins: () => {
      const channel = activeChannel();
      if (channel === null) return false;
      channel.sendClientFrame({
        kind: "forgetLogins",
        hasBinaryPayload: false,
      });
      return true;
    },
    clearSite: (domain) => {
      const channel = activeChannel();
      if (channel === null) return false;
      channel.sendClientFrame({
        kind: "clearSite",
        hasBinaryPayload: false,
        domain,
      });
      return true;
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

function handleCloseAck(
  frame: Extract<BrowserSessionsServerFrame, { readonly kind: "actionAck" }>,
  pendingCloses: Map<string, PendingCloseRequest>,
): void {
  const pending = pendingCloses.get(frame.requestId);
  if (pending === undefined) return;
  pendingCloses.delete(frame.requestId);
  if (frame.ok) pending.resolve();
  else pending.reject(new Error(frame.reason ?? "Browser action failed."));
}

/**
 * The one router for `browser.sessions` server frames. Every frame kind names
 * the subsystem that owns it, and the exhaustive default makes a protocol
 * addition a compile error instead of a frame that silently falls through.
 */
function handleBrowserSessionsFrame(args: {
  readonly frame: BrowserSessionsServerFrame;
  readonly epicId: string;
  readonly hostId: string;
  readonly currentItems: () => readonly BrowserSessionInfo[];
  readonly setItems: (items: readonly BrowserSessionInfo[]) => void;
  readonly pendingCloses: Map<string, PendingCloseRequest>;
  readonly pendingOpens: Map<string, PendingOpenRequest>;
  readonly browserView: BrowserViewBridge | null;
  readonly electronTabs: ElectronTabs;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
  const frame = args.frame;
  switch (frame.kind) {
    case "snapshot":
    case "sessionCreated":
    case "sessionUpdated":
    case "sessionClosed": {
      const nextItems = browserSessionsReducer(args.currentItems(), frame);
      if (nextItems !== null) args.setItems(nextItems);
      return;
    }
    case "createElectronTab":
    case "electronTabAccepted":
    case "releaseElectronTab":
    case "cdpRequest":
      args.electronTabs.handleFrame(frame);
      return;
    case "actionAck":
      // Handoff acks and close acks share one frame kind; the Electron layer
      // claims only the request ids it registered.
      if (args.electronTabs.handleFrame(frame)) return;
      handleCloseAck(frame, args.pendingCloses);
      return;
    default:
      handleBrowserSessionsSubsystemFrame({
        frame,
        epicId: args.epicId,
        hostId: args.hostId,
        pendingOpens: args.pendingOpens,
        browserView: args.browserView,
        sendClientFrame: args.sendClientFrame,
      });
  }
}

/**
 * Second half of the router: every frame kind the session-list and Electron
 * tab layers above do not claim. Kept as its own function so each half stays
 * under the lint complexity cap; the `never` binding below still turns a new
 * protocol frame kind into a compile error.
 */
type BrowserSessionsSubsystemFrame = Exclude<
  BrowserSessionsServerFrame,
  {
    readonly kind:
      | "snapshot"
      | "sessionCreated"
      | "sessionUpdated"
      | "sessionClosed"
      | "createElectronTab"
      | "electronTabAccepted"
      | "releaseElectronTab"
      | "cdpRequest"
      | "actionAck";
  }
>;

function handleBrowserSessionsSubsystemFrame(args: {
  readonly frame: BrowserSessionsSubsystemFrame;
  readonly epicId: string;
  readonly hostId: string;
  readonly pendingOpens: Map<string, PendingOpenRequest>;
  readonly browserView: BrowserViewBridge | null;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
  const frame = args.frame;
  switch (frame.kind) {
    case "openTabResult": {
      const pending = args.pendingOpens.get(frame.requestId);
      if (pending === undefined) return;
      args.pendingOpens.delete(frame.requestId);
      if (frame.result.ok) pending.resolve(frame.result);
      else pending.reject(new Error(frame.result.reason));
      return;
    }
    case "caption":
      applyPipCaption({
        epicId: args.epicId,
        hostId: args.hostId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        cellTitle: frame.cellTitle,
      });
      return;
    case "agentTabOpened":
      surfaceAgentTab({
        epicId: args.epicId,
        hostId: args.hostId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
      });
      return;
    case "capturePrimaryProfile":
      handlePrimaryProfileCaptureFrame({
        frame,
        browserView: args.browserView,
        sendClientFrame: args.sendClientFrame,
      });
      return;
    case "primaryProfileForgotten":
      // The host has already shredded its slice for this user; this is the
      // desktop's turn. Fire-and-forget: there is no frame to answer with, and
      // a machine with no bridge (a browser tab) has no jar to clear.
      void args.browserView?.forgetLogins().catch((cause: unknown) => {
        appLogger.warn("[browser] clearing the browser partition failed", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      });
      return;
    case "primaryProfileEvict":
      handlePrimaryProfileEvictFrame({
        frame,
        browserView: args.browserView,
      });
      return;
    case "storeKeyWrapRequest":
    case "storeKeyUnwrapRequest":
      handleStoreKeyRequestFrame({
        frame,
        browserView: args.browserView,
        sendClientFrame: args.sendClientFrame,
      });
      return;
    case "burstStarted":
    case "burstEnded":
    case "pong":
      return;
    default: {
      // Unreachable: the stream client validates every frame against
      // `browserSessionsServerFrameSchema` before it gets here. The `never`
      // binding is what turns a new protocol frame kind into a compile error.
      const unhandled: never = frame;
      void unhandled;
      appLogger.warn("[browser] unhandled browser.sessions frame", {
        frameKind: args.frame.kind,
      });
    }
  }
}

/**
 * One site's logins were cleared for this user somewhere else (spec §6.5) - on
 * another desktop, or as a tombstone the host's store recorded. This partition
 * drops the same site.
 *
 * Nothing is sent back: the frame is a fan-out, not a request, and the desktop
 * deliberately emits no delta for the removal - the store decided these
 * tombstones before it sent the frame, so an echo would only re-assert them. A
 * window with no desktop bridge has no jar to evict from.
 */
function handlePrimaryProfileEvictFrame(args: {
  readonly frame: Extract<
    BrowserSessionsServerFrame,
    { readonly kind: "primaryProfileEvict" }
  >;
  readonly browserView: BrowserViewBridge | null;
}): void {
  const browserView = args.browserView;
  if (browserView === null) return;
  void browserView.evictSite(args.frame.domain).catch((cause: unknown) => {
    appLogger.warn("[browser] could not evict a cleared site", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  });
}

function handlePrimaryProfileCaptureFrame(args: {
  readonly frame: Extract<
    BrowserSessionsServerFrame,
    { readonly kind: "capturePrimaryProfile" }
  >;
  readonly browserView: BrowserViewBridge | null;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
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
    return;
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
}

/**
 * The desktop half of the store-key handshake (spec §6.2). The key never
 * touches this renderer's storage: it is handed to the main process, sealed
 * with (or opened by) the OS keystore, and handed straight back to the host.
 *
 * A failed *unwrap* is answered (`rawKey: null`) so the host knows to stay
 * sealed. A failed *wrap* has no negative frame by design: nothing durable was
 * created, and the host simply re-asks on the next connect.
 */
function handleStoreKeyRequestFrame(args: {
  readonly frame: Extract<
    BrowserSessionsServerFrame,
    { readonly kind: "storeKeyWrapRequest" | "storeKeyUnwrapRequest" }
  >;
  readonly browserView: BrowserViewBridge | null;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
  const frame = args.frame;
  const browserView = args.browserView;
  const requestId = frame.requestId;
  if (browserView === null) {
    if (frame.kind === "storeKeyUnwrapRequest") {
      args.sendClientFrame({
        kind: "storeKeyUnwrapped",
        hasBinaryPayload: false,
        requestId,
        rawKey: null,
      });
    }
    return;
  }
  const warn = (cause: unknown): void => {
    appLogger.warn("[browser] the store-key handshake failed", {
      frameKind: frame.kind,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  };
  if (frame.kind === "storeKeyWrapRequest") {
    // Wrapped so a bridge that predates this call rejects instead of throwing
    // into the stream callback that asked for it.
    void Promise.resolve()
      .then(() => browserView.wrapStoreKey(frame.rawKey))
      .then((result) => {
        if (!result.ok) {
          warn(result.reason);
          return;
        }
        args.sendClientFrame({
          kind: "storeKeyWrapped",
          hasBinaryPayload: false,
          requestId,
          wrappedKey: result.wrappedKey,
        });
      })
      .catch(warn);
    return;
  }
  void Promise.resolve()
    .then(() => browserView.unwrapStoreKey(frame.wrappedKey))
    .then((result) => {
      if (!result.ok) warn(result.reason);
      args.sendClientFrame({
        kind: "storeKeyUnwrapped",
        hasBinaryPayload: false,
        requestId,
        rawKey: result.ok ? result.rawKey : null,
      });
    })
    .catch((cause: unknown) => {
      warn(cause);
      args.sendClientFrame({
        kind: "storeKeyUnwrapped",
        hasBinaryPayload: false,
        requestId,
        rawKey: null,
      });
    });
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

function rejectPendingRequests<
  T extends { readonly reject: (error: Error) => void },
>(pendingRequests: Map<string, T>, error: Error): void {
  pendingRequests.forEach((pending) => pending.reject(error));
  pendingRequests.clear();
}
