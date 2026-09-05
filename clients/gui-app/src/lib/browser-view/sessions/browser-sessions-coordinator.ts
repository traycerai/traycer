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
import { browserSessionsStreamKeyId } from "@traycer-clients/shared/platform/browser-view";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import { appLogger } from "@/lib/logger";
import { surfaceHostOpenedTab } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { browserSessionsReducer } from "@/lib/browser-view/sessions/browser-sessions-stream";
import { recordIndependentPageOpenedTab } from "@/lib/browser-view/sessions/independent-page-open-registry";
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
  /**
   * Can THIS client put a native Electron tab on this coordinator's host?
   * See {@link canMaterializeElectronTab} - surfaces read it to decide whether
   * a native branch is reachable for them at all, rather than inferring one
   * from host-side facts that describe some other client's window.
   */
  readonly canMaterializeElectron: boolean;
  readonly items: readonly BrowserSessionInfo[];
  readonly errorMessage: string | null;
  readonly retry: () => void;
  readonly openTab: (
    sessionId: string | null,
    url: string,
  ) => Promise<BrowserTabIdentity>;
  readonly closeTab: (sessionId: string, tabId: string) => Promise<void>;
  /**
   * "Attach this tab on MY window's route" - the electron-capable tile's ask
   * when it becomes visible with no local binding. Resolves on the host's
   * `actionAck` and rejects on a refusal (the tab is bound in another window,
   * the session is closing) or on {@link ATTACH_TAB_TIMEOUT_MS}.
   *
   * Nothing calls it yet; the tile does in the multi-window states step. It
   * lives here rather than on the stream client because the correlation - a
   * request id, a pending entry, a timeout - is the coordinator's job.
   */
  readonly attachTab: (tabId: string) => Promise<void>;
  /**
   * "Show this tab HERE" - the same ask for a tab whose native binding is
   * held by a route in ANOTHER window of this desktop, which `attachTab` is
   * refused for by construction (it rejects, never relocates). Resolves on the
   * host's `actionAck` and rejects with its reason on a refusal - an agent is
   * driving the tab, a birth is in flight, the session is closing - or on
   * {@link ATTACH_TAB_TIMEOUT_MS}.
   *
   * Unlike `attachTab` the caller SHOWS the outcome: it is a button press, so
   * a refusal is toasted and the button comes back. A resolve needs nothing -
   * the binding arrives through this window's ordinary `createElectronTab`
   * path, exactly as any other native birth does.
   */
  readonly moveTab: (tabId: string) => Promise<void>;
}

/**
 * One inventory - an epic's, or the device's `independent` one - keyed by
 * {scope, host, authenticated owner}. The registry is module-global because
 * several React surfaces (the canvas tiles, the sidebar, the PiP bridge)
 * subscribe to the same stream and must not each open one - consumers refcount
 * into a single coordinator. Two scopes on one host and identity are two
 * inventories and therefore two streams; that is the point of the key.
 *
 * On the desktop the SOCKET is not here: main owns it, and this coordinator
 * holds the UX projection of it (browser-security-hardening H10). What the
 * coordinator kept is exactly what it is for - which streams should exist, the
 * session inventory it renders, and the user-initiated tab requests with the
 * request correlation they need.
 */
export interface BrowserSessionsOwner {
  readonly hostId: string;
  readonly identityKey: string;
}

interface BrowserSessionsCoordinatorRuntime {
  readonly browserView: BrowserViewBridge | null;
  /**
   * The signed-in user this stream is opened for. Not sent to main, which
   * reads it from the desktop auth session it owns; it only decides whether
   * asking is worth an IPC. `null` until the request context resolves - the
   * coordinator exists, and restarts when the identity arrives.
   */
  readonly userId: string | null;
  /**
   * THIS machine's host id, or null on a shell with no local host. A UX gate
   * only: the Electron lifecycle election runs in main (H10), which declares
   * its own id, so this decides whether a surface may offer a native branch at
   * all rather than what the host elects.
   */
  readonly localHostId: string | null;
  /**
   * The retained Epic surface this consumer can present a host-opened tab in.
   * Null for app-global consumers (for example the command palette) which can
   * use the coordinator but do not own a canvas destination.
   */
  readonly presentation: BrowserSessionsPresentation | null;
  /**
   * Router-bound nested-focus commit supplied by this React consumer. The
   * coordinator is shared outside React, so server-pushed foreground tabs use
   * the callback paired with the selected presenter instead of reaching for a
   * module-global router.
   */
  readonly navigateNested: NavigateNestedFocus;
  readonly openTransport: (hostId: string) => DurableStreamTransport;
}

interface BrowserSessionsPresentation {
  readonly viewTabId: string;
  readonly visible: boolean;
  readonly focused: boolean;
}

