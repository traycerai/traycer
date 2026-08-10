import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
  type VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
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
import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "../../host-messenger";
import {
  getNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "../../negotiated-manifest-registry";
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
const cursorStreamRegistry = defineVersionedStreamRpcRegistry({
  "cursor.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineStreamRpcContract({
            method: "cursor.subscribe",
            schemaVersion: { major: 1, minor: 0 },
            openRequestSchema: z.object({ cursor: z.number().nullable() }),
            serverFrameSchema: z.object({
              kind: z.literal("snapshot"),
              hasBinaryPayload: z.literal(false),
            }),
            clientFrameSchema: z.object({
              kind: z.literal("noop"),
              hasBinaryPayload: z.literal(false),
            }),
          }),
        },
      },
    },
  },
});

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
  /** Params carried by every logical subscribe, including reconnect replay. */
  readonly subscribeParams: unknown[] = [];
  streamManifest = buildStreamManifest(emptyStreamRegistry);
  /**
   * The OPTIONAL rpc manifest the fake host advertises in `openAck`. Floor
   * stays empty (matching the empty client registries here); optional
   * methods are the interesting surface - they must publish to the
   * negotiated-manifest registry and must NEVER fatal the session, however
   * unknown to the client they are.
   */
  optionalRpcManifest: Record<string, { major: number; minor: number }> = {};
  /** The FLOOR rpc manifest advertised in `openAck` (compat-checked). */
  floorRpcManifest: Record<string, { major: number; minor: number }> = {};
  /**
   * When false the `openAck` omits `optionalRpc` entirely - the shape a peer
   * built before the floor/optional split would send. `sessionManifestsSchema`
   * requires the field, so this exercises the parse-rejection path rather
   * than a silently half-understood manifest.
   */
  sendOptionalRpc = true;
  /** Every REQUEST frame the client sent: method + on-wire version + params. */
  readonly unaryRequests: {
    method: string;
    schemaVersion: unknown;
    params: unknown;
  }[] = [];
  /** Answers the next REQUEST with this result payload. */
  unaryResult: unknown = { ready: true };
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

  /** Relay control frame: the host's leg of the tunnel went away/came back. */
  sendHostAttachment(state: "host_detached" | "host_attached"): void {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.closed);
    if (connection === undefined) {
      throw new Error("no live connection to signal on");
    }
    connection.socket.onmessage?.({
      type: "text",
      data: JSON.stringify({ type: state }),
    });
  }

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
    if (message.type === MuxFrameType.SUBSCRIBE) {
      this.subscribeParams.push(message.json?.params);
      return;
    }
    if (message.type === MuxFrameType.REQUEST) {
      const json = message.json ?? {};
      this.unaryRequests.push({
        method: typeof json.method === "string" ? json.method : "",
        schemaVersion: json.schemaVersion,
        params: json.params,
      });
      await this.sendMux(connection, {
        type: MuxFrameType.RESPONSE,
        streamId: message.streamId,
        qos: QosClass.INTERACTIVE,
        json: {
          requestId: typeof json.requestId === "string" ? json.requestId : "",
          method: typeof json.method === "string" ? json.method : "",
          result: this.unaryResult,
          error: null,
        },
        binary: null,
      });
      return;
    }
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
        json: {
          manifest: this.sendOptionalRpc
            ? {
                rpc: this.floorRpcManifest,
                optionalRpc: this.optionalRpcManifest,
                stream: this.streamManifest,
              }
            : { rpc: this.floorRpcManifest, stream: this.streamManifest },
          capabilities: [],
        },
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
    "fires (through RemoteStreamClient) at EVERY ready boundary - the clean first open AND a post-drop re-attach",
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
        // The clean first open IS evidence: queries that raced this dial have
        // already errored pre-send and this is their only automatic refetch
        // signal (the 15-20s stranded Providers card). Exactly one emission.
        expect(recoveredEvents).toBe(1);

        relay.dropCurrentConnection();
        await vi.waitFor(() => expect(recoveredEvents).toBe(2), WAIT);
        // The second emission was a reconnect, not a terminal close.
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

