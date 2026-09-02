import { randomUUID } from "node:crypto";
import type {
  BrowserForgetLedger,
  BrowserPrimaryProfileDelta,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
  BrowserSessionsUxClientFrame,
  BrowserSessionsUxServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES,
  isBrowserSessionsJarServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { BrowserSessionsStreamClient } from "@traycer-clients/shared/host-transport/browser-sessions-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  browserSessionsError,
  browserSessionsLifecycle,
  browserSessionsStreamKeyId,
  type BrowserSessionsLifecycle,
  type BrowserSessionsStreamEventEnvelope,
  type BrowserSessionsStreamKey,
} from "@traycer-clients/shared/platform/browser-view";
import { describeLogError, log } from "../app/logger";
import type { BrowserPrimaryProfileCaptureResult } from "../browser-view/storage/browser-storage-state";
import type { DesktopIdentityAttestation } from "../browser-view/storage/browser-desktop-identity";
import {
  createElectronTabs,
  type BrowserSessionsTabPort,
  type ElectronTabs,
} from "./browser-sessions-electron-tabs";
import type {
  BrowserSessionsHostDirectory,
  BrowserSessionsHostTransport,
} from "./browser-sessions-transport";

/**
 * Bound on the round trip that proves one final capture reached the host.
 *
 * A liveness escape from a host that never acks, not an ordering device: the
 * quit path is already bounded by the shell's own budget, and this only has to
 * be shorter so a lost socket costs a beat rather than the whole wait.
 */
export const FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS = 5_000;

/**
 * How many `browser.sessions` streams one window may hold.
 *
 * The renderer names the stream, and every distinct `identityKey` it names
 * costs a socket, a relay attach, a desktop identity attestation and a whole
 * contributed-set replay. A window drives one epic's browser surface at a time
 * plus whatever is warm behind it, so a dozen is far above any real shape and
 * still bounds a renderer that loops the key.
 */
const MAX_STREAMS_PER_WINDOW = 12;

/**
 * Everything the jar plane needs, in the process that owns the jar.
 *
 * Declared as a port rather than imported module-by-module so the suites drive
 * the REAL frame flow against real storage doubles - which process these run
 * in is the whole point, and a test that mocks the frame router instead would
 * pin nothing about that.
 */
export interface BrowserSessionsJarPort {
  capturePrimaryProfile(): Promise<BrowserPrimaryProfileCaptureResult>;
  applyObservedProfile(input: {
    readonly connectionId: string;
    readonly hostId: string;
    readonly domain: string;
    readonly cookies: BrowserSessionsObservedCookies;
  }): Promise<void>;
  /**
   * The store key is per USER, so both halves are matched on the account as
   * well as on the blob: this machine's own blob for another account is as
   * foreign as another machine's. The ids are main's own - the
   * stream passes what it opened for, and the host it opened to, which is the
   * wrap ledger's eviction key.
   */
  wrapStoreKey(rawKey: string, userId: string, hostId: string): string | null;
  unwrapStoreKey(wrappedKey: string, userId: string): string | null;
  attestDesktopIdentity(input: {
    readonly hostId: string;
    readonly nonce: string;
  }): Promise<DesktopIdentityAttestation | null>;
  readForgetLedger(hostId: string): BrowserForgetLedger;
  recordForgetLedgerAck(input: {
    readonly hostId: string;
    readonly connectionId: string;
    readonly revision: number;
    readonly sentRevision: number;
  }): Promise<void>;
  releaseForgetLedgerConnection(connectionId: string): void;
  onForgetLedgerChanged(listener: () => void): { dispose: () => void };
  onPrimaryProfileDelta(
    listener: (delta: BrowserPrimaryProfileDelta) => void,
  ): { dispose: () => void };
}

type BrowserSessionsObservedCookies = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "primaryProfileObserved" }
>["cookies"];

export interface BrowserSessionsRegistryDeps {
  readonly directory: BrowserSessionsHostDirectory;
  readonly openTransport: (
    target: HostDirectoryEntry,
    userId: string,
  ) => BrowserSessionsHostTransport | null;
  readonly jar: BrowserSessionsJarPort;
  readonly tabs: BrowserSessionsTabPort;
  /**
   * The signed-in user main opens a stream FOR - read here, never taken from
   * the renderer: it is half of the relay attach grant's identity, and a
   * renderer that could name it could name someone else's.
   * `null` while the desktop is signed out, which opens nothing.
   */
  readonly userId: () => string | null;
  /** THIS machine's host id, or null while none is published. */
  readonly localHostId: () => string | null;
  /**
   * Fires when that id changes.
   *
   * Readiness is sent once per connection and only once a local host id
   * exists, because a null locality can never be elected and would stick for
   * the whole connection. A host that starts AFTER the stream opened is
   * ordinary - the desktop launches its host beside itself - so the burst has
   * to be re-driven rather than waiting for a reconnect that may never come.
   */
  readonly subscribeLocalHostChange: (listener: () => void) => () => void;
  /**
   * Fires whenever this process is handed a fresh bearer.
   *
   * Main opens its streams with `auth: null` (the app-wide revalidator lives
   * in the renderer and must stay single-flight), so nothing here can RECOVER
   * an `UNAUTHORIZED`. What main does have is the rotated bearer itself: the
   * renderer pushes every one of them into the desktop auth session. Feeding
   * it forward is what keeps the host's per-connection expiry close from
   * ending the jar plane one token lifetime after launch.
   */
  readonly subscribeBearerRotation: (listener: () => void) => () => void;
  readonly emit: (
    windowId: string,
    envelope: BrowserSessionsStreamEventEnvelope,
  ) => void;
}

