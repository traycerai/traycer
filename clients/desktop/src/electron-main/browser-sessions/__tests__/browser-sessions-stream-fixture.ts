import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  BrowserForgetLedger,
  BrowserPrimaryProfileDelta,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserSessionsStreamEventEnvelope,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabStatusChange,
} from "@traycer-clients/shared/platform/browser-view";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { BrowserSessionsTabPort } from "../browser-sessions-electron-tabs";
import type {
  BrowserSessionsJarPort,
  BrowserSessionsRegistryDeps,
} from "../browser-sessions-owner";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { BrowserSessionsHostTransport } from "../browser-sessions-transport";
import type { BrowserViewEnsureTab } from "../../browser-view/browser-view-port";

type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * One `browser.sessions` subscription, driven from a test.
 *
 * The REAL `BrowserSessionsStreamClient` sits on top of this, so every frame a
 * test emits is parsed against the protocol schema before main sees it, and
 * every frame main sends is the envelope that would have gone on the wire.
 */
export class FakeStreamSession implements IStreamSession {
  readonly sentFrames: StreamFrameEnvelope[] = [];
  closed = false;
  private serverHandler: ServerFrameHandler | null = null;
  private statusHandler: StatusChangeHandler | null = null;
  private status: StreamStatus = "connecting";

  sendClientFrame(
    frame: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    if (this.closed || this.status !== "open") return;
    this.sentFrames.push(frame);
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusHandler = handler;
  }

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {
    this.closed = true;
  }

  emitStatus(status: StreamStatus): void {
    this.status = status;
    this.statusHandler?.(status, null);
  }

  /** The terminal close a host's bearer-expiry disconnect produces. */
  emitFatal(reason: string): void {
    this.status = "closed";
    this.statusHandler?.("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason,
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
  }

  emit(frame: BrowserSessionsServerFrame): void {
    this.serverHandler?.({ ...frame }, null);
  }

  framesOfKind(kind: string): readonly StreamFrameEnvelope[] {
    return this.sentFrames.filter((frame) => frame.kind === kind);
  }
}

/**
 * A stream client that answers `subscribe` with a drivable session and
 * declines every other capability. Implemented in full rather than cast into
 * place: the owner is typed against the real transport seam, and a fake that
 * has to lie about its shape is a fake that can drift from it.
 */
export class FakeStreamClient implements IHostStreamClient<HostStreamRpcRegistry> {
  readonly instanceId = "fake-stream-client";
  readonly sessions: FakeStreamSession[] = [];
  readonly subscribes: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];
  private closed = false;

  subscribe(method: string, params: unknown): FakeStreamSession {
    const session = new FakeStreamSession();
    this.sessions.push(session);
    this.subscribes.push({ method, params });
    return session;
  }

  subscribeWithParamsProvider(
    method: string,
    paramsProvider: () => unknown,
  ): FakeStreamSession {
    return this.subscribe(method, paramsProvider());
  }

  getMethodSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  getClosedReason(): string | null {
    return null;
  }

  onClosed(): () => void {
    return () => undefined;
  }

  /**
   * Models what `WsStreamClient` does with a rotated bearer: push a
   * `credentialUpdate` onto every open session, so an already-connected host
   * stops holding a stale request context.
   */
  notifyBearerRotated(): void {
    for (const session of this.sessions) {
      session.sendClientFrame(
        { kind: "credentialUpdate", hasBinaryPayload: false },
        null,
      );
    }
  }

  reconnectAll(): void {}

  isReady(): boolean {
    return true;
  }

  getMethodSupport(): "unknown" {
    return "unknown";
  }

  subscribeMethodSupport(): () => void {
    return () => undefined;
  }

  subscribeAvailabilityRecovered(): () => void {
    return () => undefined;
  }
}

export interface JarRecorder {
  readonly observed: Array<{
    readonly connectionId: string;
    readonly hostId: string;
    readonly domain: string;
    readonly cookieNames: readonly string[];
  }>;
  readonly acks: Array<{
    readonly hostId: string;
    readonly connectionId: string;
    readonly revision: number;
    readonly sentRevision: number;
  }>;
  readonly releasedConnectionIds: string[];
  readonly wrapped: string[];
  readonly unwrapped: string[];
  readonly attested: Array<{ readonly hostId: string; readonly nonce: string }>;
  captures: number;
  ledger: BrowserForgetLedger;
  emitLedgerChange: () => void;
  emitDelta: (delta: BrowserPrimaryProfileDelta) => void;
  readonly port: BrowserSessionsJarPort;
}

export function createJarRecorder(): JarRecorder {
  const ledgerListeners = new Set<() => void>();
  const deltaListeners = new Set<(delta: BrowserPrimaryProfileDelta) => void>();
  const recorder: JarRecorder = {
    observed: [],
    acks: [],
    releasedConnectionIds: [],
    wrapped: [],
    unwrapped: [],
    attested: [],
    captures: 0,
    ledger: { forgetAllAt: null, domains: [], revision: 0 },
    emitLedgerChange: () => {
      for (const listener of ledgerListeners) listener();
    },
    emitDelta: (delta) => {
      for (const listener of deltaListeners) listener(delta);
    },
    port: {
      capturePrimaryProfile: () => {
        recorder.captures += 1;
        return Promise.resolve({
          status: "captured",
          storageState: { cookies: [], origins: [] },
          reason: null,
        });
      },
      applyObservedProfile: (input) => {
        recorder.observed.push({
          connectionId: input.connectionId,
          hostId: input.hostId,
          domain: input.domain,
          cookieNames: input.cookies.map((cookie) => cookie.name),
        });
        return Promise.resolve();
      },
      wrapStoreKey: (rawKey, userId) => {
        recorder.wrapped.push(`${userId}:${rawKey}`);
        return "d3JhcHBlZA==";
      },
      unwrapStoreKey: (wrappedKey, userId) => {
        recorder.unwrapped.push(`${userId}:${wrappedKey}`);
        return "cmF3";
      },
      attestDesktopIdentity: (input) => {
        recorder.attested.push(input);
        return Promise.resolve({
          publicKey: "cHVibGlj",
          keystoreId: "keystore-1",
          signature: "c2ln",
        });
      },
      readForgetLedger: () => recorder.ledger,
      recordForgetLedgerAck: (ack) => {
        recorder.acks.push(ack);
        return Promise.resolve();
      },
      releaseForgetLedgerConnection: (connectionId) => {
        recorder.releasedConnectionIds.push(connectionId);
      },
      onForgetLedgerChanged: (listener) => {
        ledgerListeners.add(listener);
        return {
          dispose: () => {
            ledgerListeners.delete(listener);
          },
        };
      },
      onPrimaryProfileDelta: (listener) => {
        deltaListeners.add(listener);
        return {
          dispose: () => {
            deltaListeners.delete(listener);
          },
        };
      },
    },
  };
  return recorder;
}

