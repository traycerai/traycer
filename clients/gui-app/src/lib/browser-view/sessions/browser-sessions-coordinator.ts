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
 * The host's verdict on one `captureTabPreview`. `ok: false` is an ordinary
 * answer (a dormant tab, a tab that went away), not a transport failure.
 */
export interface BrowserTabPreview {
  readonly ok: boolean;
  readonly screenshotBase64: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly reason: string | null;
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
  /**
   * THIS machine's host id, or null on a shell with no local host. Declared to
   * the host on `electronTabLifecycleReady`: the host only elects an Electron
   * lifecycle owner whose declared id equals its own, so a GUI attached to a
   * remote host stays a pure viewer (spec decision #3).
   */
  readonly localHostId: string | null;
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

type PendingPreviewRequest = {
  readonly resolve: (result: BrowserTabPreview) => void;
  readonly reject: (error: Error) => void;
};

interface BrowserSessionsActionChannel {
  readonly owner: BrowserSessionsOwner;
  lifecycle: BrowserSessionsLifecycle;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}

interface BrowserSessionsCoordinator {
  readonly owner: BrowserSessionsOwner;
  readonly epicId: string;
  state: BrowserSessionsState;
  /**
   * Snapshot-only capture of one tab on this coordinator's host, for a chat
   * pinned to ANOTHER host (spec decision #10). It hangs off the coordinator
   * rather than off `BrowserSessionsState` because only the mention picker
   * calls it, keyed by coordinator - no rendering surface needs it, and
   * every surface that builds a `BrowserSessionsState` would otherwise have
   * to carry a method it never uses.
   */
  captureTabPreview: (tabId: string) => Promise<BrowserTabPreview>;
  upsertConsumer: (
    consumerId: symbol,
    runtime: BrowserSessionsCoordinatorRuntime,
  ) => void;
  release: (consumerId: symbol) => number;
  captureFinalPrimaryProfile: () => Promise<void>;
  dispose: () => void;
}

const browserSessionsCoordinators = new Map<
  string,
  BrowserSessionsCoordinator
>();
const browserSessionsCoordinatorListeners = new Map<string, Set<() => void>>();
/**
 * Listeners on the REGISTRY rather than one coordinator: the mention picker
 * aggregates every host whose browser surfaces are open in this epic, so it
 * has to hear a coordinator appearing or disappearing too, not just a frame
 * on a key it already knows.
 */
const browserSessionsRegistryListeners = new Set<() => void>();

export function browserSessionsCoordinatorKey(
  epicId: string,
  owner: BrowserSessionsOwner,
): string {
  return JSON.stringify([epicId, owner.hostId, owner.identityKey]);
}

export function hasBrowserSessionsCoordinator(key: string): boolean {
  return browserSessionsCoordinators.has(key);
}

/**
 * Bound on the round trip that proves the final capture left this renderer.
 * The whole quit path is already bounded by the shell's own capture timeout;
 * this one only has to be shorter than that, so a lost socket costs a beat
 * rather than the shell's full wait.
 */
export const FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS = 5_000;

/**
 * One last primary-profile capture per live `browser.sessions` stream this
 * renderer owns, before the desktop route goes away (quit, window close).
 *
 * When a route disappears the host suspends the session to dormant and
 * re-materializes it later from the durable tab URLs plus the primary-profile
 * store, so that store is the only thing carrying login state across the gap.
 * It must therefore be refreshed while the native tabs are still alive.
 *
 * Only co-located coordinators capture: a stream whose host is not this
 * machine has no Electron partition here to read.
 *
 * Never rejects: a stream that cannot answer is reported by not having
 * refreshed the store, not by stalling the quit.
 */
export async function captureFinalPrimaryProfiles(): Promise<void> {
  await Promise.allSettled(
    Array.from(browserSessionsCoordinators.values(), (coordinator) =>
      coordinator.captureFinalPrimaryProfile(),
    ),
  );
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

function notifyBrowserSessionsCoordinator(key: string): void {
  browserSessionsCoordinatorListeners
    .get(key)
    ?.forEach((listener) => listener());
  browserSessionsRegistryListeners.forEach((listener) => listener());
}

/** Every live coordinator for `epicId`, in registry (insertion) order. */
export function browserSessionsCoordinatorsForEpic(
  epicId: string,
): ReadonlyArray<{
  readonly key: string;
  readonly state: BrowserSessionsState;
}> {
  const out: Array<{
    readonly key: string;
    readonly state: BrowserSessionsState;
  }> = [];
  browserSessionsCoordinators.forEach((coordinator, key) => {
    if (coordinator.epicId === epicId)
      out.push({ key, state: coordinator.state });
  });
  return out;
}

/**
 * The live session with this id on ANY host whose coordinator is open, or
 * `null`.
 *
 * Composer chips (browser-tab mentions, annotation cards) carry a
 * `sessionId`/`tabId` and no host, and they render inside a chat tile that is
 * now bound to ONE host's sessions stream (`renderTile`'s
 * `BrowserSessionsHostBoundary`). Reading the surrounding context would make a
 * chip resolve only when its tab happens to live on the tile's host, so a
 * mention the picker legitimately offered from another host would render as
 * missing. Session ids are host-minted uuids, so scanning the registry cannot
 * resolve the wrong session; the epic is not needed to disambiguate.
 */
export function browserSessionAcrossCoordinators(
  sessionId: string,
): BrowserSessionInfo | null {
  for (const coordinator of browserSessionsCoordinators.values()) {
    const session = coordinator.state.items.find(
      (item) => item.sessionId === sessionId,
    );
    if (session !== undefined) return session;
  }
  return null;
}

/**
 * Requests one snapshot preview over the named coordinator's stream. Rejects
 * when that coordinator is gone or its stream is not live.
 */
export function captureBrowserTabPreview(
  key: string,
  tabId: string,
): Promise<BrowserTabPreview> {
  const coordinator = browserSessionsCoordinators.get(key);
  if (coordinator === undefined) {
    return Promise.reject(new Error("Browser sessions stream is not ready."));
  }
  return coordinator.captureTabPreview(tabId);
}

export function subscribeToBrowserSessionsCoordinators(
  listener: () => void,
): () => void {
  browserSessionsRegistryListeners.add(listener);
  return () => {
    browserSessionsRegistryListeners.delete(listener);
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
  const pendingPreviews = new Map<string, PendingPreviewRequest>();
  const runtimes = new Map<symbol, BrowserSessionsCoordinatorRuntime>([
    [args.consumerId, args.runtime],
  ]);
  let activeConsumerId: symbol | null = args.consumerId;
  let runtime = args.runtime;
  let actionChannel: BrowserSessionsActionChannel | null = null;
  // Re-runs the readiness gate for the live connection; the local host id can
  // resolve after the stream opened.
  let retryLifecycleReady = (): void => undefined;
  let stopCurrentStream = (): void => undefined;
  let captureFinalPrimaryProfile = (): Promise<void> => Promise.resolve();
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

  const captureTabPreview = (tabId: string): Promise<BrowserTabPreview> => {
    const channel = activeChannel();
    if (channel === null) {
      return Promise.reject(new Error("Browser sessions stream is not ready."));
    }
    const requestId = crypto.randomUUID();
    return new Promise<BrowserTabPreview>((resolve, reject) => {
      pendingPreviews.set(requestId, { resolve, reject });
      try {
        channel.sendClientFrame({
          kind: "captureTabPreview",
          hasBinaryPayload: false,
          requestId,
          tabId,
        });
      } catch (error) {
        pendingPreviews.delete(requestId);
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
    // `ping` / `pong` is the only ordered round trip this stream has, so it is
    // what "the frame reached the host" means here: the socket has no flush
    // primitive, and `primaryProfileCaptured` is not acknowledged.
    //
    // The queue pairs each pong with the ping it answers BY POSITION: the
    // transport delivers one `pong` per application `ping`, the Nth pong
    // answers the Nth ping, so a pong shifts the queue rather than scanning
    // it. A waiter that timed out stays queued with an inert `settle`, which
    // is what keeps its late pong from being credited to the next waiter -
    // removing it would resolve an overlapping capture on a pong that was
    // already in flight before its own frame went out.
    const streamFlushWaiters: Array<() => void> = [];
    const resolveOldestStreamFlushWaiter = (): void => {
      streamFlushWaiters.shift()?.();
    };
    const resolveStreamFlushWaiters = (): void => {
      for (const settle of streamFlushWaiters.splice(0)) settle();
    };
    const awaitStreamFlush = (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (actionChannel !== channel || connectionStatus !== "open") {
          resolve();
          return;
        }
        // `resolve` is idempotent, so a queued waiter that already timed out
        // simply absorbs its own pong.
        const timer = window.setTimeout(
          resolve,
          FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS,
        );
        streamFlushWaiters.push(() => {
          window.clearTimeout(timer);
          resolve();
        });
        stream?.sendClientFrame({ kind: "ping", hasBinaryPayload: false });
      });
    const sendLifecycleReadyIfReady = (): void => {
      const localHostId = runtime.localHostId;
      if (
        actionChannel !== channel ||
        browserView === null ||
        // Wait for the local host id rather than advertising a null locality
        // that can never be elected: readiness is sent once per connection, so
        // a null sent now would stick for the whole connection. A shell that
        // genuinely has no local host never sends readiness at all, which is
        // exactly right - it could not own an Electron lifecycle either way.
        localHostId === null ||
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
        coLocatedHostId: localHostId,
      });
    };
    retryLifecycleReady = sendLifecycleReadyIfReady;

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
        resolveStreamFlushWaiters();
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
        rejectPendingRequests(
          pendingPreviews,
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
      if (frame.kind === "pong") resolveOldestStreamFlushWaiter();
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
        pendingPreviews,
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
      electronTabs.dispose();
      transport.close();
      throw cause;
    }
    const opened = stream;

    captureFinalPrimaryProfile = async (): Promise<void> => {
      if (actionChannel !== channel || connectionStatus !== "open") return;
      // Only the host this GUI is CO-LOCATED with. `capturePrimaryProfile`
      // reads THIS machine's Electron partition, and the host stores what
      // arrives as the whole jar - fanning it to a remote host would overwrite
      // that host's own, richer jar with a laptop's on every quit. The same
      // locality rule gates `electronTabLifecycleReady` above.
      if (runtime.localHostId !== args.owner.hostId) return;
      await capturePrimaryProfileOnce({
        requestId: crypto.randomUUID(),
        browserView,
        sendClientFrame: (response) => {
          if (actionChannel !== channel) return;
          opened.sendClientFrame(response);
        },
      });
      await awaitStreamFlush();
    };

    stopCurrentStream = () => {
      if (actionChannel === channel) actionChannel = null;
      captureFinalPrimaryProfile = (): Promise<void> => Promise.resolve();
      resolveStreamFlushWaiters();
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
      rejectPendingRequests(
        pendingPreviews,
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
    epicId: args.epicId,
    captureTabPreview,
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
      else retryLifecycleReady();
    },
    captureFinalPrimaryProfile: () => captureFinalPrimaryProfile(),
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
      else retryLifecycleReady();
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
  readonly pendingPreviews: Map<string, PendingPreviewRequest>;
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
      handleCloseAck(frame, args.pendingCloses);
      return;
    default:
      handleBrowserSessionsSubsystemFrame({
        frame,
        epicId: args.epicId,
        hostId: args.hostId,
        pendingOpens: args.pendingOpens,
        pendingPreviews: args.pendingPreviews,
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
  readonly pendingPreviews: Map<string, PendingPreviewRequest>;
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
    case "tabPreviewResult": {
      const pending = args.pendingPreviews.get(frame.requestId);
      if (pending === undefined) return;
      args.pendingPreviews.delete(frame.requestId);
      pending.resolve({
        ok: frame.ok,
        screenshotBase64: frame.screenshotBase64,
        url: frame.url,
        title: frame.title,
        reason: frame.reason,
      });
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
 * The one code path that answers "what is in the primary profile right now".
 * Both callers use it: a host-issued `capturePrimaryProfile` request, and the
 * renderer's own final capture before the desktop route disappears (quit or
 * window close). It always sends exactly one `primaryProfileCaptured` and
 * never rejects, so a caller can await it as "the capture is on the wire".
 */
async function capturePrimaryProfileOnce(args: {
  readonly requestId: string;
  readonly browserView: BrowserViewBridge | null;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): Promise<void> {
  const requestId = args.requestId;
  const browserView = args.browserView;
  if (browserView === null) {
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
  try {
    const result = await browserView.capturePrimaryProfile();
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
  } catch (error: unknown) {
    args.sendClientFrame({
      kind: "primaryProfileCaptured",
      hasBinaryPayload: false,
      requestId,
      storageState: null,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function handlePrimaryProfileCaptureFrame(args: {
  readonly frame: Extract<
    BrowserSessionsServerFrame,
    { readonly kind: "capturePrimaryProfile" }
  >;
  readonly browserView: BrowserViewBridge | null;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
  void capturePrimaryProfileOnce({
    requestId: args.frame.requestId,
    browserView: args.browserView,
    sendClientFrame: args.sendClientFrame,
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