/** One window's view of a stream identity, over the shared encoder. */
function streamKeyId(windowId: string, key: BrowserSessionsStreamKey): string {
  return JSON.stringify([windowId, browserSessionsStreamKeyId(key)]);
}

/**
 * Every main-owned `browser.sessions` stream, keyed by
 * `{windowId, epicId, hostId, identityKey}`.
 *
 * NOT deduped across windows, deliberately: one subscriber is one Electron
 * lifecycle owner, so collapsing two windows onto one would put both windows'
 * native tabs on one route and give the second nothing to bind. One renderer
 * stream became one main stream; nothing was added.
 */
export class BrowserSessionsRegistry {
  private readonly streams = new Map<string, BrowserSessionsStream>();
  private readonly deps: BrowserSessionsRegistryDeps;
  private readonly stopLocalHostChanges: () => void;
  private readonly stopBearerRotations: () => void;
  private disposed = false;

  constructor(deps: BrowserSessionsRegistryDeps) {
    this.deps = deps;
    this.stopLocalHostChanges = deps.subscribeLocalHostChange(() => {
      for (const stream of this.streams.values()) stream.retryLifecycleReady();
    });
    this.stopBearerRotations = deps.subscribeBearerRotation(() => {
      // BEFORE the streams are told, so a restart that follows resolves
      // against the new identity's registry rather than the old one's cache.
      deps.directory.reset();
      for (const stream of this.streams.values()) stream.notifyBearerRotated();
    });
  }

  open(windowId: string, key: BrowserSessionsStreamKey): void {
    if (this.disposed) return;
    const id = streamKeyId(windowId, key);
    if (this.streams.has(id)) return;
    if (this.countStreamsForWindow(windowId) >= MAX_STREAMS_PER_WINDOW) {
      log.warn("[browser-sessions] refused a stream over the per-window cap", {
        hostId: key.hostId,
        streams: MAX_STREAMS_PER_WINDOW,
      });
      // Reported as `failed`, exactly like a stream that could not reach a
      // socket: a silent refusal leaves the renderer's session in `connecting`
      // for the life of the window, with nothing to retry and nothing to show.
      this.deps.emit(windowId, {
        key,
        event: {
          kind: "status",
          lifecycle: "failed",
          errorMessage: "This window has too many browser sessions open.",
        },
      });
      return;
    }
    const stream = new BrowserSessionsStream(windowId, key, this.deps, () => {
      // A stream that will never reach a socket is not holding a place under
      // the cap: it is dropped from the map by the same edge that reported
      // `failed` to the renderer, and re-opening it is one invoke away.
      if (this.streams.get(id) !== stream) return;
      this.streams.delete(id);
      stream.dispose();
    });
    this.streams.set(id, stream);
    stream.start();
  }

  private countStreamsForWindow(windowId: string): number {
    let count = 0;
    for (const stream of this.streams.values()) {
      // A stream that never opened for an identity holds no socket, no
      // attestation and no replay - the cap exists to bound those. Counting
      // it would let a window that opened keys while signed out reach the cap
      // with records that cost nothing, and the refusal would then fall on the
      // streams that do.
      if (stream.windowId === windowId && stream.holdsConnection) count += 1;
    }
    return count;
  }

  close(windowId: string, key: BrowserSessionsStreamKey): void {
    const id = streamKeyId(windowId, key);
    const stream = this.streams.get(id);
    if (stream === undefined) return;
    this.streams.delete(id);
    stream.dispose();
  }

  send(
    windowId: string,
    key: BrowserSessionsStreamKey,
    frame: BrowserSessionsUxClientFrame,
  ): void {
    this.streams.get(streamKeyId(windowId, key))?.sendUxFrame(frame);
  }