export interface TabRecorder {
  readonly ensured: Array<{
    readonly windowId: string;
    readonly input: BrowserViewEnsureTab;
  }>;
  readonly accepted: BrowserViewNativeTabCapability[];
  readonly released: BrowserViewNativeTabCapability[];
  readonly cdp: Array<{ readonly tabId: string }>;
  emitStatus: (change: BrowserViewNativeTabStatusChange) => void;
  readonly port: BrowserSessionsTabPort;
}

export function createTabRecorder(): TabRecorder {
  const statusListeners = new Set<
    (change: BrowserViewNativeTabStatusChange) => void
  >();
  const recorder: TabRecorder = {
    ensured: [],
    accepted: [],
    released: [],
    cdp: [],
    emitStatus: (change) => {
      for (const listener of statusListeners) listener(change);
    },
    port: {
      ensureTab: (windowId, input) => {
        recorder.ensured.push({ windowId, input });
        return Promise.resolve({
          hostId: input.hostId,
          sessionId: input.sessionId,
          tabId: input.tabId,
          registrationId: `registration-${recorder.ensured.length}`,
        });
      },
      acceptTab: (input) => {
        recorder.accepted.push(input);
        return Promise.resolve();
      },
      releaseTab: (input) => {
        recorder.released.push(input);
        return Promise.resolve(true);
      },
      dispatchElectronTabCdp: (input) => {
        recorder.cdp.push({ tabId: input.tabId });
        return Promise.resolve({
          kind: "cdpNavigate",
          ok: true,
          errorText: null,
        });
      },
      onNativeTabStatusChange: (listener) => {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
    },
  };
  return recorder;
}

export const LOCAL_HOST_ENTRY: HostDirectoryEntry = {
  hostId: "host-1",
  label: "host-1",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:1234",
  version: "1.0.0",
  transportDialability: "dialable",
};

export interface RegistryHarness {
  readonly deps: BrowserSessionsRegistryDeps;
  rotateBearer: () => void;
  /** This machine's host id, as main reads it; null before a host publishes. */
  localHostId: string | null;
  /** The signed-in user main reads for itself; null while signed out. */
  userId: string | null;
  publishLocalHost: (hostId: string) => void;
  readonly jar: JarRecorder;
  readonly tabs: TabRecorder;
  readonly clients: FakeStreamClient[];
  readonly emitted: Array<{
    readonly windowId: string;
    readonly envelope: BrowserSessionsStreamEventEnvelope;
  }>;
  readonly closedTransports: number[];
  /** Host ids whose cached directory row the stream threw away. */
  readonly invalidated: readonly string[];
}

export function createRegistryHarness(): RegistryHarness {
  const jar = createJarRecorder();
  const tabs = createTabRecorder();
  const clients: FakeStreamClient[] = [];
  const emitted: RegistryHarness["emitted"] = [];
  const closedTransports: number[] = [];
  const openTransport = (): BrowserSessionsHostTransport => {
    const client = new FakeStreamClient();
    const index = clients.push(client) - 1;
    return {
      wsStreamClient: client,
      close: () => {
        closedTransports.push(index);
      },
    };
  };
  const localHostListeners = new Set<() => void>();
  const bearerListeners = new Set<() => void>();
  const invalidated: string[] = [];
  const harness: RegistryHarness = {
    jar,
    tabs,
    clients,
    emitted,
    closedTransports,
    invalidated,
    localHostId: "host-1",
    userId: "user-1",
    rotateBearer: () => {
      for (const listener of bearerListeners) listener();
    },
    publishLocalHost: (hostId) => {
      harness.localHostId = hostId;
      for (const listener of localHostListeners) listener();
    },
    deps: {
      directory: {
        invalidate: (hostId) => {
          invalidated.push(hostId);
        },
        resolve: () => Promise.resolve(LOCAL_HOST_ENTRY),
        endpoint: () => ({
          hostId: LOCAL_HOST_ENTRY.hostId,
          websocketUrl: LOCAL_HOST_ENTRY.websocketUrl,
        }),
      },
      openTransport,
      jar: jar.port,
      tabs: tabs.port,
      userId: () => harness.userId,
      localHostId: () => harness.localHostId,
      subscribeLocalHostChange: (listener) => {
        localHostListeners.add(listener);
        return () => {
          localHostListeners.delete(listener);
        };
      },
      subscribeBearerRotation: (listener) => {
        bearerListeners.add(listener);
        return () => {
          bearerListeners.delete(listener);
        };
      },
      emit: (windowId, envelope) => {
        emitted.push({ windowId, envelope });
      },
    },
  };
  return harness;
}
