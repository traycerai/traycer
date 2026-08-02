import { describe, expect, it, vi } from "vitest";
import {
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  defineVersionedStreamRpcRegistry,
  type VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  createResponderHandshake,
  generateStaticKeyPair,
  DEFAULT_REPLAY_WINDOW_SIZE,
  NoiseSession,
  type NoiseHandshakeState,
  type NoiseKeyPair,
} from "@traycer/protocol/crypto/noise";
import {
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
  decodeMuxFrame,
  encodeMuxFrame,
} from "@traycer/protocol/host-transport/mux";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../../ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../../ws-factory";
import {
  ChunkReassembler,
  chunkOutboundMessage,
  type OutboundMessage,
  type ReassembledMessage,
} from "../chunker";
import { RemoteSession, type RemoteSessionOptions } from "../remote-session";
import { RemoteStreamClient } from "../remote-stream-client";

// Integration-style tests for the session lifecycle edges a cold audit found
// unrecoverable: an UNAUTHORIZED session fatal (the wake-time expired-bearer
// case) must revalidate + redial rather than brick the session; a genuinely
// terminal fatal must FIRE `onClosed` so owners can rebuild; and a ready
// boundary re-reached after a drop must surface availability-recovered
// evidence. The fake below implements the REAL wire: relay attach_ack, a real
// responder-side Noise-NK handshake, and mux frame encode/decode - so the
// session under test runs its full production connect path (only the network
// and the grant/authn HTTP are faked).
//
// Timing: the session's reconnect backoff starts at 1s (config.ts), so every
// recovery assertion waits with an explicit generous budget rather than
// vitest's 1s `waitFor` / 5s per-test defaults.

const EMPTY_AD = new Uint8Array(0);
const WAIT = { timeout: 10_000, interval: 50 } as const;
const TEST_BUDGET_MS = 15_000;

// Zero-method registries: the session's connect/open/fatal lifecycle under
// test never dispatches a method, and an empty manifest is trivially
// compatible with the fake host echoing an empty manifest back.
const emptyRpcRegistry: VersionedRpcRegistry = defineVersionedRpcRegistry({});
const emptyStreamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({});

type OpenDecision =
  | { readonly kind: "ack" }
  | { readonly kind: "fatal"; readonly details: FatalErrorDetails };

function unauthorizedDetails(): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason: "OPEN bearer rejected",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

class FakeSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  private readonly onSendData: (data: string | Uint8Array) => void;
  private readonly onLocalClose: () => void;

  constructor(
    onSendData: (data: string | Uint8Array) => void,
    onLocalClose: () => void,
  ) {
    this.onSendData = onSendData;
    this.onLocalClose = onLocalClose;
  }

  send(data: string | Uint8Array): void {
    this.onSendData(data);
  }

  close(_code: number, _reason: string): void {
    this.onLocalClose();
  }
}

interface FakeConnection {
  readonly socket: FakeSocket;
  noise: NoiseSession | null;
  handshake: NoiseHandshakeState | null;
  readonly reassembler: ChunkReassembler;
  readonly seqByStream: Map<number, number>;
  /** Serializes async frame handling so mux ordering matches the wire. */
  queue: Promise<void>;
  closed: boolean;
}

/**
 * The relay + host end of the wire, scripted per test via `decideOpen`. Runs a
 * REAL responder Noise-NK handshake against the session's initiator and
 * answers each in-channel `open{bearer}` with an `openAck` or a session-level
 * `fatal`, recording every bearer presented.
 */
class FakeRelayHost {
  private readonly hostKeys: NoiseKeyPair = generateStaticKeyPair();
  private readonly connections: FakeConnection[] = [];
  /** Every bearer presented across all `open` frames, in arrival order. */
  readonly openBearers: string[] = [];
  /** Unexpected harness-side failures; asserted empty by the tests. */
  readonly errors: unknown[] = [];
  decideOpen: (bearer: string, openIndex: number) => OpenDecision = () => ({
    kind: "ack",
  });

  get hostStaticPublicKey(): Uint8Array {
    return this.hostKeys.publicKey;
  }

