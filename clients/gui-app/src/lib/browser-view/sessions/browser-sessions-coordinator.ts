import type {
  BrowserSessionInfo,
  BrowserSessionsUxClientFrame,
  BrowserSessionsUxServerFrame,
  BrowserTabIdentity,
  BrowserTabPreview,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserSessionsLifecycle,
  BrowserViewBridge,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";
import { surfaceAgentTab } from "@/lib/browser-view/tiles/agent-tab-surfacing";
import { browserSessionsReducer } from "@/lib/browser-view/sessions/browser-sessions-stream";
import {
  openBrowserSessionsSession,
  type BrowserSessionsSession,
} from "@/lib/browser-view/sessions/browser-sessions-session";
import {
  publishElectronTabBinding,
  removeOwnedElectronTabBinding,
  removeOwnedElectronTabBindings,
} from "@/lib/browser-view/sessions/electron-tab-directory";
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
 *
 * On the desktop the SOCKET is not here: main owns it, and this coordinator
 * holds the UX projection of it (browser-security-hardening H10). What the
 * coordinator kept is exactly what it is for - which streams should exist, the
 * session inventory it renders, and the three user-initiated tab requests.
 */
export interface BrowserSessionsOwner {
  readonly hostId: string;
  readonly identityKey: string;
}

interface BrowserSessionsCoordinatorRuntime {
  readonly browserView: BrowserViewBridge | null;
  /**
   * The signed-in user this stream is opened for. Main needs it to mint a
   * relay attach grant for a remote host; on the direct (no-desktop) path it
   * is unused. `null` until the request context resolves - the coordinator
   * exists, and restarts when the identity arrives.
   */
  readonly userId: string | null;
  readonly openTransport: (hostId: string) => DurableStreamTransport;
}

/** One outstanding request/response pair, keyed by its `requestId`. */
type PendingRequests<T> = Map<
  string,
  {
    readonly resolve: (result: T) => void;
    readonly reject: (error: Error) => void;
  }
>;

interface BrowserSessionsCoordinator {
  readonly owner: BrowserSessionsOwner;
  readonly epicId: string;
  state: BrowserSessionsState;
  /**
   * Snapshot-only capture of one tab on this coordinator's host, for a chat
   * pinned to ANOTHER host (spec decision #10). It hangs off the coordinator
   * rather than off `BrowserSessionsState` because only the mention picker
   * calls it, keyed by coordinator.
   */
  captureTabPreview: (tabId: string) => Promise<BrowserTabPreview>;
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
 * Bound on one `captureTabPreview`: a preview is a live screenshot of a tab
 * that may be dormant, wedged or gone, and the mention picker awaiting it has
 * no other way out.
 */
const TAB_PREVIEW_TIMEOUT_MS = 5_000;

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
 * "Forget all browser logins" (spec §6.5, ticket 08).
 *
 * One call now, and the whole act is main's: it raises the native dialog,
 * clears this machine's jars, records the forget in the durable ledger, and
 * sends `forgetLogins` to every host it holds a stream to. This renderer
 * neither decides nor sends - it asks (browser security review, root cause C).
 *
 * Answers whether the user confirmed. `false` when there is no desktop bridge
 * at all, for the same reason: nothing was forgotten, so nothing was told.
 */
export async function forgetAllBrowserLogins(
  browserView: BrowserViewBridge | null,
): Promise<boolean> {
  if (browserView === null) return false;
  return browserView.forgetLogins().catch((cause: unknown) => {
    appLogger.warn("[browser] clearing the browser partition failed", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return false;
  });
}

/**
 * "Clear" on one row of Settings > Browser (spec section 7.3, ticket 10).
 *
 * Main confirms it and main sends the frames: signing the user out of one site
 * on every connected host is forget-all one domain at a time as far as those
 * hosts are concerned, and a renderer looping the saved-sites list must not be
 * able to do it silently (H05's residual for H10). Answers whether the user
 * confirmed.
 */
export async function clearSavedLoginSite(
  browserView: BrowserViewBridge | null,
  domain: string,
): Promise<boolean> {
  if (browserView === null) return false;
  return browserView.clearSavedLoginSite(domain).catch((cause: unknown) => {
    appLogger.warn("[browser] clearing one saved login failed", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return false;
  });
}

function notifyBrowserSessionsCoordinator(key: string): void {
  browserSessionsCoordinatorListeners
    .get(key)
    ?.forEach((listener) => listener());
  browserSessionsRegistryListeners.forEach((listener) => listener());
}

/** One live coordinator, addressed by the registry key that reaches it. */
export interface BrowserSessionsCoordinatorEntry {
  readonly key: string;
  readonly state: BrowserSessionsState;
}

/** Every live coordinator for `epicId`, in registry (insertion) order. */
export function browserSessionsCoordinatorsForEpic(
  epicId: string,
): readonly BrowserSessionsCoordinatorEntry[] {
  const out: BrowserSessionsCoordinatorEntry[] = [];
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
 * bound to ONE host's sessions stream. Session ids are host-minted uuids, so
 * scanning the registry cannot resolve the wrong session.
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
  const pendingCloses: PendingRequests<void> = new Map();
  const pendingOpens: PendingRequests<BrowserTabIdentity> = new Map();
  const pendingPreviews: PendingRequests<BrowserTabPreview> = new Map();
  const runtimes = new Map<symbol, BrowserSessionsCoordinatorRuntime>([
    [args.consumerId, args.runtime],
  ]);
  const tabBindingOwner = Symbol("browser-sessions-tabs");
  let activeConsumerId: symbol | null = args.consumerId;
  let runtime = args.runtime;
  let session: BrowserSessionsSession | null = null;
  let lifecycle: BrowserSessionsLifecycle = "connecting";
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

  /**
   * Sends one request frame and resolves on the answer that carries its
   * `requestId`. `timeoutMs` bounds the wait for a host that never answers at
   * all; a closed stream rejects every pending request through
   * `rejectPendingRequests` instead.
   */
  const sendRequest = <T>(
    pending: PendingRequests<T>,
    timeoutMs: number | null,
    frame: (requestId: string) => BrowserSessionsUxClientFrame,
  ): Promise<T> => {
    const live = session;
    if (live === null || lifecycle !== "live") {
      return Promise.reject(new Error("Browser sessions stream is not ready."));
    }
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : window.setTimeout(() => {
              pending.delete(requestId);
              reject(new Error("Browser sessions request timed out."));
            }, timeoutMs);
      const settle = (): void => {
        pending.delete(requestId);
        if (timer !== null) window.clearTimeout(timer);
      };
      pending.set(requestId, {
        resolve: (result) => {
          settle();
          resolve(result);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      try {
        live.send(frame(requestId));
      } catch (error) {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const closeTab = (sessionId: string, tabId: string): Promise<void> =>
    sendRequest(pendingCloses, null, (requestId) => ({
      kind: "closeTab",
      hasBinaryPayload: false,
      requestId,
      sessionId,
      tabId,
    }));

  const openTab = (
    sessionId: string | null,
    url: string,
  ): Promise<BrowserTabIdentity> =>
    sendRequest(pendingOpens, null, (requestId) => ({
      kind: "openTab",
      hasBinaryPayload: false,
      requestId,
      sessionId,
      url,
    }));

  const captureTabPreview = (tabId: string): Promise<BrowserTabPreview> =>
    sendRequest(pendingPreviews, TAB_PREVIEW_TIMEOUT_MS, (requestId) => ({
      kind: "captureTabPreview",
      hasBinaryPayload: false,
      requestId,
      tabId,
    }));

  const rejectEveryPendingRequest = (): void => {
    const closed = new Error("Browser sessions stream closed.");
    rejectPendingRequests(pendingCloses, closed);
    rejectPendingRequests(pendingOpens, closed);
    rejectPendingRequests(pendingPreviews, closed);
  };

  const onStatus = (
    next: BrowserSessionsLifecycle,
    errorMessage: string | null,
  ): void => {
    const wasLive = lifecycle === "live";
    lifecycle = next;
    applyPipHostLifecycle(args.epicId, args.owner.hostId, next);
    if (next !== "live" && wasLive) {
      rejectEveryPendingRequest();
      removeOwnedElectronTabBindings(tabBindingOwner);
    }
    patchState({
      lifecycle: next,
      inventoryReady: next === "live" && coordinator.state.inventoryReady,
      errorMessage,
    });
  };

  const onFrame = (frame: BrowserSessionsUxServerFrame): void => {
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
      currentItems: () => coordinator.state.items,
    });
  };

  const onTabBound = (capability: BrowserViewNativeTabCapability): void => {
    const browserView = runtime.browserView;
    if (browserView === null) return;
    publishElectronTabBinding(tabBindingOwner, browserView, capability);
  };

  const start = (): void => {
    patchState({
      items: [],
      lifecycle: "connecting",
      inventoryReady: false,
      errorMessage: null,
    });
    lifecycle = "connecting";
    session = openBrowserSessionsSession({
      key: {
        epicId: args.epicId,
        hostId: args.owner.hostId,
        identityKey: args.owner.identityKey,
      },
      userId: runtime.userId,
      browserView: runtime.browserView,
      openTransport: runtime.openTransport,
      callbacks: {
        onStatus,
        onFrame,
        onTabBound,
        onTabReleased: (capability) => {
          removeOwnedElectronTabBinding(tabBindingOwner, capability);
        },
      },
    });
  };

  const stop = (): void => {
    session?.close();
    session = null;
    lifecycle = "closed";
    removeOwnedElectronTabBindings(tabBindingOwner);
    rejectEveryPendingRequest();
  };

  const restart = (): void => {
    if (disposed) return;
    stop();
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
      const changed = runtimeChanged(runtime, nextRuntime);
      runtime = nextRuntime;
      if (changed) restart();
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
      const changed = runtimeChanged(runtime, nextRuntime);
      runtime = nextRuntime;
      if (changed) restart();
      return runtimes.size;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stop();
    },
  };
  start();
  return coordinator;
}

function runtimeChanged(
  current: BrowserSessionsCoordinatorRuntime,
  next: BrowserSessionsCoordinatorRuntime,
): boolean {
  return (
    current.browserView !== next.browserView || current.userId !== next.userId
  );
}

function handleCloseAck(
  frame: Extract<BrowserSessionsUxServerFrame, { readonly kind: "actionAck" }>,
  pendingCloses: PendingRequests<void>,
): void {
  const pending = pendingCloses.get(frame.requestId);
  if (pending === undefined) return;
  if (frame.ok) pending.resolve();
  else pending.reject(new Error(frame.reason ?? "Browser action failed."));
}

/**
 * The one router for the frames a renderer may see. Its parameter is the
 * protocol's UX projection, so a jar frame is not merely unhandled here - it
 * cannot be handed to it (H10).
 */
function handleBrowserSessionsFrame(args: {
  readonly frame: BrowserSessionsUxServerFrame;
  readonly epicId: string;
  readonly hostId: string;
  readonly currentItems: () => readonly BrowserSessionInfo[];
  readonly setItems: (items: readonly BrowserSessionInfo[]) => void;
  readonly pendingCloses: PendingRequests<void>;
  readonly pendingOpens: PendingRequests<BrowserTabIdentity>;
  readonly pendingPreviews: PendingRequests<BrowserTabPreview>;
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
    case "actionAck":
      handleCloseAck(frame, args.pendingCloses);
      return;
    case "openTabResult":
      handleOpenTabResult(frame, args.pendingOpens);
      return;
    case "tabPreviewResult": {
      const pending = args.pendingPreviews.get(frame.requestId);
      if (pending === undefined) return;
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
    case "burstStarted":
    case "burstEnded":
      return;
    default: {
      // Unreachable: the union is the protocol's own UX projection, so the
      // `never` binding turns a new renderer-reachable frame kind into a
      // compile error.
      const unhandled: never = frame;
      void unhandled;
      appLogger.warn("[browser] unhandled browser.sessions frame", {
        frameKind: args.frame.kind,
      });
    }
  }
}

/**
 * Settles one `openTab`, the way {@link handleCloseAck} settles one close.
 * Extracted for the same reason: inlined, it puts the router over the
 * complexity budget.
 */
function handleOpenTabResult(
  frame: Extract<
    BrowserSessionsUxServerFrame,
    { readonly kind: "openTabResult" }
  >,
  pendingOpens: PendingRequests<BrowserTabIdentity>,
): void {
  const pending = pendingOpens.get(frame.requestId);
  if (pending === undefined) return;
  if (frame.result.ok) pending.resolve(frame.result);
  else pending.reject(new Error(frame.result.reason));
}

function rejectPendingRequests<
  T extends { readonly reject: (error: Error) => void },
>(pendingRequests: Map<string, T>, error: Error): void {
  pendingRequests.forEach((pending) => pending.reject(error));
  pendingRequests.clear();
}
