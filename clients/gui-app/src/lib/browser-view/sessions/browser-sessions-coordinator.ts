import {
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES,
  type BrowserForgetLedger,
  type BrowserSessionInfo,
  type BrowserSessionsClientFrame,
  type BrowserSessionsServerFrame,
  type BrowserTabIdentity,
  type BrowserTabPreview,
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
  /**
   * THIS machine's host id, or null on a shell with no local host. Declared to
   * the host on `electronTabLifecycleReady`: the host only elects an Electron
   * lifecycle owner whose declared id equals its own, so a GUI attached to a
   * remote host stays a pure viewer (spec decision #3).
   */
  readonly localHostId: string | null;
  /**
   * This renderer's desktop window id, or null off Electron. Threaded from
   * `<WindowsBridgeProvider>` alongside `localHostId` rather than probed off
   * `window`: the typed bridge is the one source, and a structural read here
   * would be a fourth private copy of the same probe.
   */
  readonly desktopWindowId: string | null;
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

interface BrowserSessionsActionChannel {
  readonly owner: BrowserSessionsOwner;
  lifecycle: BrowserSessionsLifecycle;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}

interface BrowserSessionsCoordinator {
  readonly owner: BrowserSessionsOwner;
  readonly epicId: string;
  state: BrowserSessionsState;
  /** Sends `forgetLogins` if this coordinator's stream is live. */
  forgetLogins: () => boolean;
  /** Sends `clearSite` for one domain if this coordinator's stream is live. */
  clearSite: (domain: string) => boolean;
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
 * Bound on one `captureTabPreview`. Its own constant rather than a borrowed
 * flush timeout: a preview is a live screenshot of a tab that may be dormant,
 * wedged or gone, and the mention picker awaiting it has no other way out.
 * The two happen to be the same number today; nothing ties them together.
 */
const TAB_PREVIEW_TIMEOUT_MS = 5_000;

/**
 * One last primary-profile capture per live `browser.sessions` stream this
 * renderer owns, before the desktop route goes away (quit, window close).
 *
 * When a route disappears the host suspends the session to dormant and
 * re-materializes it later from the durable tab URLs plus the primary-profile
 * store, so that store is the only thing carrying login state across the gap.
 * It must therefore be refreshed while the native tabs are still alive.
 *
 * EVERY open stream is flushed, remote hosts included: the partition this
 * renderer reads is the user's own jar, and it is that jar the remote host has
 * to be holding when it re-materializes their session (cross-host decision #6).
 *
 * Never rejects, and the streams run in parallel under one flush timeout: a
 * stream that cannot answer is reported by not having refreshed the store, not
 * by stalling the quit.
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

/**
 * Sends once per host, not once per coordinator: coordinators are keyed by
 * {epic, host, identity}, and these frames speak for the user's whole slice on
 * that host, so a second one for another epic of the same host would only ask
 * for the same work twice. Every host the user has a live browser stream to is
 * addressed - each host keeps its own key and its own slice. Answers whether
 * any live stream took it.
 */
function sendOncePerHost(
  send: (coordinator: BrowserSessionsCoordinator) => boolean,
): boolean {
  const addressedHostIds = new Set<string>();
  let sent = false;
  for (const coordinator of browserSessionsCoordinators.values()) {
    const hostId = coordinator.owner.hostId;
    if (addressedHostIds.has(hostId)) continue;
    if (!send(coordinator)) continue;
    addressedHostIds.add(hostId);
    sent = true;
  }
  return sent;
}

/**
 * "Forget all browser logins" (spec §6.5, ticket 08).
 *
 * BOTH halves run, and the ORDER between them is the point. This machine's own
 * jar and forget ledger go first and unconditionally; telling the hosts to
 * shred their slices is best-effort on top. Universal-sign-in decision 6 is
 * exactly the claim that a forget survives disconnection - the ledger carries
 * it to every host that was not listening - so making the local half
 * conditional on a live stream would delete the premise: with no host attached,
 * nothing would be forgotten anywhere and the user would be told so by a dialog
 * that simply refused to close.
 *
 * Answers how many hosts were told, for the caller's own reporting. It is NOT
 * a success flag: zero hosts still means this machine forgot.
 */
export function forgetAllBrowserLogins(
  browserView: BrowserViewBridge | null,
): number {
  void browserView?.forgetLogins().catch((cause: unknown) => {
    appLogger.warn("[browser] clearing the browser partition failed", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  });
  let hostCount = 0;
  sendOncePerHost((coordinator) => {
    const sent = coordinator.forgetLogins();
    if (sent) hostCount += 1;
    return sent;
  });
  return hostCount;
}

/**
 * "Clear" on one row of Settings > Browser (spec section 7.3, ticket 10).
 * Answers whether any live stream took it.
 *
 * The frame carries the domain rather than a tile key - unlike the tile menu's
 * clear-site, there is no tile here whose URL could name the site, and the
 * domain came from the host's own list in the first place.
 */
export function clearSavedLoginSite(domain: string): boolean {
  return sendOncePerHost((coordinator) => coordinator.clearSite(domain));
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
  const pendingCloses: PendingRequests<void> = new Map();
  const pendingOpens: PendingRequests<BrowserTabIdentity> = new Map();
  const pendingPreviews: PendingRequests<BrowserTabPreview> = new Map();
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
  /**
   * This host's outstanding forget-ledger digest, cached at COORDINATOR scope
   * and refreshed off events - never read inside the attach path.
   *
   * That is the whole reason it is a cache. The attach burst has to leave as
   * one synchronous, ordered unit (readiness, then the ledger, then the
   * store-key offer), and awaiting an IPC in the middle of it puts a
   * cross-process call on the critical path of the handshake: an invoke that
   * never settles would strand the connection with no readiness, no handshake
   * and no store key. Reading it here, before any stream exists, keeps the
   * burst synchronous and takes the failure mode away rather than bounding it
   * with a timer.
   *
   * `null` until the first read lands. The burst still goes out in that
   * window - never wedging is the higher rule - and the digest follows the
   * moment the read completes, through the same deferred push a mid-attach
   * forget uses.
   */
  let forgetLedgerDigest: BrowserForgetLedger | null = null;
  /** Set by the live stream, so a refreshed digest reaches it at once. */
  let onForgetLedgerRefreshed = (): void => undefined;
  /**
   * Re-reads this host's digest. Called at construction, on every local forget,
   * and after every ack - the last one matters most: an ack NARROWS what this
   * host is owed, and a cache that kept the pre-ack digest would re-assert on
   * the next reconnect exactly the forgets it already pruned, re-clearing any
   * site the user has signed back into since.
   */
  const refreshForgetLedger = (): void => {
    const browserView = runtime.browserView;
    if (browserView === null) return;
    void browserView.readForgetLedger(args.owner.hostId).then(
      (digest) => {
        forgetLedgerDigest = digest;
        onForgetLedgerRefreshed();
      },
      (cause: unknown) => {
        // Not a wedge: the burst goes out regardless, and what is lost is the
        // ack - which fails CLOSED, leaving this host's observations refused
        // for every site the ledger covers. The right direction for a forget
        // record this machine cannot read.
        appLogger.warn("[browser] could not read the forget ledger", {
          hostId: args.owner.hostId,
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
  };
  const forgetLedgerChanges =
    args.runtime.browserView?.onForgetLedgerChanged(() => {
      refreshForgetLedger();
    }) ?? null;
  refreshForgetLedger();
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

  /**
   * Sends one request frame and resolves on the answer that carries its
   * `requestId`. `timeoutMs` bounds the wait for a host that never answers at
   * all; a closed stream rejects every pending request through
   * `rejectPendingRequests` instead.
   */
  const sendRequest = <T>(
    pending: PendingRequests<T>,
    timeoutMs: number | null,
    frame: (requestId: string) => BrowserSessionsClientFrame,
  ): Promise<T> => {
    const channel = activeChannel();
    if (channel === null) {
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
        channel.sendClientFrame(frame(requestId));
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
    /**
     * Identity of the live stream incarnation, minted on every open and dropped
     * on every close. It is what the desktop's observed-frame rate limiter is
     * keyed by: the host replays its whole contributed set once per attach, so
     * a reconnect is a NEW burst and must not be charged to the last one's
     * budget. Null off-connection, which is also when no frame can arrive.
     */
    let observedConnectionId: string | null = null;
    /**
     * The highest forget-ledger revision this connection was actually sent
     * (universal-sign-in ticket 09), and the ceiling every ack from it is
     * clamped to.
     *
     * It lives beside {@link observedConnectionId} and is reset with it,
     * because it means nothing without one: the pair is what a connection
     * knows, and a new stream incarnation has been told nothing whatever its
     * predecessor heard. Zero until a digest leaves, which is what makes an
     * ack that no digest earned a no-op rather than a gate opener.
     */
    let sentForgetLedgerRevision = 0;
    // Unsolicited cookie deltas from the durable `primary` jar (spec §6.3).
    // Gated on this connection having sent `electronTabLifecycleReady`: that
    // readiness is exactly what makes the stream jar-authorized on the host, so
    // a connection that has not sent it would be dropped there anyway.
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
    /**
     * One digest onto the wire, plus the only trace this path writes.
     *
     * Traced at INFO because it is once per attach and once per forget, and
     * because this epic's bugs are found by forensics: "which revision did
     * this host last hear about" is the first question a resurrection asks,
     * and the ack line is the second. Counts and the revision only - never a
     * domain, which would put the user's sites in a log that gets pasted into
     * support threads.
     */
    const sendForgetLedger = (
      ledger: BrowserForgetLedger,
      stage: "attach" | "forget",
    ): void => {
      if (stream === null) return;
      stream.sendClientFrame({
        kind: "primaryProfileForgetLedger",
        hasBinaryPayload: false,
        ...ledger,
      });
      // AFTER the send, and only the digests that left: this is the fact an
      // ack is measured against, so it must not record one the wire never
      // carried. `max` because a cached digest can follow a newer one on the
      // deferred path, and a watermark only ever advances.
      sentForgetLedgerRevision = Math.max(
        sentForgetLedgerRevision,
        ledger.revision,
      );
      appLogger.info("[browser] pushed the forget ledger", {
        hostId: args.owner.hostId,
        stage,
        revision: ledger.revision,
        domains: ledger.domains.length,
        forgetAll: ledger.forgetAllAt !== null,
      });
    };
    /**
     * A digest this connection could not send when it was refreshed - because
     * the attach burst had not gone out yet, or the very first read had not
     * landed when it did. DEFERRED rather than dropped: the burst carries
     * whatever was cached at that instant, so a forget recorded either side of
     * it is one this connection would otherwise never hear about until the
     * next attach - and "forget means forget" includes the agent session
     * running right now.
     */
    let forgetLedgerPushDeferred = false;
    const pushForgetLedger = (): void => {
      const ledger = forgetLedgerDigest;
      if (
        ledger === null ||
        actionChannel !== channel ||
        connectionStatus !== "open" ||
        !electronLifecycleReadySentForConnection
      ) {
        // Held for the announce, which flushes it as its last step.
        forgetLedgerPushDeferred = true;
        return;
      }
      forgetLedgerPushDeferred = false;
      sendForgetLedger(ledger, "forget");
    };
    onForgetLedgerRefreshed = pushForgetLedger;
    /**
     * One host confirming it finished pruning this machine's ledger through a
     * revision (universal-sign-in ticket 04).
     *
     * Handled here rather than in the frame router because both identities it
     * needs are this connection's - the frame names neither, and a frame field
     * could only be forged - and because the ack narrows what this host is
     * owed, so the cached digest has to be re-read behind it.
     */
    const handleForgetLedgerAck = (revision: number): void => {
      const connectionId = observedConnectionId;
      if (browserView === null || connectionId === null) return;
      appLogger.info("[browser] host acked the forget ledger", {
        hostId: args.owner.hostId,
        revision,
        sent: sentForgetLedgerRevision,
      });
      void browserView
        .ackForgetLedger({
          hostId: args.owner.hostId,
          connectionId,
          revision,
          // What this connection was told, which is all its ack can be worth.
          // The clamp itself happens in the ledger, where the connection gate
          // and the durable watermark are both set from one value.
          sentRevision: sentForgetLedgerRevision,
        })
        .then(refreshForgetLedger, (cause: unknown) => {
          appLogger.warn("[browser] could not record a forget-ledger ack", {
            hostId: args.owner.hostId,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        });
    };
    /**
     * The connection's gate state in main, released when the stream goes. Main
     * treats an unknown connection as having acked nothing, so a release that
     * is missed costs a little memory and never correctness - but a release
     * that fires while the connection is still live would silently start
     * refusing that host's observations, so it is only ever called once the id
     * has been retired here.
     */
    const releaseForgetLedgerConnection = (connectionId: string): void => {
      void browserView
        ?.releaseForgetLedgerConnection(connectionId)
        .catch(() => undefined);
    };
    // Quit-flush waiters keyed by the capture `requestId` each answers. The
    // host acks a `primaryProfileCaptured` once it has DURABLY stored (or
    // rejected) that jar, which is what the quit path actually needs to know.
    // Never rejects: an unanswered flush is a timeout, and a stream going away
    // resolves it - a quit must not stall or throw on either.
    const captureAckWaiters = new Map<string, () => void>();
    const resolveCaptureAckWaiter = (requestId: string): void => {
      const settle = captureAckWaiters.get(requestId);
      if (settle === undefined) return;
      captureAckWaiters.delete(requestId);
      settle();
    };
    const resolveCaptureAckWaiters = (): void => {
      for (const settle of [...captureAckWaiters.values()]) settle();
      captureAckWaiters.clear();
    };
    const awaitCaptureAck = (requestId: string): Promise<void> =>
      new Promise<void>((resolve) => {
        if (actionChannel !== channel || connectionStatus !== "open") {
          resolve();
          return;
        }
        const timer = window.setTimeout(() => {
          captureAckWaiters.delete(requestId);
          resolve();
        }, FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);
        captureAckWaiters.set(requestId, () => {
          window.clearTimeout(timer);
          resolve();
        });
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
      // ONE synchronous burst, and the order in it is the attach ordering
      // guarantee. `electronTabLifecycleReady` is what makes this stream
      // jar-authorized on the host; the ledger digest rides immediately behind
      // it on the same ordered stream; and the store-key handshake the host
      // starts off readiness costs a full round trip - so the digest is always
      // RECEIVED before the handshake completes, and therefore before the
      // attach replay it must precede. Nothing here waits on a clock, and
      // nothing here waits on an IPC.
      stream?.sendClientFrame({
        kind: "electronTabLifecycleReady",
        hasBinaryPayload: false,
        coLocatedHostId: localHostId,
        desktopWindowId: runtime.desktopWindowId,
      });
      const ledger = forgetLedgerDigest;
      if (ledger !== null) sendForgetLedger(ledger, "attach");
      // This machine can hold the host's store key. The host answers with a
      // wrap or an unwrap request (handled below); it ignores the offer when
      // it already has the key in memory. It rides with the readiness frame
      // because readiness is what makes this stream jar-authorized - and the
      // host now also starts the handshake off that frame, so the offer is
      // usually the second of the two and simply ignored.
      stream?.sendClientFrame({
        kind: "storeKeyOffer",
        hasBinaryPayload: false,
      });
      // The cache was empty when the burst went out, or a forget landed while
      // it was being assembled. Either way this connection has not been told,
      // and the ordering above already held.
      if (ledger === null || forgetLedgerPushDeferred) pushForgetLedger();
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
        observedConnectionId = crypto.randomUUID();
        // A new incarnation has been told nothing yet, so it can ack nothing
        // yet either - the same fresh start main gives its own gate for an
        // unknown connection id.
        sentForgetLedgerRevision = 0;
        electronTabs.connect();
        sendLifecycleReadyIfReady();
      } else {
        // Retired here, and released only after: main must never be told a
        // live connection is gone. The sent revision goes with the id in the
        // same step - it is the other half of what this connection knows, and
        // holding it past the close would price the next one's ack off a
        // digest it never received.
        const closed = observedConnectionId;
        observedConnectionId = null;
        sentForgetLedgerRevision = 0;
        if (closed !== null) releaseForgetLedgerConnection(closed);
        if (wasOpen) connectionGeneration += 1;
        resolveCaptureAckWaiters();
        electronTabs.disconnect();
        electronLifecycleReadySentForConnection = false;
        // The next announce reads the ledger fresh, so a deferral held over
        // from the connection that just died would only re-send what that
        // read already carries.
        forgetLedgerPushDeferred = false;
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
      if (frame.kind === "primaryProfileCaptureAck") {
        resolveCaptureAckWaiter(frame.requestId);
      }
      // Answered here rather than in the router for the same reason the
      // capture ack is: it needs this connection's own identity, and its
      // side effect is to re-read a cache this closure owns.
      if (frame.kind === "primaryProfileForgetLedgerAck") {
        handleForgetLedgerAck(frame.revision);
      }
      const frameGeneration = connectionGeneration;
      handleBrowserSessionsFrame({
        frame,
        epicId: args.epicId,
        hostId: args.owner.hostId,
        connectionId: observedConnectionId,
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
      primaryProfileDeltas?.dispose();
      electronTabs.dispose();
      transport.close();
      throw cause;
    }
    const opened = stream;

    captureFinalPrimaryProfile = async (): Promise<void> => {
      if (actionChannel !== channel || connectionStatus !== "open") return;
      const requestId = crypto.randomUUID();
      const acked = awaitCaptureAck(requestId);
      await capturePrimaryProfileOnce({
        requestId,
        browserView,
        sendClientFrame: (response) => {
          if (actionChannel !== channel) return;
          opened.sendClientFrame(response);
        },
      });
      await acked;
    };

    stopCurrentStream = () => {
      if (actionChannel === channel) actionChannel = null;
      const closed = observedConnectionId;
      observedConnectionId = null;
      sentForgetLedgerRevision = 0;
      if (closed !== null) releaseForgetLedgerConnection(closed);
      primaryProfileDeltas?.dispose();
      captureFinalPrimaryProfile = (): Promise<void> => Promise.resolve();
      resolveCaptureAckWaiters();
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
      // Coordinator-scoped, unlike the delta subscription: the digest cache it
      // feeds outlives every stream this coordinator opens.
      forgetLedgerChanges?.dispose();
      onForgetLedgerRefreshed = (): void => undefined;
      stopCurrentStream();
      stopCurrentStream = (): void => undefined;
    },
  };
  start();
  return coordinator;
}

function handleCloseAck(
  frame: Extract<BrowserSessionsServerFrame, { readonly kind: "actionAck" }>,
  pendingCloses: PendingRequests<void>,
): void {
  const pending = pendingCloses.get(frame.requestId);
  if (pending === undefined) return;
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
  /** The live stream incarnation this frame arrived on; null once it closed. */
  readonly connectionId: string | null;
  readonly currentItems: () => readonly BrowserSessionInfo[];
  readonly setItems: (items: readonly BrowserSessionInfo[]) => void;
  readonly pendingCloses: PendingRequests<void>;
  readonly pendingOpens: PendingRequests<BrowserTabIdentity>;
  readonly pendingPreviews: PendingRequests<BrowserTabPreview>;
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
        connectionId: args.connectionId,
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
  readonly connectionId: string | null;
  readonly pendingOpens: PendingRequests<BrowserTabIdentity>;
  readonly pendingPreviews: PendingRequests<BrowserTabPreview>;
  readonly browserView: BrowserViewBridge | null;
  readonly sendClientFrame: (frame: BrowserSessionsClientFrame) => void;
}): void {
  const frame = args.frame;
  switch (frame.kind) {
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
    case "capturePrimaryProfile":
      handlePrimaryProfileCaptureFrame({
        frame,
        browserView: args.browserView,
        sendClientFrame: args.sendClientFrame,
      });
      return;
    case "primaryProfileObserved":
      applyObservedProfileFrame({
        frame,
        hostId: args.hostId,
        connectionId: args.connectionId,
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
    // `primaryProfileCaptureAck` and `primaryProfileForgetLedgerAck` are both
    // answered in `onServerFrame`, which owns the quit-flush waiters and the
    // connection identity the ledger ack is recorded under; the burst frames
    // are progress-only.
    case "burstStarted":
    case "burstEnded":
    case "primaryProfileCaptureAck":
    case "primaryProfileForgetLedgerAck":
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
 * Settles one `openTab`, the way {@link handleCloseAck} settles one close.
 * Extracted for the same reason: inlined, it puts
 * {@link handleBrowserSessionsSubsystemFrame} over the complexity budget.
 */
function handleOpenTabResult(
  frame: Extract<
    BrowserSessionsServerFrame,
    { readonly kind: "openTabResult" }
  >,
  pendingOpens: PendingRequests<BrowserTabIdentity>,
): void {
  const pending = pendingOpens.get(frame.requestId);
  if (pending === undefined) return;
  if (frame.result.ok) pending.resolve(frame.result);
  else pending.reject(new Error(frame.result.reason));
}

/**
 * A sign-in one of the user's hosts witnessed inside a headless session
 * (universal-sign-in decisions 1-5), offered to this machine's master jar.
 *
 * The renderer judges the frame's CONTENT not at all: independent domain
 * re-derivation, the expired-cookie rejection, the clear-in-progress gate and
 * the rate limit are main's, because main is where the jar is. It owns two
 * other things.
 *
 * PROVENANCE: the frame names no contributor, so the host and the stream
 * incarnation it arrived on are taken from this coordinator's own connection
 * and travel with it. A window with no desktop bridge, or one whose stream has
 * closed under it, has nowhere to put the observation.
 *
 * SIZE: this array is about to be copied across the IPC boundary into the MAIN
 * process, and the mux's own frame ceiling is megabytes wide, so an oversized
 * frame is dropped here rather than handed over and rejected after the copy.
 * Main re-checks the same bound and owns the `over-bound` trace; this is a
 * cheap pre-filter in front of a memory cost, not the authority.
 *
 * Nothing here re-checks that the sending host was allowed to write this jar.
 * That authorization is a server-side fact (`jarAuthorizedSubscribersForUser`,
 * decided from stream facts no client declares) and the server is its only
 * authority; all a client can add is validation of the CONTENT plus the
 * connection provenance above, which is the only host-identity fact it holds.
 *
 * Fire-and-forget: the frame is a fan-out, not a request, and the applied
 * cookies find their own way back to the hosts as an ordinary delta.
 */
function applyObservedProfileFrame(args: {
  readonly frame: Extract<
    BrowserSessionsServerFrame,
    { readonly kind: "primaryProfileObserved" }
  >;
  readonly hostId: string;
  readonly connectionId: string | null;
  readonly browserView: BrowserViewBridge | null;
}): void {
  const browserView = args.browserView;
  const connectionId = args.connectionId;
  if (browserView === null || connectionId === null) return;
  if (
    args.frame.cookies.length > BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES
  ) {
    appLogger.warn("[browser] dropped an over-bound observed sign-in", {
      hostId: args.hostId,
      cookies: args.frame.cookies.length,
    });
    return;
  }
  void browserView
    .applyObservedProfile({
      connectionId,
      hostId: args.hostId,
      domain: args.frame.domain,
      cookies: args.frame.cookies,
    })
    .catch((cause: unknown) => {
      appLogger.warn("[browser] could not apply an observed sign-in", {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
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
    void browserView
      .wrapStoreKey(frame.rawKey)
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
  void browserView
    .unwrapStoreKey(frame.wrappedKey)
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