  readonly factory: IStreamWebSocketFactory = {
    create: (): StreamWebSocketLike => {
      const connection: FakeConnection = {
        socket: new FakeSocket(
          (data) => this.enqueue(connection, data),
          () => {
            connection.closed = true;
          },
        ),
        noise: null,
        handshake: null,
        reassembler: new ChunkReassembler(),
        seqByStream: new Map(),
        queue: Promise.resolve(),
        closed: false,
      };
      this.connections.push(connection);
      const sid = this.connections.length;
      queueMicrotask(() => {
        if (connection.closed) {
          return;
        }
        connection.socket.onopen?.({ type: "open" });
        connection.socket.onmessage?.({
          type: "text",
          data: JSON.stringify({ type: "attach_ack", role: "client", sid }),
        });
      });
      return connection.socket;
    },
  };

  /** Server-side drop of the live socket (relay restart / network cut). */
  dropCurrentConnection(): void {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.closed);
    if (connection === undefined) {
      throw new Error("no live connection to drop");
    }
    connection.closed = true;
    connection.socket.onclose?.({
      code: 1006,
      reason: "server-drop",
      wasClean: false,
    });
  }

  private enqueue(connection: FakeConnection, data: string | Uint8Array): void {
    connection.queue = connection.queue
      .then(() => this.handleClientSend(connection, data))
      .catch((error: unknown) => {
        this.errors.push(error);
      });
  }

  private async handleClientSend(
    connection: FakeConnection,
    data: string | Uint8Array,
  ): Promise<void> {
    if (connection.closed) {
      return;
    }
    if (typeof data === "string") {
      if (data === "relay-ping") {
        connection.socket.onmessage?.({ type: "text", data: "relay-pong" });
      }
      // `reauth` control frames need no ack for these tests.
      return;
    }
    if (connection.noise === null) {
      // Handshake msg0: run the responder side and answer with msg1.
      const handshake = await createResponderHandshake(
        this.hostKeys,
        NOISE_PROLOGUE,
      );
      await handshake.readMessage(data);
      const msg1 = await handshake.writeMessage(new Uint8Array(0));
      connection.handshake = handshake;
      connection.noise = NoiseSession.fromHandshake(
        handshake,
        DEFAULT_REPLAY_WINDOW_SIZE,
      );
      this.deliverBinary(connection, msg1);
      return;
    }
    const muxBytes = await connection.noise.decrypt(data, EMPTY_AD);
    const frame = decodeMuxFrame(muxBytes);
    const message = connection.reassembler.accept(frame);
    if (message === null) {
      return;
    }
    await this.handleMuxMessage(connection, message);
  }

  private async handleMuxMessage(
    connection: FakeConnection,
    message: ReassembledMessage,
  ): Promise<void> {
    if (
      message.streamId !== SESSION_CONTROL_STREAM_ID ||
      message.type !== MuxFrameType.OPEN
    ) {
      return;
    }
    const bearer =
      message.json !== null && typeof message.json.bearer === "string"
        ? message.json.bearer
        : "";
    const openIndex = this.openBearers.length;
    this.openBearers.push(bearer);
    const decision = this.decideOpen(bearer, openIndex);
    if (decision.kind === "ack") {
      await this.sendMux(connection, {
        type: MuxFrameType.OPEN_ACK,
        streamId: SESSION_CONTROL_STREAM_ID,
        qos: QosClass.INTERACTIVE,
        json: { manifest: { rpc: {}, stream: {} }, capabilities: [] },
        binary: null,
      });
      return;
    }
    await this.sendMux(connection, {
      type: MuxFrameType.FATAL,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: { details: { ...decision.details } },
      binary: null,
    });
  }

  private async sendMux(
    connection: FakeConnection,
    message: OutboundMessage,
  ): Promise<void> {
    const noise = connection.noise;
    if (noise === null || connection.closed) {
      return;
    }
    const frames = chunkOutboundMessage(message, () => {
      const current = connection.seqByStream.get(message.streamId) ?? 0;
      connection.seqByStream.set(message.streamId, current + 1);
      return current;
    });
    for (const frame of frames) {
      const sealed = await noise.encrypt(encodeMuxFrame(frame), EMPTY_AD);
      this.deliverBinary(connection, sealed);
    }
  }

  private deliverBinary(connection: FakeConnection, bytes: Uint8Array): void {
    if (connection.closed) {
      return;
    }
    connection.socket.onmessage?.({ type: "binary", data: bytes });
  }
}

function buildSession(
  relay: FakeRelayHost,
  lease: MutableBearerLease,
  auth: StreamAuthRevalidator | null,
): RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry> {
  return new RemoteSession(buildSessionOptions(relay, lease, auth));
}