  /**
   * A renderer went away. Its streams go with it, which reproduces today's
   * behaviour exactly - the renderer owning the socket meant a reload dropped
   * it - and the fresh renderer re-opens.
   */
  closeWindow(windowId: string): void {
    for (const [id, stream] of [...this.streams]) {
      if (stream.windowId !== windowId) continue;
      this.streams.delete(id);
      stream.dispose();
    }
  }

  /**
   * Drops every stream whose window is gone.
   *
   * A renderer reset is handled by {@link closeWindow}; this is the other
   * door - the window itself closing - and it matters more than a leaked
   * socket would: the subscriber is the Electron lifecycle owner for the tabs
   * that window held, so one left open keeps their placement alive against a
   * window that cannot paint them.
   */
  retainWindows(liveWindowIds: ReadonlySet<string>): void {
    for (const [id, stream] of [...this.streams]) {
      if (liveWindowIds.has(stream.windowId)) continue;
      this.streams.delete(id);
      stream.dispose();
    }
  }

  /**
   * One last primary-profile capture per live stream, before a desktop route
   * goes away (quit, window close).
   *
   * When a route disappears the host suspends the session to dormant and
   * re-materializes it later from the durable tab URLs plus the primary-profile
   * store, so that store is the only thing carrying login state across the gap.
   * EVERY stream is flushed, remote hosts included: the partition this machine
   * holds is the user's own jar.
   *
   * `windowId` null means every window (the quit path). Never rejects: a stream
   * that cannot answer is reported by not having refreshed the store, not by
   * stalling the quit.
   */
  async captureFinalPrimaryProfiles(windowId: string | null): Promise<void> {
    const targets = [...this.streams.values()].filter(
      (stream) => windowId === null || stream.windowId === windowId,
    );
    await Promise.allSettled(
      targets.map((stream) => stream.captureFinalPrimaryProfile()),
    );
  }

