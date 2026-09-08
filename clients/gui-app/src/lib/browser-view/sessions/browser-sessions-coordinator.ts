import type {
  BrowserSessionInfo,
  BrowserSessionsUxClientFrame,
  BrowserSessionsUxServerFrame,
  BrowserTabIdentity,
  BrowserTabOpenedSource,
  BrowserTabPreview,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserSessionsLifecycle,
  BrowserViewBridge,
  BrowserViewNativeTabCapability,
  RecordingEvent,
} from "@traycer-clients/shared/platform/browser-view";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import { appLogger } from "@/lib/logger";
import { surfaceHostOpenedTab } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { browserSessionsReducer } from "@/lib/browser-view/sessions/browser-sessions-stream";
import {
  openBrowserSessionsSession,
  type BrowserSessionsSession,
} from "@/lib/browser-view/sessions/browser-sessions-session";
import {
  electronTabBindingByTab,
  publishElectronTabBinding,
  removeOwnedElectronTabBinding,
  removeOwnedElectronTabBindings,
} from "@/lib/browser-view/sessions/electron-tab-directory";
import { setBrowserGuestRecordingPresented } from "@/lib/browser-view/guest/persistent-browser-guest-host";
import {
  applyTabRecordingEnded,
  applyTabRecordingLive,
  applyTabRecordingStarted,
  forgetOwnedTabRecordings,
} from "@/lib/browser-view/sessions/tab-recording-store";
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
  readonly epicId: string;
  state: BrowserSessionsState;
  /**
   * Snapshot-only capture of one tab on this coordinator's host, for a chat
   * pinned to ANOTHER host (spec decision #10). It hangs off the coordinator
   * rather than off `BrowserSessionsState` because only the mention picker
   * calls it, keyed by coordinator.
   */
  captureTabPreview: (tabId: string) => Promise<BrowserTabPreview>;
  /** Fire-and-forget; a recording answer has no reply and no request id. */
  sendRecordingAnswer: (frame: BrowserSessionsUxClientFrame) => void;
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

/**
 * The `recordingEnded` reason a shell with no main process answers with. An
 * OPEN string on the wire, and the host only logs it, so it is a diagnostic
 * naming the shell's shape rather than a code either side branches on.
 */
const NO_RECORDING_HELPER = "no-recording-helper-runtime";

/**
 * The host asked this client to record a tab whose Electron guest this window
 * does not hold - another window's tile, or a binding that was retired between
 * the frame and this handler. There is nothing to point a helper at.
 */
const NO_ELECTRON_GUEST = "no-electron-guest-for-tab";

/**
 * Main refused or could not begin the helper. A CLOSED string, never the
 * rejection's message: the message is unbounded, and the request that produced
 * it carries the recording's bearer token. The cause is logged locally
 * instead.
 */
const HELPER_START_FAILED = "helper-start-failed";

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

/**
 * The two recording ANSWERS, sent up the named coordinator's stream.
 *
 * They are the desktop's, not this module's: the helper window lives in main,
 * so main is what knows a helper came up or went away, and the renderer
 * coordinator relays. Exported as functions rather than exposed on
 * `BrowserSessionsState` because the caller is an IPC handler outside React
 * (ticket 20), not a component reading state.
 *
 * Both are recording-addressed and idempotent: a repeat, or one for a
 * recording this client never saw start, updates nothing and sends a frame the
 * host drops.
 */
export function reportRecordingHelperReady(
  key: string,
  recordingId: string,
): void {
  const coordinator = browserSessionsCoordinators.get(key);
  if (coordinator === undefined) return;
  applyTabRecordingLive(recordingId);
  coordinator.sendRecordingAnswer({
    kind: "recordingHelperReady",
    hasBinaryPayload: false,
    recordingId,
  });
}