describe("RemoteSession host_detached readiness evidence", () => {
  it(
    "stops answering ready and rejects sends as retryable while the host leg is detached, then recovers through the full re-attach",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = buildSession(relay, lease, null);
      let recoveredEvents = 0;
      session.subscribeAvailabilityRecovered(() => {
        recoveredEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(recoveredEvents).toBe(1);

        // Relay says the HOST's leg is gone. The session keeps its socket and
        // its "ready" phase while it waits - but the scheduler is paused and
        // nothing will drain it, so answering "ready" would be the standing
        // lie R4-B5 kills (Settings rendering Online, off this session, for a
        // host that is OFF - for up to the 15-min standing bound), and an
        // enqueued unary would just die at the 30s timeout as NON-retryable.
        relay.sendHostAttachment("host_detached");
        expect(session.isReady()).toBe(false);
        expect(session.isClosed()).toBe(false);

        const error: unknown = await session.sendUnary("host.status", {}).then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(RetryableTransportError);

        // `host_attached` out of detached means the host rebuilt its Noise
        // state - the session routes it through a FULL re-attach, whose ready
        // boundary restores the evidence and fires availability recovery.
        relay.sendHostAttachment("host_attached");
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(recoveredEvents).toBe(2);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteStreamClient dynamic subscribe params", () => {
  it(
    "re-reads the current params before a reconnect re-subscribes",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(cursorStreamRegistry);
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const streamClient = new RemoteStreamClient<
        VersionedRpcRegistry,
        typeof cursorStreamRegistry
      >(session);
      let cursor: number | null = null;
      const stream = streamClient.subscribeWithParamsProvider(
        "cursor.subscribe",
        () => ({ cursor }),
      );
      try {
        await vi.waitFor(
          () => expect(relay.subscribeParams).toHaveLength(1),
          WAIT,
        );
        expect(relay.subscribeParams[0]).toEqual({ cursor: null });

        // Advance application state while the first physical connection is
        // live. Freezing the provider at stream creation makes this assertion
        // fail with the original null cursor (the required ablation).
        cursor = 42;
        relay.dropCurrentConnection();
        await vi.waitFor(
          () => expect(relay.subscribeParams).toHaveLength(2),
          WAIT,
        );
        expect(relay.subscribeParams[1]).toEqual({ cursor: 42 });
        expect(relay.errors).toEqual([]);
      } finally {
        stream.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession dial-failure logging", () => {
  // These pin the WIRING, not the throttle itself (dial-failure-log.test.ts
  // owns that): a failing connect loop must produce a line saying WHY, and a
  // recovered session must say it recovered. The console is the sink on
  // purpose - shared OSS transport code has no logger seam, and the desktop
  // shell forwards renderer console output into its log file.

  function sessionLines(
    calls: ReadonlyArray<ReadonlyArray<unknown>>,
  ): string[] {
    return calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[remote-session]"));
  }

  it(
    "logs a grant-mint failure once, with its detail, and suppresses identical retries",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      let mintCalls = 0;
      const options = buildSessionOptions(relay, lease, null);
      const session = new RemoteSession({
        ...options,
        grantProvider: () => {
          mintCalls += 1;
          return Promise.resolve({
            kind: "unavailable" as const,
            detail: "authn answered HTTP 500",
            context: "signing key missing",
          });
        },
      });
      try {
        session.start();
        // Three attempts land inside ~4s of backoff (0s, 1s, 3s).
        await vi.waitFor(() => expect(mintCalls).toBeGreaterThanOrEqual(3), {
          timeout: 10_000,
          interval: 50,
        });
        const lines = sessionLines(warnSpy.mock.calls);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("could not mint an attach grant");
        expect(lines[0]).toContain("authn answered HTTP 500");
        expect(lines[0]).toMatch(/retrying in \d+ms/);
      } finally {
        session.close();
        warnSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "names a pre-attach_ack socket close for what it cannot distinguish (DNS / refused / rejected upgrade)",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      // A factory whose sockets die instantly with the browser's opaque
      // 1006/empty close - exactly what a nonexistent relay hostname
      // produced in the real outage.
      const deadFactory: IStreamWebSocketFactory = {
        create: (): StreamWebSocketLike => {
          const socket = new FakeSocket(
            () => undefined,
            () => undefined,
          );
          queueMicrotask(() => {
            socket.onclose?.({ code: 1006, reason: "", wasClean: false });
          });
          return socket;
        },
      };
      const options = buildSessionOptions(relay, lease, null);
      const session = new RemoteSession({
        ...options,
        webSocketFactory: deadFactory,
      });
      try {
        session.start();
        await vi.waitFor(
          () =>
            expect(sessionLines(warnSpy.mock.calls).length).toBeGreaterThan(0),
          { timeout: 10_000, interval: 50 },
        );
        const line = sessionLines(warnSpy.mock.calls)[0];
        expect(line).toContain("code=1006");
        expect(line).toContain("before attach_ack");
        expect(line).toContain("DNS failure");
      } finally {
        session.close();
        warnSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "logs the recovery line when a previously-failing session reaches ready",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      let mintCalls = 0;
      const options = buildSessionOptions(relay, lease, null);
      const session = new RemoteSession({
        ...options,
        grantProvider: () => {
          mintCalls += 1;
          if (mintCalls < 3) {
            return Promise.resolve({
              kind: "unavailable" as const,
              detail: "authn answered HTTP 500",
              context: "",
            });
          }
          return Promise.resolve({
            kind: "ok" as const,
            grant: { grant: "grant-jws", expiresInSeconds: 300 },
          });
        },
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const recoveries = infoSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith("[remote-session]"));
        expect(recoveries).toHaveLength(1);
        expect(recoveries[0]).toContain(
          "recovered after 2 consecutive failures",
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
        warnSpy.mockRestore();
        infoSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it("rejects on a TERMINAL session as a non-retryable transport failure", async () => {
    // "Not ready" covers two opposite futures. A dialing session will become
    // ready; a closed one never will - `close()` is terminal and `start()`
    // only re-dials from idle. Calling both retryable makes the retry wrapper
    // spend its whole budget on a session that cannot answer, and makes any UI
    // reading the class as "still connecting" wait for a ready boundary no one
    // will ever emit (the Providers panel did exactly that).
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    const session = buildSession(relay, lease, null);
    session.close();
    expect(session.isClosed()).toBe(true);

    const error: unknown = await session.sendUnary("host.status", {}).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(HostTransportFailureError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
  });

  it("still rejects a session that is merely DIALING as retryable", async () => {
    // The other side of the same branch, so the change above reads as a
    // narrowing rather than a blanket downgrade: a session on its way to ready
    // keeps its retry license, which is what the pre-send no-dispatch
    // guarantee exists for.
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      expect(session.isReady()).toBe(false);
      expect(session.isClosed()).toBe(false);

      const error: unknown = await session.sendUnary("host.status", {}).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(RetryableTransportError);
    } finally {
      session.close();
    }
  });
});

describe("RemoteSession negotiated-manifest publication", () => {
  // The registry is module-level by design (a host's manifest is a property
  // of the host process, not of one messenger), so these tests reset it.
  beforeEach(() => {
    resetNegotiatedManifests();
  });

  it(
    "publishes the openAck's merged rpc manifest at the ready boundary - optional methods included",
    async () => {
      const relay = new FakeRelayHost();
      // Methods the CLIENT's registry does not know: exactly the shape of an
      // optional (non-floor) method a newer host advertises - the case that
      // silently failed closed when the remote path did not publish.
      relay.optionalRpcManifest = {
        "host.usage.summary": { major: 1, minor: 0 },
        "workspace.writeFile": { major: 2, minor: 1 },
      };
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      // Fail-closed before any handshake: unknown, never false.
      expect(getNegotiatedHostMethods("host-1")).toBeNull();
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(getNegotiatedHostMethods("host-1")).toEqual(
          new Set(["host.usage.summary", "workspace.writeFile"]),
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "refreshes the published set on re-attach - a host upgraded under a live session self-corrects",
    async () => {
      const relay = new FakeRelayHost();
      relay.optionalRpcManifest = {
        "host.usage.summary": { major: 1, minor: 0 },
      };
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(getNegotiatedHostMethods("host-1")).toEqual(
          new Set(["host.usage.summary"]),
        );
        // The host restarts on a newer binary advertising one more optional
        // method; the client's re-attach after the drop must overwrite the
        // stale entry without an app restart.
        relay.optionalRpcManifest = {
          "host.usage.summary": { major: 1, minor: 0 },
          "host.newly.added": { major: 1, minor: 0 },
        };
        relay.dropCurrentConnection();
        await vi.waitFor(
          () =>
            expect(getNegotiatedHostMethods("host-1")).toEqual(
              new Set(["host.usage.summary", "host.newly.added"]),
            ),
          WAIT,
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession absent optional method", () => {
  // A method the client knows and the host never advertised. Before the
  // floor/optional split this was unreachable - the handshake fataled on the
  // skew - so the remote path had no degrade at all and would have answered a
  // generic RPC_ERROR. Callers key off E_HOST_UNSUPPORTED (the run-settings
  // write queue suppresses exactly that code to fall back to legacy
  // persist-on-next-send), so a generic error reads as a real failure.
  const unsupportedV10 = defineRpcContract({
    method: "host.syntheticUnsupported",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({}),
    responseSchema: z.object({ ok: z.boolean() }),
  });
  // Typed as the erased `VersionedRpcRegistry` at the declaration (same shape
  // as `emptyRpcRegistry` above) so the session can take it directly - the
  // repo bans chained/`as unknown` assertions, and none is needed here.
  const unsupportedRegistry: VersionedRpcRegistry =
    defineFloorAwareVersionedRpcRegistry([] as const, {
      "host.syntheticUnsupported": {
        degrade: { kind: "unsupported" },
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: unsupportedV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

  it(
    "applies the declared unsupported degrade instead of a generic RPC_ERROR",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: unsupportedRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const error: unknown = await session
          .sendUnary("host.syntheticUnsupported", {})
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(HostRpcError);
        expect((error as HostRpcError).code).toBe("E_HOST_UNSUPPORTED");
        expect(
          (error as HostRpcError).fatalDetails?.upgradeGuidance
            ?.hostShouldUpgrade,
        ).toBe(true);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession fallback degrade version anchoring", () => {
  // `degrade.to` names version 1.0 while the target's canonical is 1.1. The
  // request handed to the fallback is ALREADY adapted to 1.0, so dispatching
  // it at canonical would validate `{}` against 1.1's `{verbose}` schema and
  // transform the response with the wrong contract. Re-entering the public
  // `sendUnary` would do exactly that - hence the version-preserving internal
  // dispatch this pins.
  const statusV10 = defineRpcContract({
    method: "host.status",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({}),
    responseSchema: z.object({ ready: z.boolean() }),
  });
  const statusV11 = defineRpcContract({
    method: "host.status",
    schemaVersion: { major: 1, minor: 1 } as const,
    requestSchema: z.object({ verbose: z.boolean() }),
    responseSchema: z.object({ ready: z.boolean(), detail: z.string() }),
  });
  const skewFallbackV10 = defineRpcContract({
    method: "host.syntheticSkewFallback",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({ label: z.string() }),
    // `detailSeen` is the DISCRIMINATOR: `detail` exists only on the 1.1
    // response, so it is true exactly when the response was decoded (and
    // upgraded) at canonical instead of at the declared 1.0.
    responseSchema: z.object({ summary: z.string(), detailSeen: z.boolean() }),
  });
  const upgradeStatus = defineUpgradePath<typeof statusV10, typeof statusV11>({
    from: statusV10.schemaVersion,
    to: statusV11.schemaVersion,
    upgradeRequest: () => ({ verbose: false }),
    upgradeResponse: (response) => ({
      ready: response.ready,
      detail: "upgraded",
    }),
  });
  const skewRegistry: VersionedRpcRegistry =
    defineFloorAwareVersionedRpcRegistry(["host.status"] as const, {
      "host.status": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: statusV10, upgradeFromPreviousVersion: null },
            1: {
              contract: statusV11,
              upgradeFromPreviousVersion: upgradeStatus,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
      "host.syntheticSkewFallback": {
        degrade: defineFallbackMethodDegrade<
          typeof skewFallbackV10,
          typeof statusV10,
          "host.status"
        >({
          kind: "fallback",
          to: { method: "host.status", major: 1, minor: 0 },
          adaptRequest: () => ({}),
          adaptResponse: (response) => ({
            summary: response.ready ? "ready" : "not-ready",
            detailSeen: Object.prototype.hasOwnProperty.call(
              response,
              "detail",
            ),
          }),
        }),
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: skewFallbackV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

  it(
    "dispatches the fallback at degrade.to, not the target's canonical version",
    async () => {
      const relay = new FakeRelayHost();
      // The host has the older 1.0 target on its FLOOR and NOT the
      // fallback's own (optional) method.
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      relay.unaryResult = { ready: true };
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: skewRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const result: unknown = await session.sendUnary(
          "host.syntheticSkewFallback",
          { label: "x" },
        );
        // adaptResponse ran over the DECLARED 1.0 response shape: no `detail`
        // key, i.e. no canonical-version upgrade was applied on the way back.
        expect(result).toEqual({ summary: "ready", detailSeen: false });
        // ONE request, sent as host.status anchored at the DECLARED 1.0 -
        // canonical 1.1 here would have rejected the adapted `{}` payload.
        expect(relay.unaryRequests).toHaveLength(1);
        expect(relay.unaryRequests[0]?.method).toBe("host.status");
        expect(relay.unaryRequests[0]?.schemaVersion).toEqual({
          major: 1,
          minor: 0,
        });
        expect(relay.unaryRequests[0]?.params).toEqual({});
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession openAck without optionalRpc", () => {
  // The registry is module-level, so a sibling suite's successful handshake
  // would otherwise leave this host's entry populated.
  beforeEach(() => {
    resetNegotiatedManifests();
  });

  it(
    "refuses a manifest missing the required optionalRpc rather than half-reading it",
    async () => {
      const relay = new FakeRelayHost();
      // The pre-split frame shape. `sessionManifestsSchema` requires
      // `optionalRpc`, so this is rejected at parse - it never reaches the
      // floor compat check, and the merged legacy set is never mistaken for a
      // floor. The session stays un-ready and retries rather than proceeding
      // on a manifest it did not understand.
      relay.sendOptionalRpc = false;
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(session.isReady()).toBe(false);
        expect(getNegotiatedHostMethods("host-1")).toBeNull();
        expect(session.isClosed()).toBe(false);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});