  /**
   * Tells every host this process holds a live stream to that the user forgot
   * their logins - once per host, not once per stream: streams are keyed by
   * {window, epic, host, identity} and the frame speaks for the user's whole
   * slice on that host. Answers how many hosts were told.
   */
  forgetLoginsOnEveryHost(): number {
    return this.sendOncePerHost({
      kind: "forgetLogins",
      hasBinaryPayload: false,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopLocalHostChanges();
    this.stopBearerRotations();
    for (const stream of this.streams.values()) stream.dispose();
    this.streams.clear();
  }

  private sendOncePerHost(frame: BrowserSessionsClientFrame): number {
    const addressed = new Set<string>();
    for (const stream of this.streams.values()) {
      if (addressed.has(stream.hostId)) continue;
      if (!stream.sendJarActionFrame(frame)) continue;
      addressed.add(stream.hostId);
    }
    return addressed.size;
  }
}

/**
 * One `browser.sessions` stream, owned by main on behalf of one window.
 *
 * It is the renderer coordinator's stream half, moved: the socket, the attach
 * burst, the forget-ledger digest and ack, the store-key handshake, the desktop
 * identity attestation, the observed/capture jar traffic and the whole Electron
 * tab lifecycle. What crosses back to the renderer is the UX projection and two
 * identity-only tab events.
 */
class BrowserSessionsStream {
  readonly windowId: string;
  readonly hostId: string;
  private readonly key: BrowserSessionsStreamKey;
  private readonly deps: BrowserSessionsRegistryDeps;
  private readonly onFailedToOpen: () => void;

  private transport: BrowserSessionsHostTransport | null = null;
  private client: BrowserSessionsStreamClient | null = null;
  private electronTabs: ElectronTabs | null = null;
  private forgetLedgerChanges: { dispose: () => void } | null = null;
  private primaryProfileDeltas: { dispose: () => void } | null = null;

  private disposed = false;
  /**
   * The live incarnation of `start()`. Bumped by every teardown, so a
   * resolution that was in flight across one drops instead of attaching.
   */
  private generation = 0;
  /**
   * This stream's socket is not coming back on its own.
   *
   * `WsStreamClient` goes terminal on an `UNAUTHORIZED` when it holds no
   * revalidator, and the host closes a connection at its bearer's `exp`, so
   * "terminal" is the ORDINARY end of a stream that has run for one token
   * lifetime - not an exceptional state. The rotation that follows is what
   * restarts it.
   */
  private terminal = false;
  private connectionStatus: StreamConnectionStatus = "connecting";
  private snapshotReady = false;
  private lifecycleReadySent = false;
  /**
   * Identity of the live stream incarnation, minted on every open and dropped
   * on every close. The observed-frame rate limiter and the forget ledger's
   * per-connection ack watermark are both keyed by it: the host replays its
   * whole contributed set once per attach, so a reconnect is a NEW burst and
   * must not be charged to the last one's budget.
   */
  private connectionId: string | null = null;
  /**
   * The highest forget-ledger revision this connection was actually sent, and
   * the ceiling every ack from it is clamped to. It lives beside
   * {@link connectionId} and is reset with it, because it means nothing
   * without one: a new incarnation has been told nothing, whatever its
   * predecessor heard.
   */
  private sentForgetLedgerRevision = 0;
  /**
   * The `requestId` this host issued as its STANDING capture request.
   *
   * It arrives once per connection, when the host completes the store-key
   * handshake, and it means "capture nothing now, keep this id": from that
   * point the host refuses any capture that answers neither it nor an
   * outstanding request. The quit flush quotes it instead of minting one.
   * Held for the life of the connection - a quit flush is the last thing this
   * desktop sends, and there is nobody left to re-issue for - and dropped with
   * the connection, because a reconnect brings a new one.
   */
  private standingCaptureRequestId: string | null = null;
  /**
   * The account this stream was OPENED for, captured at `start()`.
   *
   * Every jar answer is priced against it rather than against a live read: a
   * sign-out or an account switch mid-handshake would otherwise wrap under one
   * account and unwrap under another, which is exactly the confusion the
   * ledger's per-user match exists to refuse. `null` only before the first
   * attach.
   */
  private openedUserId: string | null = null;

  /**
   * Has this stream actually opened for an identity? `false` while the desktop
   * is signed out, when `start()` returns before dialling anything. See
   * {@link BrowserSessionsRegistry.countStreamsForWindow}.
   */
  get holdsConnection(): boolean {
    return this.openedUserId !== null;
  }
  private readonly captureAckWaiters = new Map<string, () => void>();

  constructor(
    windowId: string,
    key: BrowserSessionsStreamKey,
    deps: BrowserSessionsRegistryDeps,
    onFailedToOpen: () => void,
  ) {
    this.windowId = windowId;
    this.hostId = key.hostId;
    this.key = key;
    this.deps = deps;
    this.onFailedToOpen = onFailedToOpen;
  }

  start(): void {
    this.emitStatus("connecting", null);
    const userId = this.deps.userId();
    if (userId === null) {
      // Signed out: there is no identity to open a stream for. A sign-in
      // rotates the bearer, and that is what re-drives this. Deliberately not
      // a failure - nothing was reported to the renderer to retry.
      //
      // The entry stays in the registry so the sign-in can re-drive it, which
      // is why `countStreamsForWindow` skips a stream in this state: a window
      // that opened keys while signed out would otherwise fill its cap with
      // stream records holding no socket, and the refusal would then land on
      // the streams that matter once the user signs in.
      return;
    }
    this.openedUserId = userId;
    // The incarnation this resolve belongs to. A directory read is one await
    // wide, and a bearer rotation inside it tears this stream down and starts
    // a second one; without the check both resolutions would `attach()`, and
    // the first would orphan a live client and leave two subscribers on one
    // epic.
    const generation = this.generation;
    void this.deps.directory
      .resolve(this.hostId)
      .then((target) => {
        if (this.disposed || generation !== this.generation) return;
        if (target === null) {
          this.failToOpen("This host is not in the directory.");
          return;
        }
        const transport = this.deps.openTransport(target, userId);
        if (transport === null) {
          this.failToOpen("This host cannot be dialed.");
          return;
        }
        this.attach(transport);
      })
      .catch((cause: unknown) => {
        if (this.disposed || generation !== this.generation) return;
        log.warn("[browser-sessions] could not open a stream", {
          hostId: this.hostId,
          error: describeLogError(cause),
        });
        this.failToOpen("Browser sessions stream could not open.");
      });
  }

  /**
   * A stream that never reached a socket. The renderer is told, and the
   * registry drops it so it holds no place under the per-window cap - the
   * renderer's own retry re-opens, which is the same recovery a terminal
   * socket already had.
   */
  private failToOpen(errorMessage: string): void {
    this.emitStatus("failed", errorMessage);
    this.onFailedToOpen();
  }

  private attach(transport: BrowserSessionsHostTransport): void {
    this.transport = transport;
    this.electronTabs = createElectronTabs({
      hostId: this.hostId,
      windowId: this.windowId,
      tabs: this.deps.tabs,
      connectionId: () => this.connectionId,
      sendFrame: (frame) => {
        this.sendClientFrame(frame);
      },
      onTabBound: (capability) => {
        this.emit({ kind: "tabBound", capability });
      },
      onTabReleased: (capability) => {
        this.emit({ kind: "tabReleased", capability });
      },
    });
    // Unsolicited cookie deltas from the durable `primary` jar. Gated on this
    // connection having sent `electronTabLifecycleReady`: that readiness is
    // what makes the stream jar-authorized on the host, so a connection that
    // has not sent it would be dropped there anyway.
    this.primaryProfileDeltas = this.deps.jar.onPrimaryProfileDelta((delta) => {
      if (this.connectionStatus !== "open" || !this.lifecycleReadySent) return;
      this.sendClientFrame({
        kind: "primaryProfileDelta",
        hasBinaryPayload: false,
        ...delta,
      });
    });
    // A forget landed in this machine's ledger, in whichever window performed
    // it. Every stream pushes its host's fresh digest.
    this.forgetLedgerChanges = this.deps.jar.onForgetLedgerChanged(() => {
      this.pushForgetLedger("forget");
    });
    try {
      this.client = new BrowserSessionsStreamClient({
        wsStreamClient: transport.wsStreamClient,
        epicId: this.key.epicId,
        callbacks: {
          onServerFrame: (frame) => {
            this.handleServerFrame(frame);
          },
          onConnectionStatus: (status, reason) => {
            this.handleConnectionStatus(status, reason);
          },
        },
      });
    } catch (cause) {
      log.warn("[browser-sessions] stream subscription failed", {
        hostId: this.hostId,
        error: describeLogError(cause),
      });
      // `teardown()`, not `teardownTransport()`: the electron-tab registration
      // and the two jar subscriptions above are already installed by the time
      // the client constructor can throw, and closing only the transport left
      // them registered until `dispose()` with nothing to drive them - a
      // `primaryProfileDelta` handler holding a live jar listener on a stream
      // that will never open.
      this.teardown();
      this.emitStatus("failed", "Browser sessions stream could not open.");
    }
  }

  sendUxFrame(frame: BrowserSessionsUxClientFrame): void {
    // A preview is a screenshot of a signed-in page, and `openTab` is one IPC
    // away, so a renderer that could ask for both could photograph the user's
    // mail without anything appearing on screen. A preview of a guest THIS
    // desktop owns is therefore answered only while that guest is on screen.
    // A tab this stream owns no guest for is the picker's ordinary case (a tab
    // on the host's own side) and is passed through: the host answers for its
    // own tabs, and nothing here can see them.
    if (
      frame.kind === "captureTabPreview" &&
      this.electronTabs?.isTabViewed(frame.tabId) === false
    ) {
      log.warn("[browser-sessions] refused a preview of an off-screen tab", {
        hostId: this.hostId,
      });
      return;
    }
    this.sendClientFrame(frame);
  }

  /**
   * One `forgetLogins` / `clearSite` onto a LIVE stream. Answers whether it
   * went, so the caller can report how many hosts were told; a stream that is
   * not open took nothing.
   */
  sendJarActionFrame(frame: BrowserSessionsClientFrame): boolean {
    if (this.connectionStatus !== "open" || this.client === null) return false;
    this.client.sendClientFrame(frame);
    return true;
  }

  /** Re-drives the attach burst once this machine has a host id to declare. */
  retryLifecycleReady(): void {
    this.sendLifecycleReadyIfReady();
  }

  /**
   * A fresh bearer reached this process.
   *
   * Two things happen, and the second is the one that matters: the live socket
   * is told to push a `credentialUpdate` so the host's request context stops
   * being stale, and a stream that already died on the OLD bearer is started
   * again. Without the restart nothing but a user-clicked Retry would ever
   * reopen the jar plane, because main holds no revalidator to recover the
   * `UNAUTHORIZED` with.
   */
  notifyBearerRotated(): void {
    if (this.disposed) return;
    const userId = this.deps.userId();
    if (userId !== this.openedUserId) {
      // A DIFFERENT account, sign-out included. The jar plane speaks for one
      // account throughout - the store-key wrap, the relay grant and the
      // forget ledger are all priced against `openedUserId` - so pushing the
      // new credential down the open socket would attest B's identity on a
      // connection the host still bills to A. Torn down and, when there is
      // someone to open it for, started again for the new one.
      this.teardown();
      this.openedUserId = null;
      this.terminal = false;
      if (userId === null) return;
      log.info("[browser-sessions] restarting a stream for a new account", {
        hostId: this.hostId,
      });
      this.start();
      return;
    }
    this.transport?.wsStreamClient.notifyBearerRotated();
    // A stream that never attached is retried on the same edge: signed out at
    // open, no directory row yet, a transport that refused. An identity change
    // is the moment all three become worth another try.
    if (!this.terminal && this.transport !== null) return;
    log.info("[browser-sessions] restarting a stream on a rotated bearer", {
      hostId: this.hostId,
    });
    this.teardown();
    this.terminal = false;
    this.start();
  }

  async captureFinalPrimaryProfile(): Promise<void> {
    if (this.connectionStatus !== "open") return;
    const requestId = this.standingCaptureRequestId;
    // No standing id means this host either never authorized the jar plane for
    // this connection or never unsealed the store, so a capture would be
    // refused and dropped there. Sending nothing is the same outcome without
    // the jar read.
    if (requestId === null) return;
    const acked = this.awaitCaptureAck(requestId);
    await this.answerCaptureRequest(requestId);
    await acked;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
  }

  /** Everything `dispose` releases, minus the one-way `disposed` latch. */
  private teardown(): void {
    this.generation += 1;
    this.retireConnection();
    this.resolveCaptureAckWaiters();
    this.forgetLedgerChanges?.dispose();
    this.forgetLedgerChanges = null;
    this.primaryProfileDeltas?.dispose();
    this.primaryProfileDeltas = null;
    this.electronTabs?.dispose();
    this.electronTabs = null;
    this.client?.close();
    this.client = null;
    this.connectionStatus = "connecting";
    this.snapshotReady = false;
    this.lifecycleReadySent = false;
    this.teardownTransport();
  }

  private teardownTransport(): void {
    this.transport?.close();
    this.transport = null;
  }

  private sendClientFrame(frame: BrowserSessionsClientFrame): void {
    if (this.disposed) return;
    this.client?.sendClientFrame(frame);
  }

  private emit(event: BrowserSessionsStreamEventEnvelope["event"]): void {
    if (this.disposed) return;
    this.deps.emit(this.windowId, { key: this.key, event });
  }

  private emitStatus(
    lifecycle: BrowserSessionsLifecycle,
    errorMessage: string | null,
  ): void {
    this.emit({ kind: "status", lifecycle, errorMessage });
  }

  private handleConnectionStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    if (this.disposed) return;
    this.connectionStatus = status;
    if (reason?.kind === "fatalError") {
      this.terminal = true;
      // The row this socket was built from is now suspect - a rotated Noise
      // key and a deregistered host both look like this - and it is frozen
      // into the transport, so the restart has to re-read it.
      this.deps.directory.invalidate(this.hostId);
    }
    if (status === "open") {
      this.connectionId = randomUUID();
      // A new incarnation has been told nothing yet, so it can ack nothing
      // yet either.
      this.sentForgetLedgerRevision = 0;
      this.electronTabs?.connect();
      this.sendLifecycleReadyIfReady();
    } else {
      this.retireConnection();
      this.resolveCaptureAckWaiters();
      this.electronTabs?.disconnect();
      this.lifecycleReadySent = false;
      this.snapshotReady = false;
    }
    this.emitStatus(
      browserSessionsLifecycle(status, reason),
      browserSessionsError(status, reason),
    );
  }

  /**
   * Retires the live incarnation. The id is dropped BEFORE the release, so
   * main is never told a live connection is gone; the sent revision goes with
   * it, because holding it past the close would price the next connection's
   * ack off a digest it never received.
   */
  private retireConnection(): void {
    const closed = this.connectionId;
    this.connectionId = null;
    this.sentForgetLedgerRevision = 0;
    this.standingCaptureRequestId = null;
    if (closed !== null) this.deps.jar.releaseForgetLedgerConnection(closed);
  }

  private handleServerFrame(frame: BrowserSessionsServerFrame): void {
    if (this.disposed) return;
    // Membership in the protocol's exclusion set decides which half of the
    // stream a frame is on, so this dispatch and the UX projection below it
    // cannot drift from the type that separates them.
    if (!isBrowserSessionsJarServerFrame(frame)) {
      this.projectUxFrame(frame);
      return;
    }
    switch (frame.kind) {
      case "createElectronTab":
      case "electronTabAccepted":
      case "releaseElectronTab":
      case "cdpRequest":
        this.electronTabs?.handleFrame(frame);
        return;
      case "capturePrimaryProfile":
        if (frame.standing) {
          this.standingCaptureRequestId = frame.requestId;
          return;
        }
        void this.answerCaptureRequest(frame.requestId);
        return;
      case "primaryProfileCaptureAck":
        this.resolveCaptureAckWaiter(frame.requestId);
        return;
      case "primaryProfileObserved":
        this.applyObservedProfile(frame.domain, frame.cookies);
        return;
      case "storeKeyWrapRequest":
        this.answerStoreKeyWrap(frame.requestId, frame.rawKey);
        return;
      case "storeKeyUnwrapRequest":
        this.answerStoreKeyUnwrap(frame.requestId, frame.wrappedKey);
        return;
      case "desktopIdentityChallenge":
        this.answerIdentityChallenge(frame.requestId, frame.nonce);
        return;
      case "primaryProfileForgetLedgerAck":
        this.handleForgetLedgerAck(frame.revision);
        return;
    }
  }

  /**
   * The one seam a frame crosses to a renderer, and the only place the
   * compile-time invariant has to hold: the parameter is the UX projection, so
   * a jar frame that is not consumed above fails to type here rather than
   * arriving in a renderer heap.
   */
  private projectUxFrame(frame: BrowserSessionsUxServerFrame): void {
    if (frame.kind === "snapshot") {
      this.snapshotReady = true;
      this.emit({ kind: "frame", frame });
      this.sendLifecycleReadyIfReady();
      return;
    }
    this.emit({ kind: "frame", frame });
  }

  private sendLifecycleReadyIfReady(): void {
    const localHostId = this.deps.localHostId();
    if (
      // Wait for the local host id rather than advertising a null locality
      // that can never be elected: readiness is sent once per connection, so
      // a null sent now would stick for the whole connection.
      localHostId === null ||
      this.connectionStatus !== "open" ||
      !this.snapshotReady ||
      this.lifecycleReadySent
    ) {
      return;
    }
    this.lifecycleReadySent = true;
    // ONE synchronous burst, and the order in it is the attach ordering
    // guarantee. `electronTabLifecycleReady` is what makes the host CHALLENGE
    // this stream for a desktop identity; the ledger digest rides immediately
    // behind it on the same ordered stream, and the store-key
    // handshake begins a full attestation round trip after that - so the
    // digest is always RECEIVED before the handshake completes, and therefore
    // before the attach replay it must precede.
    //
    // The digest is now a LOCAL read in this process rather than a cached IPC
    // result, so the burst stays synchronous with nothing deferred: the cache
    // and its deferred-push machinery went away with the process boundary.
    this.sendClientFrame({
      kind: "electronTabLifecycleReady",
      hasBinaryPayload: false,
      coLocatedHostId: localHostId,
    });
    this.pushForgetLedger("attach");
  }

  /**
   * One digest onto the wire, plus the only trace this path writes.
   *
   * Traced at INFO because it is once per attach and once per forget, and
   * because this epic's bugs are found by forensics: "which revision did this
   * host last hear about" is the first question a resurrection asks. Counts
   * and the revision only - never a domain, which would put the user's sites
   * in a log that gets pasted into support threads.
   */
  private pushForgetLedger(stage: "attach" | "forget"): void {
    if (this.connectionStatus !== "open" || !this.lifecycleReadySent) return;
    const ledger = this.deps.jar.readForgetLedger(this.hostId);
    this.sendClientFrame({
      kind: "primaryProfileForgetLedger",
      hasBinaryPayload: false,
      ...ledger,
    });
    // AFTER the send, and only the digests that left: this is the fact an ack
    // is measured against, so it must not record one the wire never carried.
    this.sentForgetLedgerRevision = Math.max(
      this.sentForgetLedgerRevision,
      ledger.revision,
    );
    log.info("[browser-sessions] pushed the forget ledger", {
      hostId: this.hostId,
      stage,
      revision: ledger.revision,
      domains: ledger.domains.length,
      forgetAll: ledger.forgetAllAt !== null,
    });
  }

  /**
   * One host confirming it finished pruning this machine's ledger through a
   * revision. Both identities it needs are this connection's - the frame names
   * neither, and a frame field could only be forged.
   */
  private handleForgetLedgerAck(revision: number): void {
    const connectionId = this.connectionId;
    if (connectionId === null) return;
    log.info("[browser-sessions] host acked the forget ledger", {
      hostId: this.hostId,
      revision,
      sent: this.sentForgetLedgerRevision,
    });
    void this.deps.jar
      .recordForgetLedgerAck({
        hostId: this.hostId,
        connectionId,
        revision,
        // What this connection was told, which is all its ack can be worth.
        // The clamp itself happens in the ledger, where the connection gate
        // and the durable watermark are both set from one value.
        sentRevision: this.sentForgetLedgerRevision,
      })
      .catch((cause: unknown) => {
        log.warn("[browser-sessions] could not record a forget-ledger ack", {
          hostId: this.hostId,
          error: describeLogError(cause),
        });
      });
  }

  /**
   * The one code path that answers "what is in the primary profile right now".
   * Both callers use it: a host-issued `capturePrimaryProfile`, and the final
   * capture before a desktop route disappears. It always sends exactly one
   * `primaryProfileCaptured` and never rejects.
   */
  private async answerCaptureRequest(requestId: string): Promise<void> {
    try {
      const result = await this.deps.jar.capturePrimaryProfile();
      this.sendClientFrame(
        result.status === "captured"
          ? {
              kind: "primaryProfileCaptured",
              hasBinaryPayload: false,
              requestId,
              storageState: result.storageState,
              status: "captured",
              reason: null,
            }
          : {
              kind: "primaryProfileCaptured",
              hasBinaryPayload: false,
              requestId,
              storageState: null,
              status: "unavailable",
              reason: result.reason,
            },
      );
    } catch (error: unknown) {
      this.sendClientFrame({
        kind: "primaryProfileCaptured",
        hasBinaryPayload: false,
        requestId,
        storageState: null,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private awaitCaptureAck(requestId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.connectionStatus !== "open") {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.captureAckWaiters.delete(requestId);
        resolve();
      }, FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);
      this.captureAckWaiters.set(requestId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private resolveCaptureAckWaiter(requestId: string): void {
    const settle = this.captureAckWaiters.get(requestId);
    if (settle === undefined) return;
    this.captureAckWaiters.delete(requestId);
    settle();
  }

  private resolveCaptureAckWaiters(): void {
    for (const settle of [...this.captureAckWaiters.values()]) settle();
    this.captureAckWaiters.clear();
  }

  /**
   * A sign-in one of the user's hosts witnessed inside a headless session,
   * offered to this machine's master jar.
   *
   * PROVENANCE is the connection's, never the frame's: the frame names no
   * contributor precisely because one could only be forged. A stream that has
   * closed under the frame has nowhere to put the observation.
   *
   * Nothing here re-checks that the sending host was allowed to write this
   * jar - that authorization is a server-side fact decided from stream facts
   * no client declares. What the applier owns is the CONTENT: domain
   * re-derivation, the expired-cookie rejection, the ownership rule, the
   * clear-in-progress gate and the rate limit.
   */
  private applyObservedProfile(
    domain: string,
    cookies: BrowserSessionsObservedCookies,
  ): void {
    const connectionId = this.connectionId;
    if (connectionId === null) return;
    if (cookies.length > BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES) {
      log.warn("[browser-sessions] dropped an over-bound observed sign-in", {
        hostId: this.hostId,
        cookies: cookies.length,
      });
      return;
    }
    void this.deps.jar
      .applyObservedProfile({
        connectionId,
        hostId: this.hostId,
        domain,
        cookies,
      })
      .catch((cause: unknown) => {
        log.warn("[browser-sessions] could not apply an observed sign-in", {
          hostId: this.hostId,
          error: describeLogError(cause),
        });
      });
  }

  /**
   * The desktop half of the store-key handshake. A failed wrap has no negative
   * frame by design: nothing durable was created, and the host re-asks on the
   * next connect. A failed unwrap IS answered, so the host knows to stay
   * sealed rather than re-minting.
   */
  private answerStoreKeyWrap(requestId: string, rawKey: string): void {
    const userId = this.openedUserId;
    if (userId === null) return;
    const wrappedKey = this.deps.jar.wrapStoreKey(rawKey, userId, this.hostId);
    if (wrappedKey === null) {
      log.warn("[browser-sessions] the store-key wrap failed", {
        hostId: this.hostId,
      });
      return;
    }
    this.sendClientFrame({
      kind: "storeKeyWrapped",
      hasBinaryPayload: false,
      requestId,
      wrappedKey,
    });
  }

  private answerStoreKeyUnwrap(requestId: string, wrappedKey: string): void {
    const userId = this.openedUserId;
    const rawKey =
      userId === null ? null : this.deps.jar.unwrapStoreKey(wrappedKey, userId);
    if (rawKey === null) {
      log.warn("[browser-sessions] the store-key unwrap failed", {
        hostId: this.hostId,
      });
    }
    this.sendClientFrame({
      kind: "storeKeyUnwrapped",
      hasBinaryPayload: false,
      requestId,
      rawKey,
    });
  }

  /**
   * One host challenge, signed HERE: the prover and the jar-plane speaker are
   * now the same process, so the signature never crosses an IPC boundary and
   * there is no attest channel for a renderer to reach. A `null` answer -
   * this machine could not mint or open its key at all - is simply not sent:
   * the host leaves the connection off the jar plane and every other part of
   * the session keeps working.
   *
   * A machine whose keystore does not encrypt DOES attest now, with
   * `jarEligible: false`, so it can be given native tabs while the host keeps
   * the encrypted slice to itself.
   */
  private answerIdentityChallenge(requestId: string, nonce: string): void {
    void this.deps.jar
      .attestDesktopIdentity({ hostId: this.hostId, nonce })
      .then((attestation) => {
        if (attestation === null) {
          log.warn(
            "[browser-sessions] this machine holds no browser identity; the host stays sealed",
            { hostId: this.hostId },
          );
          return;
        }
        this.sendClientFrame({
          kind: "desktopIdentityAttest",
          hasBinaryPayload: false,
          requestId,
          publicKey: attestation.publicKey,
          keystoreId: attestation.keystoreId,
          signature: attestation.signature,
          jarEligible: attestation.jarEligible,
        });
      })
      .catch((cause: unknown) => {
        log.warn("[browser-sessions] the desktop identity attestation failed", {
          hostId: this.hostId,
          error: describeLogError(cause),
        });
      });
  }
}