export function reportRecordingEnded(
  key: string,
  recordingId: string,
  reason: string,
): void {
  const coordinator = browserSessionsCoordinators.get(key);
  if (coordinator === undefined) return;
  applyTabRecordingEnded({ recordingId, status: "ended", reason });
  coordinator.sendRecordingAnswer({
    kind: "recordingEnded",
    hasBinaryPayload: false,
    recordingId,
    reason,
  });
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
  // Its own token, not `tabBindingOwner`: two epics open on one host are two
  // coordinators with the same `hostId`, and one closing must not clear the
  // other's recording rows.
  const recordingOwner = Symbol("browser-sessions-recordings");
  /**
   * Recordings this coordinator started, mapped to the guest registration
   * holding the recording posture for them. It is both the posture ledger and
   * the filter that tells this coordinator's helper events from a sibling
   * coordinator's on the shared bridge channel.
   */
  const recordingRegistrationIds = new Map<string, string>();
  let recordingEvents: { readonly dispose: () => void } | null = null;
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

  /**
   * One frame up the stream with no answer expected. Dropped while the stream
   * is not `live`: a recording answer describes a helper on THIS connection,
   * so queuing one for a future incarnation would report a window that no
   * longer exists to a host that has already timed the recording out.
   */
  const sendRecordingAnswer = (frame: BrowserSessionsUxClientFrame): void => {
    const live = session;
    if (live === null || lifecycle !== "live") return;
    try {
      live.send(frame);
    } catch (cause) {
      appLogger.warn("[browser] a recording answer did not reach the host", {
        frameKind: frame.kind,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
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

  /**
   * `startTabRecording`: the host wants a hidden helper window opened at
   * `helperUrl` for this tab (D15).
   *
   * The window itself is MAIN'S - it holds the display-media grant and the
   * capture-source seam - so this is a relay: mark the badge, put the guest in
   * the recording posture, hand main the request, and let
   * {@link onRecordingEvent} carry main's two answers back up the stream. The
   * `helperUrl` is passed through verbatim and never inspected here; it
   * carries the recording's one-shot bearer token, which is why no failure
   * path below quotes it.
   *
   * Two cases this client can settle by itself, and it answers both at once
   * rather than leaving the host to time the recording out. A shell with no
   * `browserView` bridge has no main process and can never open a helper. A
   * tab with no Electron guest in THIS window - another window's tile, or a
   * binding retired between the frame and here - has nothing to point one at.
   * Both are `refused` rather than `ended`: nothing was captured and no file
   * is coming, which is different copy and a different badge. The protocol
   * already reasons that a client-sent answer names an id only the host mints
   * and ends a recording the same user could end from the toolbar.
   */
  const startRecording = (frame: {
    readonly tabId: string;
    readonly recordingId: string;
    readonly helperUrl: string;
  }): void => {
    applyTabRecordingStarted({
      owner: recordingOwner,
      hostId: args.owner.hostId,
      tabId: frame.tabId,
      recordingId: frame.recordingId,
    });
    const browserView = runtime.browserView;
    if (browserView === null) {
      refuseRecording(frame.recordingId, NO_RECORDING_HELPER);
      return;
    }
    const binding = electronTabBindingByTab(args.owner.hostId, frame.tabId);
    if (binding === null) {
      refuseRecording(frame.recordingId, NO_ELECTRON_GUEST);
      return;
    }
    // The recording POSTURE, before the helper exists rather than after: the
    // capture cannot even START against a guest parked at the retained
    // off-screen rect (D15 probe finding), so the guest has to be on-screen by
    // the time main's helper asks for it.
    recordingRegistrationIds.set(frame.recordingId, binding.registrationId);
    setBrowserGuestRecordingPresented(binding.registrationId, true);
    void browserView
      .startRecording({
        hostId: binding.hostId,
        sessionId: binding.sessionId,
        tabId: binding.tabId,
        registrationId: binding.registrationId,
        recordingId: frame.recordingId,
        helperUrl: frame.helperUrl,
      })
      .catch((cause: unknown) => {
        appLogger.warn("[browser] a recording helper did not open", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
        releaseRecordingPosture(frame.recordingId);
        reportRecordingEnded(args.key, frame.recordingId, HELPER_START_FAILED);
      });
  };

  /**
   * Nothing was ever captured and no file is coming, which is a different
   * badge from a recording that ran and stopped - hence `refused` rather than
   * `ended`. The host still gets an answer, so it does not wait out the
   * start timeout for a helper that will never exist.
   */
  const refuseRecording = (recordingId: string, reason: string): void => {
    applyTabRecordingEnded({ recordingId, status: "refused", reason });
    sendRecordingAnswer({
      kind: "recordingEnded",
      hasBinaryPayload: false,
      recordingId,
      reason,
    });
  };

  /** Puts the guest back on whatever placement its tile publisher says. */
  const releaseRecordingPosture = (recordingId: string): void => {
    const registrationId = recordingRegistrationIds.get(recordingId);
    if (registrationId === undefined) return;
    recordingRegistrationIds.delete(recordingId);
    setBrowserGuestRecordingPresented(registrationId, false);
  };

  /**
   * `stopTabRecording`: the host is tearing the helper down - explicit stop,
   * auto-stop on tab close, the duration cap. Main owns the window, so the
   * stop has to reach it; `recordingEnded` comes back through
   * {@link onRecordingEvent} as the answer, exactly as it does for a helper
   * that died on its own.
   */
  const stopRecording = (recordingId: string): void => {
    const browserView = runtime.browserView;
    if (browserView === null) return;
    void browserView.stopRecording({ recordingId }).catch((cause: unknown) => {
      appLogger.warn("[browser] a recording stop did not reach main", {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
  };

  /**
   * The two facts only main can know, relayed onto this stream.
   *
   * Filtered to this coordinator's own recordings: several coordinators share
   * one `browserView` bridge and therefore one event channel, and a recording
   * belongs to the stream that asked for it.
   */
  const onRecordingEvent = (event: RecordingEvent): void => {
    if (!recordingRegistrationIds.has(event.recordingId)) return;
    if (event.kind === "helperReady") {
      reportRecordingHelperReady(args.key, event.recordingId);
      return;
    }
    releaseRecordingPosture(event.recordingId);
    reportRecordingEnded(args.key, event.recordingId, event.reason);
  };

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
      // A recording is helper- and socket-bound, so a stream that left `live`
      // has none running - and a badge left at `recording` would keep counting
      // against a run with nothing behind it. The helper window is main's
      // though, and survives the socket, so it is closed rather than merely
      // forgotten.
      for (const recordingId of [...recordingRegistrationIds.keys()]) {
        stopRecording(recordingId);
        releaseRecordingPosture(recordingId);
      }
      forgetOwnedTabRecordings(recordingOwner);
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
      presenters: selectBrowserSessionsPresenters(runtimes),
      currentItems: () => coordinator.state.items,
      startRecording,
      stopRecording,
    });
  };

  const onTabBound = (capability: BrowserViewNativeTabCapability): void => {
    const browserView = runtime.browserView;
    if (browserView === null) return;
    publishElectronTabBinding(tabBindingOwner, browserView, capability);
  };

  const start = (): void => {
    recordingEvents =
      runtime.browserView?.onRecordingEvent(onRecordingEvent) ?? null;
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
    recordingEvents?.dispose();
    recordingEvents = null;
    // The helper windows are MAIN'S and outlive this socket, so a stream that
    // is going away has to close them by hand: nothing else will, the answers
    // they would send have nowhere to go, and a hidden window per abandoned
    // recording is the orphan this must not leave behind. The posture goes
    // with them, or the guest would sit on-screen at opacity 0 forever.
    for (const recordingId of [...recordingRegistrationIds.keys()]) {
      stopRecording(recordingId);
      releaseRecordingPosture(recordingId);
    }
    removeOwnedElectronTabBindings(tabBindingOwner);
    rejectEveryPendingRequest();
    forgetOwnedTabRecordings(recordingOwner);
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
    sendRecordingAnswer,
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
  readonly presenters: readonly BrowserSessionsPresenter[];
  readonly startRecording: (frame: {
    readonly tabId: string;
    readonly recordingId: string;
    readonly helperUrl: string;
  }) => void;
  readonly stopRecording: (recordingId: string) => void;
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
    case "tabOpened":
      routeTabOpened({
        epicId: args.epicId,
        hostId: args.hostId,
        presenters: args.presenters,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        source: frame.source,
      });
      return;
    case "startTabRecording":
      args.startRecording(frame);
      return;
    case "stopTabRecording":
      // The host tearing the helper down - auto-stop on tab close, the
      // duration cap, or the toolbar. Terminal for the badge whether or not a
      // helper ever reported ready; `recordingEnded` is the desktop's own
      // answer to it, and arriving after this changes nothing.
      args.stopRecording(frame.recordingId);
      applyTabRecordingEnded({
        recordingId: frame.recordingId,
        status: "ended",
        reason: null,
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
 * The first presenter that claims a host-opened tab wins - the rest are other
 * surfaces on the same epic, and a tab belongs to one of them.
 */
function routeTabOpened(args: {
  readonly epicId: string;
  readonly hostId: string;
  readonly presenters: readonly BrowserSessionsPresenter[];
  readonly sessionId: string;
  readonly tabId: string;
  readonly source: BrowserTabOpenedSource;
}): void {
  for (const presenter of args.presenters) {
    if (
      surfaceHostOpenedTab({
        epicId: args.epicId,
        viewTabId: presenter.viewTabId,
        hostId: args.hostId,
        sessionId: args.sessionId,
        tabId: args.tabId,
        source: args.source,
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