interface BrowserSessionsPresenter {
  readonly viewTabId: string;
  readonly navigateNested: NavigateNestedFocus;
}

/**
 * Resource ownership and presentation ownership are deliberately separate.
 * The first coordinator consumer owns the stream/browserView until release,
 * but a host push belongs in the currently focused retained Epic surface.
 * Falling back focused -> visible -> retained preserves hidden-Epic surfacing
 * when no surface is currently presented without letting insertion order pick
 * a background duplicate while a focused one exists.
 */
function selectBrowserSessionsPresenters(
  runtimes: ReadonlyMap<symbol, BrowserSessionsCoordinatorRuntime>,
): readonly BrowserSessionsPresenter[] {
  const byViewTabId = new Map<
    string,
    { readonly presenter: BrowserSessionsPresenter; readonly priority: number }
  >();
  for (const candidate of runtimes.values()) {
    const presentation = candidate.presentation;
    if (presentation === null) continue;
    const presenter = {
      viewTabId: presentation.viewTabId,
      navigateNested: candidate.navigateNested,
    };
    // Focused beats merely visible beats hidden - as a chain, because a
    // nested ternary is the one shape the lint config refuses.
    let priority = 2;
    if (presentation.focused) priority = 0;
    else if (presentation.visible) priority = 1;
    const previous = byViewTabId.get(presentation.viewTabId);
    if (previous === undefined || priority < previous.priority) {
      byViewTabId.set(presentation.viewTabId, { presenter, priority });
    }
  }
  return [...byViewTabId.values()]
    .sort((left, right) => left.priority - right.priority)
    .map(({ presenter }) => presenter);
}

/**
 * Can this client materialize an Electron tab on `hostId`?
 *
 * The client half of the host's `isCoLocatedLifecycleCandidate`: a native
 * `browserView` bridge to place the tab in, and a host that is THIS machine's
 * own - the host refuses the lifecycle election otherwise, and the transport
 * vantage it actually decides on (`local-ws`) is exactly the one a client in
 * that position reaches it over. A GUI attached to a remote host is a pure
 * viewer, however capable its own shell is.
 *
 * Deliberately NOT gated on the stream handshake having completed:
 * `electronTabLifecycleReady` is per connection, and a surface asking whether
 * a native branch exists for it at all is asking a durable question. The
 * per-connection half it would add is `inventoryReady`, which every such
 * surface already reads.
 */
