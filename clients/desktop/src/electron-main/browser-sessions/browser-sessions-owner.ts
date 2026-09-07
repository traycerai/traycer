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
 * Bound on one final capture at a window's close or at quit, end to end: the wait for a whole-jar barrier to release, the jar read, and the round trip that proves the frame reached.
 * A liveness escape from a host that never acks, not an ordering device: the quit path is already bounded by the shell's own budget, and this only has to be shorter so a lost socket.
 */
export const FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS = 5_000;

/** A settle in the same turn as the timer cannot be mistaken: the value's continuation is a microtask, the timer a macrotask after it. */
function settledWithin<T, F>(
  promise: Promise<T>,
  waitMs: number,
  fallback: F,
): Promise<T | F> {
  return new Promise<T | F>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, waitMs);
    timer.unref();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export type BrowserPrimaryProfileCaptureOutcome =
  | "acked"
  | "unacked"
  | "sent-no-jar"
  | "not-sent";

interface CaptureAckSlot {
  settle: ((acked: boolean) => void) | null;
}

const MAX_STREAMS_PER_WINDOW = 12;

type CaptureOrdering = "now" | { readonly behindBarrierFor: number | null };

export interface BrowserSessionsJarPort {
  capturePrimaryProfile(): Promise<BrowserPrimaryProfileCaptureResult>;
  capturePrimaryProfileBehindBarrier(
    waitMs: number | null,
  ): Promise<BrowserPrimaryProfileCaptureResult | null>;
  applyObservedProfile(input: {
    readonly connectionId: string;
    readonly hostId: string;
    readonly domain: string;
    readonly cookies: BrowserSessionsObservedCookies;
  }): Promise<void>;
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
  readonly userId: () => string | null;
  /** THIS machine's host id, or null while none is published. */
  readonly localHostId: () => string | null;
  /**
   * Readiness is sent once per connection and only once a local host id exists, because a null locality can never be elected and would stick for the whole connection.
   * A host that starts AFTER the stream opened is ordinary - the desktop launches its host beside itself.
   */
  readonly subscribeLocalHostChange: (listener: () => void) => () => void;
  /** Main opens its streams with `auth: null` (the app-wide revalidator lives in the renderer and must stay single-flight), so nothing here can RECOVER an `UNAUTHORIZED`. */
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

/** One renderer stream became one main stream; nothing was added. */
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
      // A stream that never opened for an identity holds no socket, no attestation and no replay - the cap exists to bound those.
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

  closeWindow(windowId: string): void {
    for (const [id, stream] of [...this.streams]) {
      if (stream.windowId !== windowId) continue;
      this.streams.delete(id);
      stream.dispose();
    }
  }

  retainWindows(liveWindowIds: ReadonlySet<string>): void {
    for (const [id, stream] of [...this.streams]) {
      if (liveWindowIds.has(stream.windowId)) continue;
      this.streams.delete(id);
      stream.dispose();
    }
  }

  /** Never rejects: a stream that cannot answer is reported by not having refreshed the store, not by stalling the quit. */
  async captureFinalPrimaryProfiles(windowId: string | null): Promise<void> {
    const targets = [...this.streams.values()].filter(
      (stream) => windowId === null || stream.windowId === windowId,
    );
    await Promise.allSettled(
      targets.map((stream) => stream.captureFinalPrimaryProfile()),
    );
  }

  forgetLoginsOnEveryHost(): number {
    return this.sendOncePerHost({
      kind: "forgetLogins",
      hasBinaryPayload: false,
    });
  }

  /** Never rejects: a host that cannot take the jar is reported by not being counted. */
  async capturePrimaryProfileOnEveryHost(): Promise<number> {
    const streamsByHost = new Map<string, BrowserSessionsStream[]>();
    for (const stream of this.streams.values()) {
      const forHost = streamsByHost.get(stream.hostId);
      if (forHost === undefined) streamsByHost.set(stream.hostId, [stream]);
      else forHost.push(stream);
    }
    const captured = await Promise.all(
      [...streamsByHost.values()].map(async (streams) => {
        for (const stream of streams) {
          const outcome = await stream.capturePrimaryProfileNow();
          if (outcome !== "not-sent") return outcome === "acked";
        }
        return false;
      }),
    );
    return captured.filter((acked) => acked).length;
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
  private generation = 0;
  private terminal = false;
  private connectionStatus: StreamConnectionStatus = "connecting";
  private snapshotReady = false;
  private lifecycleReadySent = false;
  private connectionId: string | null = null;
  private sentForgetLedgerRevision = 0;
  private standingCaptureRequestId: string | null = null;
  /** The one capture running on this stream; see `capturePrimaryProfileNow`. */
  private captureInFlight: Promise<BrowserPrimaryProfileCaptureOutcome> | null =
    null;
  /** The one capture queued behind it, shared by everyone who arrived meanwhile. */
  private trailingCapture: Promise<BrowserPrimaryProfileCaptureOutcome> | null =
    null;
  /** `null` only before the first attach. */
  private openedUserId: string | null = null;

  get holdsConnection(): boolean {
    return this.openedUserId !== null;
  }
  /** A slot whose budget ran out is SETTLED, not removed: its frame left, so its ack is still owed, and it must land on this slot rather than on the next frame's. */
  private readonly captureAckSlots = new Map<string, CaptureAckSlot[]>();

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
      // Deliberately not a failure - nothing was reported to the renderer to retry.
      return;
    }
    this.openedUserId = userId;
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

