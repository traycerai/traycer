/**
 * The browser shell's resume edge, driven end to end into the transport it is
 * published for: `WebRunnerHost.onSystemResumed` -> `subscribeWakeSignals` ->
 * `IHostStreamClient.reconnectAll({ probeFirst: true })` -> a real socket.
 *
 * Nothing here re-tests the probe itself; it re-tests the CHAIN, because the
 * two halves are only safe together. Raw visibility as a wake trigger was
 * rejected outright for a blind re-dial - it fires on every alt-tab, and
 * dropping healthy sockets once per hide/show is worse than the recovery it
 * buys. What makes it publishable is that the path it feeds probes first and
 * re-dials only what fails to answer. So both arms are asserted from the shell
 * edge, against real timings:
 *
 * - a socket that ANSWERS the probe is left completely alone (the alt-tab
 *   regression case);
 * - a socket that does NOT answer is torn down and reattached inside the
 *   budget a person waiting on a revived tab will accept.
 *
 * A tab the browser froze or discarded is the case with no other rescue: its
 * sockets are dead and its timers were stopped, the network never moved, so
 * `window 'online'` cannot fire and the heartbeat's own pong timeout is the
 * only other detector - a minute of a stream that looks alive and is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "@traycer-clients/shared/host-transport/ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "@traycer-clients/shared/host-transport/ws-stream-factory";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  resetRemoteResumeSweepForTest,
  subscribeStreamWakeReconnect,
} from "@/lib/host/stream-wake-reconnect";
import type {
  WebCredentialStorage,
  WebLockManager,
} from "@traycer-clients/webapp/web-token-store";
import { WebRunnerHost } from "@traycer-clients/webapp/web-runner-host";

/**
 * The app-wide stream client's own timings, mirrored (see the client built in
 * gui-app's `use-host-stream-client-for`). The reattach budget below is only
 * meaningful measured against what ships: shrinking the backoff to make a test
 * quick would turn the budget assertion into a statement about the test.
 */
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const DIAL_TIMEOUT_MS = 10_000;
const OPEN_ACK_TIMEOUT_MS = 10_000;

/**
 * What a person who just revived a frozen tab will wait for their streams to
 * be carrying frames again. An EXTERNAL anchor, deliberately not derived from
 * the probe timeout or the backoff ladder - a budget computed from the
 * implementation's own constants agrees with whatever those constants become.
 */
const REATTACH_BUDGET_MS = 15_000;

/** Timer granularity for walking the clock up to the budget. */
const STEP_MS = 250;

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }

  /** Whether a wake liveness probe went out on this socket. */
  sawPing(): boolean {
    return this.textSent.some((raw) => raw.includes('"kind":"ping"'));
  }
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: StubStreamWebSocket[];
} {
  const sockets: StubStreamWebSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create(url: string): StreamWebSocketLike {
      void url;
      const socket = new StubStreamWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
  return { factory, sockets };
}

function makeRequestContext(): RequestContext {
  return createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: "bearer-token",
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

function makeClient(
  factory: IStreamWebSocketFactory,
): WsStreamClient<HostStreamRpcRegistry> {
  const ctx = makeRequestContext();
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx.credentials,
    auth: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: DIAL_TIMEOUT_MS,
    openAckTimeoutMs: OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: PONG_TIMEOUT_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
  });
}

/**
 * Fires open, echoes the client's own manifest back as the `openAck`, and
 * leaves the session subscribed - the point from which a socket can be alive,
 * half-open, or gone.
 */
function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const open = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({ kind: "openAck", manifest: open.manifest });
}

function inMemoryStorage(): WebCredentialStorage {
  const values = new Map<string, string>();
  return {
    read: (key) => values.get(key) ?? null,
    write: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    onExternalChange: (key, handler) => {
      void key;
      void handler;
    },
  };
}

const passthroughLocks: WebLockManager = {
  runExclusive: (name, task) => {
    void name;
    return task();
  },
};