function canMaterializeElectronTab(
  runtime: BrowserSessionsCoordinatorRuntime,
  hostId: string,
): boolean {
  return runtime.browserView !== null && runtime.localHostId === hostId;
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
  readonly scope: HostResourceScope;
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

/**
 * The registry key every consumer acquires by: the stream key's own encoding,
 * computed BY that encoder rather than re-spelled here.
 *
 * `browserSessionsStreamKeyId` exists because main and the renderer used to
 * spell this separately, and a third spelling would reopen exactly the drift
 * it closed - a coordinator and the main-process stream it drives have to be
 * named identically on both sides of the desktop's IPC, and the encoding is
 * load-bearing (it flattens the scope, because `JSON.stringify` would
 * otherwise let two orderings of one scope literal become two keys).
 */
export function browserSessionsCoordinatorKey(
  scope: HostResourceScope,
  owner: BrowserSessionsOwner,
): string {
  return browserSessionsStreamKeyId({
    scope,
    hostId: owner.hostId,
    identityKey: owner.identityKey,
  });
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

/**
 * Bound on one `attachTab` or `moveTab` ack.
 *
 * `closeTab` is deliberately unbounded and this is not, because the two have
 * different evidence behind them: a close is followed by a `sessionUpdated` or
 * `sessionClosed` frame whatever happens to the ack, while an attach's ONLY
 * answer is the ack - a host that declines to move a tab changes nothing in
 * the inventory. The caller is a tile that fires once on activation and never
 * re-sends, so an unbounded promise here is one that is awaited and never
 * settles. Long enough to cover a dormant tab's wake and a native guest's
 * birth on the far side.
 *
 * A move is bounded by the same number for a stronger reason: a reader is
 * watching a disabled button, and the whole cost of a move that never answers
 * is that button never coming back.
 */
const ATTACH_TAB_TIMEOUT_MS = 10_000;

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
  readonly scope: HostResourceScope;
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

/** One live coordinator, addressed by the registry key that reaches it. */
export interface BrowserSessionsCoordinatorEntry {
  readonly key: string;
  readonly state: BrowserSessionsState;
}

/**
 * Every live coordinator for `epicId`, in registry (insertion) order.
 *
 * Epic-scoped by name and by narrow: an `independent` coordinator belongs to no
 * epic, so it is not "every coordinator that happens to be open" - it is the
 * ones this epic's surfaces may read.
 */
export function browserSessionsCoordinatorsForEpic(
  epicId: string,
): readonly BrowserSessionsCoordinatorEntry[] {
  const out: BrowserSessionsCoordinatorEntry[] = [];
  browserSessionsCoordinators.forEach((coordinator, key) => {
    if (
      coordinator.scope.kind === "epic" &&
      coordinator.scope.epicId === epicId
    )
      out.push({ key, state: coordinator.state });
  });
  return out;
}

/**
 * The live session with this id on ANY host whose EPIC-scoped coordinator is
 * open, or `null`.
 *
 * Composer chips (browser-tab mentions, annotation cards) carry a
 * `sessionId`/`tabId` and no host, and they render inside a chat tile that is
 * bound to ONE host's sessions stream. Session ids are host-minted uuids, so
 * scanning the registry cannot resolve the wrong session by collision.
 *
 * Independent coordinators are skipped, and that is a SCOPE decision rather
 * than a collision one - the two arguments are different, and only the first
 * is answered by uuids. A Start Page browser session belongs to the device,
 * not to any task: agent visibility is derived from the chat's epic on the
 * host, so an independent session is invisible to an agent by construction,
 * and the GUI's epic surfaces should not be the seam that hands one back. A
 * chip cannot name a session the user never put in a task.
 */
export function browserSessionAcrossCoordinators(
  sessionId: string,
): BrowserSessionInfo | null {
  for (const coordinator of browserSessionsCoordinators.values()) {
    if (coordinator.scope.kind !== "epic") continue;
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
  readonly scope: HostResourceScope;
  readonly owner: BrowserSessionsOwner;
  readonly runtime: BrowserSessionsCoordinatorRuntime;
}): BrowserSessionsCoordinator {
  const pendingCloses: PendingRequests<void> = new Map();
  const pendingAttaches: PendingRequests<void> = new Map();
  const pendingMoves: PendingRequests<void> = new Map();
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
        | "canMaterializeElectron"
        | "errorMessage"
        | "inventoryReady"
        | "items"
        | "lifecycle"
      >
    >,
  ): void => {
    publish({ ...coordinator.state, ...patch });
  };

  /**
   * Republishes the Electron capability after `runtime` was swapped. A
   * `browserView` swap restarts the stream and republishes it anyway, but a
   * `localHostId` that only resolves later does not - and that is the ordinary
   * case on a cold desktop start.
   */
  const publishElectronCapability = (): void => {
    const capable = canMaterializeElectronTab(runtime, args.owner.hostId);
    if (capable === coordinator.state.canMaterializeElectron) return;
    patchState({ canMaterializeElectron: capable });
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

  const attachTab = (tabId: string): Promise<void> =>
    sendRequest(pendingAttaches, ATTACH_TAB_TIMEOUT_MS, (requestId) => ({
      kind: "attachTab",
      hasBinaryPayload: false,
      requestId,
      tabId,
    }));

  const moveTab = (tabId: string): Promise<void> =>
    sendRequest(pendingMoves, ATTACH_TAB_TIMEOUT_MS, (requestId) => ({
      kind: "moveTab",
      hasBinaryPayload: false,
      requestId,
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
    rejectPendingRequests(pendingAttaches, closed);
    rejectPendingRequests(pendingMoves, closed);
    rejectPendingRequests(pendingOpens, closed);
    rejectPendingRequests(pendingPreviews, closed);
  };

  const onStatus = (
    next: BrowserSessionsLifecycle,
    errorMessage: string | null,
  ): void => {
    const wasLive = lifecycle === "live";
    lifecycle = next;
    // The PiP store is keyed by epic, and an `independent` stream has no epic
    // to key by. Nothing downstream would break on a sentinel; the store would
    // just grow a bucket no PiP surface ever reads.
    if (args.scope.kind === "epic") {
      applyPipHostLifecycle(args.scope.epicId, args.owner.hostId, next);
    }
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
      scope: args.scope,
      hostId: args.owner.hostId,
      setItems: (items) => {
        patchState({
          items,
          inventoryReady:
            frame.kind === "snapshot" || coordinator.state.inventoryReady,
        });
      },
      pendingCloses,
      pendingAttaches,
      pendingMoves,
      pendingOpens,
      pendingPreviews,
      presenters: selectBrowserSessionsPresenters(runtimes),
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
      canMaterializeElectron: canMaterializeElectronTab(
        runtime,
        args.owner.hostId,
      ),
      errorMessage: null,
    });
    lifecycle = "connecting";
    session = openBrowserSessionsSession({
      key: {
        scope: args.scope,
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
    scope: args.scope,
    captureTabPreview,
    state: {
      hostId: args.owner.hostId,
      lifecycle: "connecting",
      inventoryReady: false,
      canMaterializeElectron: canMaterializeElectronTab(
        args.runtime,
        args.owner.hostId,
      ),
      items: [],
      errorMessage: null,
      retry: restart,
      openTab,
      closeTab,
      attachTab,
      moveTab,
    },
    upsertConsumer: (consumerId, nextRuntime) => {
      runtimes.set(consumerId, nextRuntime);
      if (activeConsumerId !== consumerId) return;
      const changed = runtimeChanged(runtime, nextRuntime);
      runtime = nextRuntime;
      publishElectronCapability();
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
      publishElectronCapability();
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

/**
 * `actionAck` answers every void-result request on this stream, so it routes by
 * REQUEST ID across each pending map rather than assuming a close. Request ids
 * are `crypto.randomUUID()`, so at most one map holds any given one; reading
 * only `pendingCloses` would drop an `attachTab` ack on the floor and leave its
 * promise to time out as though the host had never answered.
 */
function handleActionAck(
  frame: Extract<BrowserSessionsUxServerFrame, { readonly kind: "actionAck" }>,
  pendingByRequestId: readonly PendingRequests<void>[],
): void {
  for (const pendingRequests of pendingByRequestId) {
    const pending = pendingRequests.get(frame.requestId);
    if (pending === undefined) continue;
    if (frame.ok) pending.resolve();
    else pending.reject(new Error(frame.reason ?? "Browser action failed."));
    return;
  }
}

/**
 * The one router for the frames a renderer may see. Its parameter is the
 * protocol's UX projection, so a jar frame is not merely unhandled here - it
 * cannot be handed to it (H10).
 */
function handleBrowserSessionsFrame(args: {
  readonly frame: BrowserSessionsUxServerFrame;
  readonly scope: HostResourceScope;
  readonly hostId: string;
  readonly currentItems: () => readonly BrowserSessionInfo[];
  readonly setItems: (items: readonly BrowserSessionInfo[]) => void;
  readonly pendingCloses: PendingRequests<void>;
  readonly pendingAttaches: PendingRequests<void>;
  readonly pendingMoves: PendingRequests<void>;
  readonly pendingOpens: PendingRequests<BrowserTabIdentity>;
  readonly pendingPreviews: PendingRequests<BrowserTabPreview>;
  readonly presenters: readonly BrowserSessionsPresenter[];
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
      handleActionAck(frame, [
        args.pendingCloses,
        args.pendingAttaches,
        args.pendingMoves,
      ]);
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
      applyCaptionFrame(frame, args.scope, args.hostId);
      return;
    case "tabOpened":
      surfaceTabOpenedFrame(frame, args.scope, args.hostId, args.presenters);
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
 * Captions ride an agent burst and the PiP store is keyed by epic, so this arm
 * is epic-scoped twice over. An independent stream never receives one - agents
 * are epic-scoped on the host - and the narrow is what makes that readable
 * here rather than assumed.
 */
function applyCaptionFrame(
  frame: Extract<BrowserSessionsUxServerFrame, { readonly kind: "caption" }>,
  scope: HostResourceScope,
  hostId: string,
): void {
  if (scope.kind !== "epic") return;
  applyPipCaption({
    epicId: scope.epicId,
    hostId,
    sessionId: frame.sessionId,
    tabId: frame.tabId,
    cellTitle: frame.cellTitle,
  });
}

/**
 * Where a host-opened tab is surfaced, which is a different place per scope.
 *
 * An epic stream's surface is that Epic's canvas, reached through a registered
 * presenter. An independent stream has no canvas - its tabs belong to the
 * device's Start Page - and the frame carries no scope restriction of its own,
 * so the arm below routes it rather than dropping it. What it can do there is
 * narrower: the panel is not necessarily mounted, and its tab list is built
 * from the device's inventory, so the identity is recorded for the panel's
 * reconciler to consume when it adopts the row.
 *
 * `source` is the whole decision on that side. A page opening a tab is a
 * gesture the reader made and expects to land on; an agent's is not - and an
 * agent has no business on an independent stream anyway, since agents are
 * epic-scoped on the host, which is exactly why the arm asserts it instead of
 * surfacing whatever arrives.
 */
function surfaceTabOpenedFrame(
  frame: Extract<BrowserSessionsUxServerFrame, { readonly kind: "tabOpened" }>,
  scope: HostResourceScope,
  hostId: string,
  presenters: readonly BrowserSessionsPresenter[],
): void {
  if (scope.kind !== "epic") {
    if (frame.source !== "page") return;
    recordIndependentPageOpenedTab({
      hostId,
      sessionId: frame.sessionId,
      tabId: frame.tabId,
    });
    return;
  }
  for (const presenter of presenters) {
    if (
      surfaceHostOpenedTab({
        epicId: scope.epicId,
        viewTabId: presenter.viewTabId,
        hostId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        source: frame.source,
        navigateNested: presenter.navigateNested,
      })
    ) {
      return;
    }
  }
}

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