/** The options `buildSession` uses, exposed so a test can drop a field. */
function buildSessionOptions(
  relay: FakeRelayHost,
  lease: MutableBearerLease,
  auth: StreamAuthRevalidator | null,
): RemoteSessionOptions<VersionedRpcRegistry, VersionedStreamRpcRegistry> {
  let nextRequestId = 0;
  return {
    hostId: "host-1",
    attachBaseUrl: "wss://relay.test/attach",
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider: () =>
      Promise.resolve({
        kind: "ok" as const,
        grant: { grant: "grant-jws", expiresInSeconds: 300 },
      }),
    bearer: () => lease,
    auth,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
  };
}

describe("RemoteSession UNAUTHORIZED session-fatal recovery", () => {
  it(
    "revalidates and redials with the fresh bearer instead of terminally closing",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("expired-token", "user-1");
      // The host rejects the stale bearer exactly the way the production host
      // does at a wake-time re-attach: a session-level FATAL{UNAUTHORIZED}.
      relay.decideOpen = (bearer) =>
        bearer === "fresh-token"
          ? { kind: "ack" }
          : { kind: "fatal", details: unauthorizedDetails() };
      let revalidateCalls = 0;
      const auth: StreamAuthRevalidator = {
        revalidateForReconnect: () => {
          revalidateCalls += 1;
          lease.rotate("fresh-token");
          return Promise.resolve("rotated");
        },
      };
      const session = buildSession(relay, lease, auth);
      let closedEvents = 0;
      session.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        // The recovery presented the rejected bearer once, then the rotated
        // one - and never closed the session on the way.
        expect(relay.openBearers).toEqual(["expired-token", "fresh-token"]);
        expect(revalidateCalls).toBe(1);
        expect(session.isClosed()).toBe(false);
        expect(closedEvents).toBe(0);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "goes terminal - and fires onClosed - when revalidation reports the credential rejected",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("dead-token", "user-1");
      relay.decideOpen = () => ({
        kind: "fatal",
        details: unauthorizedDetails(),
      });
      let revalidateCalls = 0;
      const auth: StreamAuthRevalidator = {
        revalidateForReconnect: () => {
          revalidateCalls += 1;
          return Promise.resolve("rejected");
        },
      };
      const session = buildSession(relay, lease, auth);
      let closedEvents = 0;
      session.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
        // Terminal BECAUSE the revalidation said so - the recovery path ran
        // exactly once and stopped, rather than never being consulted.
        expect(revalidateCalls).toBe(1);
        expect(closedEvents).toBe(1);
        expect(relay.openBearers).toEqual(["dead-token"]);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "treats a retryable UNAUTHORIZED fatal as a transport drop - reconnects without spending a revalidation",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      // The transient host-side rejection (its JWKS fetch timed out): same
      // wire code, but flagged retryable - the credential is fine.
      relay.decideOpen = (_bearer, openIndex) =>
        openIndex === 0
          ? {
              kind: "fatal",
              details: { ...unauthorizedDetails(), retryable: true },
            }
          : { kind: "ack" };
      const revalidate = vi.fn(() => Promise.resolve("rotated" as const));
      const session = buildSession(relay, lease, {
        revalidateForReconnect: revalidate,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.openBearers).toEqual(["valid-token", "valid-token"]);
        expect(revalidate).not.toHaveBeenCalled();
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "treats a SYNCHRONOUSLY thrown revalidation as transient, not an unhandled rejection",
    async () => {
      // `revalidateForReconnect` is typed to RETURN a promise, but nothing stops
      // an implementation throwing before it returns one. Called bare, that
      // throw skips the `.catch` that maps a failed revalidation to
      // "network-error" and the `finally` that clears the budget timer, then
      // escapes the `void`-discarded recovery task — an unhandled rejection,
      // with the session parked in "reconnecting" and no redial armed.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("stale-token", "user-1");
      let opens = 0;
      relay.decideOpen = () => {
        opens += 1;
        return opens === 1
          ? { kind: "fatal", details: unauthorizedDetails() }
          : { kind: "ack" };
      };
      let revalidateCalls = 0;
      const auth: StreamAuthRevalidator = {
        revalidateForReconnect: () => {
          revalidateCalls += 1;
          throw new Error("revalidation threw before returning a promise");
        },
      };
      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      const session = buildSession(relay, lease, auth);
      try {
        session.start();
        // Recovers: the throw is transient, so the normal backoff redials.
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(revalidateCalls).toBe(1);
        // "network-error" leaves the bearer untouched - the redial presents the
        // same one, and this never counts toward the give-up bound.
        expect(relay.openBearers).toEqual(["stale-token", "stale-token"]);
        expect(session.isClosed()).toBe(false);
        await Promise.resolve();
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "closes cleanly when the consumer wired NO revalidator at all (not just null)",
    async () => {
      // `auth` is required by the type, but untyped consumers (the connect-path
      // E2E harness, ad-hoc probes) can omit it entirely. An `undefined`
      // sliding past a `!== null` check calls `.revalidateForReconnect()` on
      // nothing, and the TypeError lands in a floating promise on the reconnect
      // path — the session dies as an unhandled rejection instead of closing
      // with the host's own UNAUTHORIZED reason.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("dead-token", "user-1");
      relay.decideOpen = () => ({
        kind: "fatal",
        details: unauthorizedDetails(),
      });
      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      // Build with the property ABSENT, exactly as an untyped caller would.
      const options = buildSessionOptions(relay, lease, null);
      delete (options as { auth?: unknown }).auth;
      const session = new RemoteSession(options);
      try {
        session.start();
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
        // Degrades exactly like `auth: null`: terminal, no crash.
        expect(relay.openBearers).toEqual(["dead-token"]);
        expect(relay.errors).toEqual([]);
        await Promise.resolve();
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession terminal close notification", () => {
  it(
    "fires onClosed (through RemoteStreamClient) when a non-recoverable session fatal closes the session",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      relay.decideOpen = () => ({
        kind: "fatal",
        details: {
          code: "INCOMPATIBLE",
          reason: "manifest mismatch",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      const revalidate = vi.fn(() => Promise.resolve("rotated" as const));
      const session = buildSession(relay, lease, {
        revalidateForReconnect: revalidate,
      });
      const streamClient = new RemoteStreamClient(session);
      let closedEvents = 0;
      streamClient.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(
          () => expect(streamClient.isClosed()).toBe(true),
          WAIT,
        );
        // The auth hook is for UNAUTHORIZED only - an INCOMPATIBLE fatal must
        // stay terminal and must not spend a revalidation.
        expect(closedEvents).toBe(1);
        expect(revalidate).not.toHaveBeenCalled();
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession plan-restricted entitlement denial", () => {
  it(
    "goes terminal on a plan-restricted mint - one mint, no relay dial, no revalidation spend",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const revalidate = vi.fn(() => Promise.resolve("rotated" as const));
      let mintCalls = 0;
      let nextRequestId = 0;
      const session = new RemoteSession({
        hostId: "host-1",
        attachBaseUrl: "wss://relay.test/attach",
        hostStaticPublicKey: relay.hostStaticPublicKey,
        grantProvider: () => {
          mintCalls += 1;
          return Promise.resolve({ kind: "plan-restricted" as const });
        },
        bearer: () => lease,
        auth: { revalidateForReconnect: revalidate },
        rpcRegistry: emptyRpcRegistry,
        streamRegistry: emptyStreamRegistry,
        webSocketFactory: relay.factory,
        requestId: () => `req-${(nextRequestId += 1)}`,
      });
      const streamClient = new RemoteStreamClient(session);
      let closedEvents = 0;
      streamClient.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(
          () => expect(streamClient.isClosed()).toBe(true),
          WAIT,
        );
        // Terminal, not a backoff loop: exactly one mint, and the relay was
        // never dialed with a grant the account is not entitled to.
        expect(closedEvents).toBe(1);
        expect(mintCalls).toBe(1);
        expect(relay.openBearers).toEqual([]);
        // An entitlement denial is NOT an auth failure - no revalidation.
        expect(revalidate).not.toHaveBeenCalled();
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession availability-recovered evidence", () => {
  it(
    "fires (through RemoteStreamClient) on a ready boundary re-reached after a drop, never on the clean first open",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = buildSession(relay, lease, null);
      const streamClient = new RemoteStreamClient(session);
      let recoveredEvents = 0;
      streamClient.subscribeAvailabilityRecovered(() => {
        recoveredEvents += 1;
      });
      let closedEvents = 0;
      streamClient.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        // Clean first open: nothing recovered, so nothing fires.
        expect(recoveredEvents).toBe(0);

        relay.dropCurrentConnection();
        await vi.waitFor(() => expect(recoveredEvents).toBe(1), WAIT);
        // The recovery was a reconnect, not a terminal close.
        expect(session.isReady()).toBe(true);
        expect(closedEvents).toBe(0);
        expect(relay.openBearers).toEqual(["valid-token", "valid-token"]);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});