function webShell(): WebRunnerHost {
  return new WebRunnerHost({
    signInUrl: "https://platform.test/sign-in",
    authnBaseUrl: "https://authn.test",
    hostLabel: "Traycer Web",
    relayBaseUrl: "wss://relay.test/attach",
    credentialStorage: inMemoryStorage(),
    locks: passthroughLocks,
  });
}

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  // The sweep's install flag is module-level and would otherwise survive from
  // whichever test subscribed first.
  resetRemoteResumeSweepForTest();
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  vi.useRealTimers();
});

/**
 * Brings a shell, a client and one subscribed session up on real timers (the
 * handshake needs them), then hands back a fake-timer clock for the wake
 * window. Everything the assertions read is returned, so no case reaches for
 * transport internals.
 */
async function mountedShellStream(): Promise<{
  readonly sockets: readonly StubStreamWebSocket[];
  readonly statuses: readonly StreamConnectionStatus[];
  readonly dispose: () => void;
}> {
  const { factory, sockets } = makeFactory();
  const client = makeClient(factory);
  const host = webShell();
  const disposeWake = subscribeStreamWakeReconnect(client, host);
  const statuses: StreamConnectionStatus[] = [];
  const session = client.subscribe("epic.subscribe", { epicId: "e1" });
  session.onStatusChange((status) => statuses.push(status));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  completeHandshake(sockets[0]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(sockets).toHaveLength(1);
  expect(statuses).toContain("open");
  return {
    sockets,
    statuses,
    dispose: () => {
      session.close();
      disposeWake();
      client.close("test-teardown");
    },
  };
}

describe("browser tab resume drives the probe-first wake path", () => {
  it("leaves a socket that answers the probe completely alone", async () => {
    const { sockets, dispose } = await mountedShellStream();

    vi.useFakeTimers();
    try {
      setVisibility("hidden");
      setVisibility("visible");

      // The resume episode reached the transport as a real ping on the wire,
      // so what follows is the PROBE's verdict and not a path that skipped it.
      expect(sockets[0].sawPing()).toBe(true);
      sockets[0].fireText({ kind: "pong", hasBinaryPayload: false });
      await vi.advanceTimersByTimeAsync(REATTACH_BUDGET_MS);

      // The alt-tab case: no second dial, and the original socket was never
      // closed. A wake that re-dials without asking fails exactly here.
      expect(sockets).toHaveLength(1);
      expect(sockets[0].closed).toBeNull();
    } finally {
      dispose();
    }
  });

  it("reattaches a socket that has gone silent, inside the budget", async () => {
    const { sockets, statuses, dispose } = await mountedShellStream();

    vi.useFakeTimers();
    try {
      setVisibility("hidden");
      setVisibility("visible");
      expect(sockets[0].sawPing()).toBe(true);

      // No pong: the socket is half-open, which after a freeze is the only
      // shape a dead socket has. Walk the clock to the budget, not past it.
      let elapsedMs = 0;
      while (sockets.length < 2 && elapsedMs < REATTACH_BUDGET_MS) {
        await vi.advanceTimersByTimeAsync(STEP_MS);
        elapsedMs += STEP_MS;
      }
      expect(sockets.length).toBeGreaterThanOrEqual(2);
      expect(sockets[0].closed).not.toBeNull();

      // Re-dialing is not reattaching. The budget is spent when the stream is
      // carrying frames again, so the replacement has to finish its handshake
      // inside what is left of it.
      completeHandshake(sockets[1]);
      await vi.advanceTimersByTimeAsync(STEP_MS);
      elapsedMs += STEP_MS;
      expect(elapsedMs).toBeLessThanOrEqual(REATTACH_BUDGET_MS);
      expect(statuses.filter((status) => status === "open")).toHaveLength(2);
    } finally {
      dispose();
    }
  });

  it("opens no wake episode while the tab stays visible", async () => {
    const { sockets, dispose } = await mountedShellStream();

    vi.useFakeTimers();
    try {
      // A `visibilitychange` with the state unmoved is not an edge. Without
      // the edge filter this would probe every live stream on every fire.
      document.dispatchEvent(new Event("visibilitychange"));
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(REATTACH_BUDGET_MS);

      expect(sockets[0].sawPing()).toBe(false);
      expect(sockets).toHaveLength(1);
      expect(sockets[0].closed).toBeNull();
    } finally {
      dispose();
    }
  });
});