  /** A stream that never reached a socket. */
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
      this.teardown();
      this.emitStatus("failed", "Browser sessions stream could not open.");
    }
  }

  sendUxFrame(frame: BrowserSessionsUxClientFrame): void {
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

  /** Answers whether it went, so the caller can report how many hosts were told; a stream that is not open took nothing. */
  sendJarActionFrame(frame: BrowserSessionsClientFrame): boolean {
    if (this.connectionStatus !== "open" || this.client === null) return false;
    this.client.sendClientFrame(frame);
    return true;
  }

  /** Re-drives the attach burst once this machine has a host id to declare. */
  retryLifecycleReady(): void {
    this.sendLifecycleReadyIfReady();
  }

  notifyBearerRotated(): void {
    if (this.disposed) return;
    const userId = this.deps.userId();
    if (userId !== this.openedUserId) {
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
    await this.capturePrimaryProfileOnce({
      behindBarrierFor: FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS,
    });
  }

  /**
   * The registry's once-per-host rule needs the last told apart from the rest: a frame that left is the host's one capture even if the ack never came or the frame was empty-handed.
   * Captures on one stream run ONE AT A TIME, and a caller that arrives while one is in flight gets the NEXT one, never the current one: the one in flight may have read the jar before.
   */
  capturePrimaryProfileNow(): Promise<BrowserPrimaryProfileCaptureOutcome> {
    if (this.captureInFlight === null) return this.startCapture();
    if (this.trailingCapture === null) {
      this.trailingCapture = this.captureInFlight.then(() => {
        this.trailingCapture = null;
        // Through the public path, not `startCapture`: a caller that arrived in the microtask between the in-flight capture settling and this continuation may already have started the next.
        return this.capturePrimaryProfileNow();
      });
    }
    return this.trailingCapture;
  }

  private startCapture(): Promise<BrowserPrimaryProfileCaptureOutcome> {
    const capture = this.capturePrimaryProfileOnce("now").finally(() => {
      this.captureInFlight = null;
    });
    this.captureInFlight = capture;
    return capture;
  }

  private async capturePrimaryProfileOnce(
    ordering: CaptureOrdering,
  ): Promise<BrowserPrimaryProfileCaptureOutcome> {
    // Window close and quit await this method directly, so a barrier that releases at the end of the wait must not buy the read a fresh run or the ack a fresh budget on top.
    // The read cannot be cancelled - it holds the serializer's lease until it settles.
    const deadline =
      ordering === "now" || ordering.behindBarrierFor === null
        ? null
        : Date.now() + ordering.behindBarrierFor;
    const remainingMs = (): number =>
      deadline === null
        ? FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS
        : Math.max(0, deadline - Date.now());
    const expired = (): boolean => deadline !== null && Date.now() >= deadline;
    if (this.connectionStatus !== "open") return "not-sent";
    const requestId = this.standingCaptureRequestId;
    // No standing id means this host either never authorized the jar plane for this connection or never unsealed the store, so a capture would be refused and dropped there.
    if (requestId === null) return "not-sent";
    // A frame that could not be sent, or that would quote an id the host no longer holds, never LEFT: the registry must be free to try this host's healthy sibling stream, which.
    const answer = this.answerCaptureRequest(
      requestId,
      () => this.standingCaptureRequestId === requestId && !expired(),
      ordering,
    );
    const sent =
      deadline === null
        ? await answer
        : await settledWithin(answer, remainingMs(), "not-sent");
    if (sent === "not-sent") return "not-sent";
    // The ack waiter - and its timeout - start once the frame has LEFT, not before the jar read.
    // Awaited for a frame that carried no jar too.
    const acked = await this.awaitCaptureAck(requestId, remainingMs());
    if (sent === "sent-no-jar") return "sent-no-jar";
    return acked ? "acked" : "unacked";
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

  /** The client drops a frame silently unless its stream is open, and a caller that counts what a host took - the whole-jar capture - must not mistake a drop for a send. */
  private sendClientFrameIfOpen(frame: BrowserSessionsClientFrame): boolean {
    if (this.disposed || this.connectionStatus !== "open") return false;
    if (this.client === null) return false;
    this.client.sendClientFrame(frame);
    return true;
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

  /** The id is dropped BEFORE the release, so main is never told a live connection is gone. */
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
        // A one-off request the host is waiting on: answered whatever the
        // standing id does meanwhile - and behind any whole-jar barrier, so
        // the host is never handed a jar mid-import.
        void this.answerCaptureRequest(frame.requestId, () => true, {
          behindBarrierFor: null,
        });
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
    this.sendClientFrame({
      kind: "electronTabLifecycleReady",
      hasBinaryPayload: false,
      coLocatedHostId: localHostId,
    });
    this.pushForgetLedger("attach");
  }

  /** Counts and the revision only - never a domain, which would put the user's sites in a log that gets pasted into support threads. */
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
   * It always sends exactly one `primaryProfileCaptured` and never rejects.
   * A frame that left with no jar - the read failed, or the jar was unavailable.
   */
  private async answerCaptureRequest(
    requestId: string,
    stillWanted: () => boolean,
    ordering: CaptureOrdering,
  ): Promise<"not-sent" | "sent" | "sent-no-jar"> {
    let frame: BrowserSessionsClientFrame;
    let carriesJar = false;
    try {
      const result =
        ordering === "now"
          ? await this.deps.jar.capturePrimaryProfile()
          : await this.deps.jar.capturePrimaryProfileBehindBarrier(
              ordering.behindBarrierFor,
            );
      // The barrier held past the budget: no jar was read, so there is no
      // frame to send - a frame saying "unavailable" would have the host
      // treat a jar it will be pushed in a moment as gone.
      if (result === null) return "not-sent";
      carriesJar = result.status === "captured";
      frame =
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
            };
    } catch (error: unknown) {
      // The cause stays in this process's log: a jar read's error can carry
      // a filesystem path or an OS error string, and the frame travels to a
      // host that may log it. The host gets a closed reason.
      log.warn("[browser-sessions] primary profile capture failed", {
        error: describeLogError(error),
      });
      frame = {
        kind: "primaryProfileCaptured",
        hasBinaryPayload: false,
        requestId,
        storageState: null,
        status: "failed",
        reason: "capture-failed",
      };
    }
    if (!stillWanted()) return "not-sent";
    if (!this.sendClientFrameIfOpen(frame)) return "not-sent";
    return carriesJar ? "sent" : "sent-no-jar";
  }

  /**
   * A timeout, a connection that is not open, and a teardown all resolve `false`, so a caller counting what a host took cannot count a capture that merely left.
   * `timeoutMs` is what remains of the caller's budget.
   */
  private awaitCaptureAck(
    requestId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.connectionStatus !== "open") {
        resolve(false);
        return;
      }
      const slot: CaptureAckSlot = { settle: null };
      const timer = setTimeout(() => {
        // Settled in place, still queued: see `captureAckSlots`.
        slot.settle = null;
        resolve(false);
      }, timeoutMs);
      slot.settle = (acked) => {
        clearTimeout(timer);
        slot.settle = null;
        resolve(acked);
      };
      const queue = this.captureAckSlots.get(requestId) ?? [];
      queue.push(slot);
      this.captureAckSlots.set(requestId, queue);
    });
  }

  /** One ack absorbs the oldest slot under its id, live or already timed out. */
  private resolveCaptureAckWaiter(requestId: string): void {
    const queue = this.captureAckSlots.get(requestId);
    if (queue === undefined) return;
    const slot = queue.shift();
    if (queue.length === 0) this.captureAckSlots.delete(requestId);
    if (slot !== undefined && slot.settle !== null) slot.settle(true);
  }

  private resolveCaptureAckWaiters(): void {
    const queues = [...this.captureAckSlots.values()];
    this.captureAckSlots.clear();
    for (const queue of queues) {
      for (const slot of queue) {
        if (slot.settle !== null) slot.settle(false);
      }
    }
  }

  /** PROVENANCE is the connection's, never the frame's: the frame names no contributor precisely because one could only be forged. */
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
