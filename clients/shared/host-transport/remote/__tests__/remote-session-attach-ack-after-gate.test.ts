import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createResponderHandshake,
  DEFAULT_REPLAY_WINDOW_SIZE,
  generateStaticKeyPair,
  NoiseSession,
  type NoiseKeyPair,
} from "@traycer/protocol/crypto/noise";
import {
  defineVersionedRpcRegistry,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  defineVersionedStreamRpcRegistry,
  type VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  ChunkReassembler,
  OutboundChunkSource,
  type OutboundMessage,
} from "@traycer/protocol/host-transport/chunking";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CAPABILITY_RESUME,
  SESSION_CONTROL_STREAM_ID,
} from "@traycer/protocol/host-transport/mux";
import {
  encodeResumeFrame,
  parseResumeFrame,
  ResumeLedger,
} from "@traycer/protocol/host-transport/resume-ledger";
import type {
  PoolSessionAuth,
  RemoteSessionAuth,
} from "@traycer/protocol/host-transport/remote/auth";
import { ATTACH_ACK_TIMEOUT_MS } from "@traycer/protocol/host-transport/remote/config";
import type { AttachGrantProvider } from "@traycer/protocol/host-transport/remote/grant";
import {
  RemoteSession,
  type RemoteSessionEvidence,
  type RemoteSessionTransportKind,
} from "@traycer/protocol/host-transport/remote/session";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createAuthenticatedUserFixture } from "../../../test-fixtures/authenticated-user";
import type { PoolHostDirectoryEntry } from "../../../host-client/host-directory";
import { retireAllRemoteSessions } from "../active-remote-sessions";
import {
  createPoolHostTransport,
  createRemoteHostTransport,
} from "../create-remote-transport";
import type { IRemoteSession } from "../remote-session";
import { createWhatwgStreamWebSocketFactory } from "../../whatwg-stream-ws-factory";
import { hostDialGate } from "../../ws-dial-gate";

const SLOTS = 6;
const QUEUED_FOR_MS = 15_000;
const ATTACH_URL = "wss://relay.test/attach";
const POOL_URL = "wss://pool.test/stream";
const HOLDER_URL = "wss://holder.test/dial";
const EMPTY_AD = new Uint8Array(0);
/** The authn default and cap for an attach grant. */
const GRANT_LIFETIME_SECONDS = 300;
const GRANT_LIFETIME_MS = GRANT_LIFETIME_SECONDS * 1_000;

/** Captured before fake timers: a real turn lets WebCrypto completions in. */
const realSetImmediate = globalThis.setImmediate;

/**
 * The fake clock moves everything here but Noise, which runs on WebCrypto in
 * a thread pool. These count its operations so a test awaits them finishing
 * rather than sleeping for as long as they usually take.
 */
let webCryptoInFlight = 0;

function countedWebCrypto<T>(operation: Promise<T>): Promise<T> {
  webCryptoInFlight += 1;
  return operation.finally(() => {
    webCryptoInFlight -= 1;
  });
}

function countWebCrypto(): void {
  const subtle = globalThis.crypto.subtle;
  const decrypt = subtle.decrypt.bind(subtle);
  const digest = subtle.digest.bind(subtle);
  const encrypt = subtle.encrypt.bind(subtle);
  const importKey = subtle.importKey.bind(subtle);
  const sign = subtle.sign.bind(subtle);
  vi.spyOn(subtle, "decrypt").mockImplementation((...args) =>
    countedWebCrypto(decrypt(...args)),
  );
  vi.spyOn(subtle, "digest").mockImplementation((...args) =>
    countedWebCrypto(digest(...args)),
  );
  vi.spyOn(subtle, "encrypt").mockImplementation((...args) =>
    countedWebCrypto(encrypt(...args)),
  );
  vi.spyOn(subtle, "importKey").mockImplementation((...args) =>
    countedWebCrypto(importKey(...args)),
  );
  vi.spyOn(subtle, "sign").mockImplementation((...args) =>
    countedWebCrypto(sign(...args)),
  );
}

/** Returns once no Noise operation is running, after two quiet turns. */
async function settleNoise(): Promise<void> {
  let quietTurns = 0;
  while (quietTurns < 2) {
    await new Promise((resolve) => {
      realSetImmediate(resolve);
    });
    quietTurns = webCryptoInFlight === 0 ? quietTurns + 1 : 0;
  }
}

/** Moves the fake clock, then lets the real async work it started finish. */
async function step(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settleNoise();
}

/** Moves the fake clock in quarter-second steps until `condition` holds. */
async function advanceUntil(
  condition: () => boolean,
  maxMs: number,
): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 250) {
    if (condition()) {
      return;
    }
    await step(250);
  }
  if (!condition()) {
    throw new Error("condition was not reached in time");
  }
}

// ---- Fake relay, bridged to the global WebSocket the real factory builds ---- //

type LegEvent =
  | { readonly type: "text"; readonly data: string }
  | { readonly type: "binary"; readonly data: Uint8Array };

type OpenBehavior = "ack" | "plain";

/** One dial of the relay or pool, seen from the far end. */
class Leg {
  onopen: (() => void) | null = null;
  onmessage: ((event: LegEvent) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly params: URLSearchParams;
  closed = false;
  binarySends = 0;
  session: HostSession | null = null;

  constructor(
    readonly index: number,
    readonly url: string,
    private readonly relay: FakeRelay,
  ) {
    this.params = new URL(url).searchParams;
  }

  get claim(): string | null {
    return this.params.get("resume");
  }

  send(data: string | Uint8Array): void {
    if (typeof data !== "string") {
      this.binarySends += 1;
    }
    this.relay.onClientSend(this, data);
  }

  close(): void {
    this.closed = true;
    this.relay.onLegClosed(this);
  }
}

interface HostSession {
  readonly sid: number;
  readonly key: string;
  noise: NoiseSession | null;
  readonly ledger: ResumeLedger;
  readonly reassembler: ChunkReassembler;
  readonly seqByStream: Map<number, number>;
  leg: Leg | null;
  expired: boolean;
  queue: Promise<void>;
}

interface NativeSurface {
  fire(
    type: string,
    data: string | ArrayBuffer,
    code: number,
    reason: string,
  ): void;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

class FakeRelay {
  private readonly keys: NoiseKeyPair = generateStaticKeyPair();
  readonly legs: Leg[] = [];
  readonly sessions: HostSession[] = [];
  readonly resumes: number[] = [];
  /** The bearer each session OPEN frame carried, in arrival order. */
  readonly openBearers: unknown[] = [];
  private nextSid = 1;
  /**
   * What a dial does once the gate has built its native: "hold" waits for the
   * test, "fail" errors and closes it without ever opening, as a refused
   * upgrade does.
   */
  autoOpen: OpenBehavior | "hold" | "fail" = "ack";
  private readonly mints = new Map<
    string,
    { readonly at: number; readonly lifetimeMs: number }
  >();

  /** Remembers when a grant was minted, so the relay can refuse it once stale. */
  recordMint(grant: string, at: number, expiresInSeconds: number): void {
    this.mints.set(grant, { at, lifetimeMs: expiresInSeconds * 1_000 });
  }

  private rejectUpgrade(leg: Leg): void {
    leg.closed = true;
    leg.onerror?.();
    leg.onclose?.(1006, "");
  }

  get publicKey(): Uint8Array {
    return this.keys.publicKey;
  }

  /** Called by the fake native the real factory constructs. */
  attach(native: NativeSurface, url: string): Leg {
    const leg = new Leg(this.legs.length, url, this);
    this.legs.push(leg);
    leg.onopen = () => native.fire("open", "", 0, "");
    leg.onmessage = (event) => {
      native.fire(
        "message",
        event.type === "text" ? event.data : toArrayBuffer(event.data),
        0,
        "",
      );
    };
    leg.onclose = (code, reason) => native.fire("close", "", code, reason);
    leg.onerror = () => native.fire("error", "", 0, "");
    const grant = leg.params.get("grant");
    const minted = grant === null ? undefined : this.mints.get(grant);
    const stale =
      minted !== undefined && Date.now() >= minted.at + minted.lifetimeMs;
    if (stale || this.autoOpen === "fail") {
      queueMicrotask(() => this.rejectUpgrade(leg));
      return leg;
    }
    if (this.autoOpen !== "hold") {
      const behavior = this.autoOpen;
      queueMicrotask(() => this.openLeg(leg, behavior));
    }
    return leg;
  }

  host(): HostSession {
    const session = [...this.sessions]
      .reverse()
      .find((entry) => !entry.expired);
    if (session === undefined) {
      throw new Error("no live host session");
    }
    return session;
  }

  /** The relay drops the current leg from its side. */
  dropLeg(code: number, reason: string): void {
    const leg = this.host().leg;
    if (leg === null) {
      throw new Error("the session has no leg");
    }
    leg.closed = true;
    this.onLegClosed(leg);
    leg.onclose?.(code, reason);
  }

  onLegClosed(leg: Leg): void {
    const session = leg.session;
    if (session === null || session.leg !== leg) {
      return;
    }
    session.leg = null;
    if (leg.params.get("park") !== "1") {
      session.expired = true;
    }
  }

  onClientSend(leg: Leg, data: string | Uint8Array): void {
    if (typeof data === "string") {
      if (data === "relay-ping") {
        queueMicrotask(() => {
          leg.onmessage?.({ type: "text", data: "relay-pong" });
        });
      }
      return;
    }
    if (leg.url.startsWith(POOL_URL)) {
      this.handlePlainData(leg, data);
      return;
    }
    const session = leg.session;
    if (session === null || session.leg !== leg) {
      return;
    }
    session.queue = session.queue.then(() =>
      this.handleClientData(leg, session, data),
    );
  }

  /** The socket opens; "ack" also claims or creates the relay session and acks. */
  openLeg(leg: Leg, behavior: OpenBehavior): void {
    if (leg.closed) {
      return;
    }
    leg.onopen?.();
    if (behavior === "plain") {
      return;
    }
    const claim = leg.claim;
    let session: HostSession | undefined;
    if (claim !== null) {
      session = this.sessions.find(
        (entry) => !entry.expired && `${entry.sid}:${entry.key}` === claim,
      );
    }
    if (session === undefined) {
      const sid = this.nextSid;
      this.nextSid += 1;
      session = {
        sid,
        key: `secret-key-${sid}-xyzzy`,
        noise: null,
        ledger: new ResumeLedger(() => undefined),
        reassembler: new ChunkReassembler(undefined),
        seqByStream: new Map(),
        leg: null,
        expired: false,
        queue: Promise.resolve(),
      };
      this.sessions.push(session);
    }
    session.leg = leg;
    leg.session = session;
    leg.onmessage?.({
      type: "text",
      data: JSON.stringify({
        type: "attach_ack",
        role: "client",
        sid: session.sid,
        resumeKey: session.key,
      }),
    });
  }

  private async handleClientData(
    leg: Leg,
    session: HostSession,
    data: Uint8Array,
  ): Promise<void> {
    if (session.noise === null) {
      const handshake = await createResponderHandshake(
        this.keys,
        NOISE_PROLOGUE,
      );
      await handshake.readMessage(data);
      const msg1 = await handshake.writeMessage(new Uint8Array(0));
      session.noise = NoiseSession.fromHandshake(
        handshake,
        DEFAULT_REPLAY_WINDOW_SIZE,
      );
      if (session.leg === leg) {
        leg.onmessage?.({ type: "binary", data: msg1 });
      }
      return;
    }
    const plaintext = await session.noise.decrypt(data, EMPTY_AD);
    const frame = decodeMuxFrame(plaintext);
    session.ledger.receive(plaintext);
    if (frame.type === MuxFrameType.RESUME) {
      const resume = parseResumeFrame(frame);
      if (resume === null) {
        throw new Error("the client sent a malformed RESUME");
      }
      this.resumes.push(resume.attempt);
      await this.sealAndDeliver(
        session,
        encodeResumeFrame(session.ledger.received, resume.attempt),
      );
      const gap = session.ledger.gapFrom(resume.received);
      if (gap.kind !== "gap") {
        throw new Error("the fake host cannot recover the client count");
      }
      for (const plaintextFrame of gap.frames) {
        await this.sealAndDeliver(session, plaintextFrame);
      }
      return;
    }
    const message = session.reassembler.accept(frame);
    if (
      message !== null &&
      message.streamId === SESSION_CONTROL_STREAM_ID &&
      message.type === MuxFrameType.OPEN
    ) {
      const openJson = message.json ?? {};
      this.openBearers.push(openJson.bearer);
      await this.sendMux(session, this.openAckMessage());
    }
  }

  private openAckMessage(): OutboundMessage {
    return {
      type: MuxFrameType.OPEN_ACK,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: {
        manifest: {
          rpc: {},
          optionalRpc: {},
          stream: buildStreamManifest(
            emptyStreamRegistry,
            SERVES_EVERY_INSTALLED_MAJOR,
          ),
        },
        capabilities: [SESSION_CAPABILITY_RESUME],
      },
      binary: null,
    };
  }

  private readonly plainWires = new Map<
    Leg,
    { readonly reassembler: ChunkReassembler; sent: number }
  >();

  /** The pool speaks the mux directly, with no Noise channel behind an attach_ack. */
  private handlePlainData(leg: Leg, data: Uint8Array): void {
    let wire = this.plainWires.get(leg);
    if (wire === undefined) {
      wire = { reassembler: new ChunkReassembler(undefined), sent: 0 };
      this.plainWires.set(leg, wire);
    }
    const message = wire.reassembler.accept(decodeMuxFrame(data));
    if (
      message === null ||
      message.streamId !== SESSION_CONTROL_STREAM_ID ||
      message.type !== MuxFrameType.OPEN
    ) {
      return;
    }
    this.openBearers.push((message.json ?? {}).bearer);
    const source = new OutboundChunkSource(
      this.openAckMessage(),
      () => {
        const current = wire.sent;
        wire.sent += 1;
        return current;
      },
      false,
    );
    while (!source.done && !leg.closed) {
      leg.onmessage?.({
        type: "binary",
        data: encodeMuxFrame(source.nextFrame()),
      });
    }
  }

  private async sendMux(
    session: HostSession,
    message: OutboundMessage,
  ): Promise<void> {
    const source = new OutboundChunkSource(
      message,
      () => {
        const current = session.seqByStream.get(message.streamId) ?? 0;
        session.seqByStream.set(message.streamId, current + 1);
        return current;
      },
      false,
    );
    while (!source.done) {
      const plaintext = encodeMuxFrame(source.nextFrame());
      session.ledger.append(plaintext);
      await this.sealAndDeliver(session, plaintext);
    }
  }

  private async sealAndDeliver(
    session: HostSession,
    plaintext: Uint8Array,
  ): Promise<void> {
    if (session.noise === null) {
      throw new Error("no established noise session");
    }
    const bytes = await session.noise.encrypt(plaintext, EMPTY_AD);
    const leg = session.leg;
    if (leg === null || leg.closed) {
      return;
    }
    leg.onmessage?.({ type: "binary", data: bytes });
  }
}

interface NativeEvent {
  readonly data: string | ArrayBuffer;
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

let currentRelay: FakeRelay | null = null;

/** The global WebSocket the real stream factory builds once the gate grants. */
class FakeNativeWebSocket implements NativeSurface {
  static readonly instances: FakeNativeWebSocket[] = [];

  binaryType = "blob";
  readonly leg: Leg | null;
  private readonly listeners = new Map<
    string,
    Array<(event: NativeEvent) => void>
  >();

  constructor(readonly url: string) {
    FakeNativeWebSocket.instances.push(this);
    this.leg =
      url === HOLDER_URL || currentRelay === null
        ? null
        : currentRelay.attach(this, url);
  }

  addEventListener(type: string, listener: (event: NativeEvent) => void): void {
    const existing = this.listeners.get(type);
    if (existing === undefined) {
      this.listeners.set(type, [listener]);
    } else {
      existing.push(listener);
    }
  }

  send(data: string | Uint8Array): void {
    this.leg?.send(data);
  }

  close(): void {
    this.leg?.close();
  }

  fire(
    type: string,
    data: string | ArrayBuffer,
    code: number,
    reason: string,
  ): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data, code, reason, wasClean: false });
    }
  }
}

// ---- Session fixture --------------------------------------------------------- //

const emptyRpcRegistry: VersionedRpcRegistry = defineVersionedRpcRegistry({});
const emptyStreamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({});

class RecordingEvidence<
  Kind extends RemoteSessionTransportKind,
> implements RemoteSessionEvidence<Kind> {
  /** The fake time of each refusal, in report order. */
  readonly refusals: number[] = [];

  /** The attempt id and fake time of each indeterminate outcome. */
  readonly indeterminates: {
    readonly attemptId: string;
    readonly at: number;
  }[] = [];

  sessionEstablished(): void {}
  sessionLost(): void {}
  reportDialSuccess(): void {}
  reportRestartIntent(): void {}

  reportDialIndeterminate(_hostId: string, attemptId: string): void {
    this.indeterminates.push({ attemptId, at: Date.now() });
  }

  reportDialRefusal(): void {
    this.refusals.push(Date.now());
  }
}

const relayAuth: RemoteSessionAuth = {
  missingOpenAuthCause: "missing-host-credential",
  readOpenAuth: () => ({
    bearer: "gate-bearer",
    authz: null,
    fingerprint: "gate-bearer",
  }),
  readCredentialUpdateBearer: () => "gate-bearer",
  currentFingerprint: () => "gate-bearer",
  revalidateForReconnect: null,
};

const poolAuth: PoolSessionAuth = {
  missingOpenAuthCause: "missing-bearer",
  readOpenAuth: () => ({ bearer: "gate-bearer", fingerprint: "gate-bearer" }),
  readCredentialUpdateBearer: () => "gate-bearer",
  currentFingerprint: () => "gate-bearer",
  revalidateForReconnect: null,
};

type Session = RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry>;

interface GrantCalls {
  count: number;
}

interface RelayFixture {
  readonly session: Session;
  readonly evidence: RecordingEvidence<"remote-relay">;
  readonly grants: GrantCalls;
}

function countingGrants(relay: FakeRelay): {
  readonly provider: AttachGrantProvider;
  readonly calls: GrantCalls;
} {
  const calls: GrantCalls = { count: 0 };
  return {
    calls,
    provider: () => {
      calls.count += 1;
      const grant = `grant-${calls.count}`;
      relay.recordMint(grant, Date.now(), GRANT_LIFETIME_SECONDS);
      return Promise.resolve({
        kind: "ok" as const,
        grant: { grant, expiresInSeconds: GRANT_LIFETIME_SECONDS },
      });
    },
  };
}

const USER_A = "user-a";
const USER_B = "user-b";

function userFixture(userId: string): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return { ...base, user: { ...base.user, id: userId } };
}

function signIn(
  provider: DefaultRequestContextProvider,
  userId: string,
  bearerToken: string,
): void {
  provider.setSignedIn({
    user: userFixture(userId),
    bearerToken,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

/** What a composition root wires: a live read of whichever context is current. */
function liveBearer(
  provider: DefaultRequestContextProvider,
): BearerSourceProvider {
  return () => provider.current()?.credentials ?? null;
}

type TransportView = IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
>;

const POOL_ENTRY: PoolHostDirectoryEntry = {
  hostId: "pool",
  label: "pool",
  kind: "pool",
  websocketUrl: POOL_URL,
  version: null,
  transportDialability: "dialable",
};

/** The session redial backoff after a dropped leg. */
const REDIAL_MS = 1_000;

describe("RemoteSession attach-ack budget and the dial gate", () => {
  const opened: Session[] = [];
  const views: TransportView[] = [];
  const mintAuthorizations: Array<string | null> = [];
  let relay: FakeRelay;

  async function holdEverySlot(): Promise<FakeNativeWebSocket[]> {
    const factory = createWhatwgStreamWebSocketFactory();
    for (let slot = 0; slot < SLOTS; slot += 1) {
      factory.create(HOLDER_URL, "interactive");
    }
    await step(0);
    expect(hostDialGate.stats().connecting).toBe(SLOTS);
    return FakeNativeWebSocket.instances.filter(
      (native) => native.url === HOLDER_URL,
    );
  }

  /**
   * Milliseconds after `origin` at which each refusal was reported, leaving
   * out the first `alreadyReported` ones: a dropped leg is itself reported as
   * a refusal, and that is not the subject of the claim test.
   */
  function refusalOffsets(
    evidence: RecordingEvidence<RemoteSessionTransportKind>,
    origin: number,
    alreadyReported: number,
  ): number[] {
    return evidence.refusals.slice(alreadyReported).map((at) => at - origin);
  }

  function buildRelayFixture(hostId: string): RelayFixture {
    const evidence = new RecordingEvidence<"remote-relay">();
    const grants = countingGrants(relay);
    let nextRequestId = 0;
    const session: Session = new RemoteSession({
      hostId,
      attachBaseUrl: ATTACH_URL,
      hostStaticPublicKey: relay.publicKey,
      grantProvider: grants.provider,
      auth: relayAuth,
      clock: null,
      rpcRegistry: emptyRpcRegistry,
      streamRegistry: emptyStreamRegistry,
      webSocketFactory: createWhatwgStreamWebSocketFactory(),
      requestId: () => `gate-req-${(nextRequestId += 1)}`,
      evidence,
      onNegotiatedMethods: null,
      servedStreamMajors: {},
      unaryResponseMs: 30_000,
      clientIdentity: TEST_CLIENT_IDENTITY,
      livenessProbe: null,
      mintMemberCredential: null,
    });
    opened.push(session);
    return { session, evidence, grants: grants.calls };
  }

  /**
   * The authn attach-grant endpoint, answered with a grant the fake relay
   * knows, and the Authorization header of every request it receives.
   */
  function stubGrantEndpoint(): void {
    mintAuthorizations.length = 0;
    let minted = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        mintAuthorizations.push(
          new Headers(init?.headers).get("Authorization"),
        );
        minted += 1;
        const grant = `http-grant-${minted}`;
        relay.recordMint(grant, Date.now(), GRANT_LIFETIME_SECONDS);
        return new Response(
          JSON.stringify({
            grant,
            role: "client",
            expires_in: GRANT_LIFETIME_SECONDS,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
  }

  /** A host session built the way a composition root builds it, for user-a. */
  function buildHostTransport(
    hostId: string,
    bearer: BearerSourceProvider,
  ): TransportView {
    let nextRequestId = 0;
    const transport = createRemoteHostTransport({
      clientIdentity: TEST_CLIENT_IDENTITY,
      hostId,
      userId: USER_A,
      relayAttachUrl: ATTACH_URL,
      authnBaseUrl: "https://authn.test",
      hostPublicKey: Buffer.from(relay.publicKey).toString("hex"),
      bearer,
      openAuth: "user-bearer",
      cloudAuthorized: () => true,
      auth: null,
      clock: null,
      rpcRegistry: emptyRpcRegistry,
      streamRegistry: emptyStreamRegistry,
      webSocketFactory: createWhatwgStreamWebSocketFactory(),
      requestId: () => `gate-client-req-${(nextRequestId += 1)}`,
      proactiveWakeEligible: true,
      mintMemberCredential: null,
      evidence: NO_TRANSPORT_EVIDENCE,
    });
    if (transport === null) {
      throw new Error("the host transport did not build");
    }
    views.push(transport.session);
    return transport.session;
  }

  /** The server pool session, for user-a. */
  function buildPoolTransport(bearer: BearerSourceProvider): TransportView {
    let nextRequestId = 0;
    const transport = createPoolHostTransport({
      entry: POOL_ENTRY,
      userId: USER_A,
      bearer,
      cloudAuthorized: () => true,
      auth: null,
      clock: null,
      rpcRegistry: emptyRpcRegistry,
      streamRegistry: emptyStreamRegistry,
      webSocketFactory: createWhatwgStreamWebSocketFactory(),
      requestId: () => `gate-pool-req-${(nextRequestId += 1)}`,
      clientIdentity: TEST_CLIENT_IDENTITY,
      proactiveWakeEligible: true,
    });
    if (transport === null) {
      throw new Error("the pool transport did not build");
    }
    views.push(transport.session);
    return transport.session;
  }

  /** Lets an attach reach its OPEN frame, stopping before the redial backoff. */
  async function untilOpenFrameOrBackoff(): Promise<void> {
    for (let turn = 0; turn < 3 && relay.openBearers.length === 0; turn += 1) {
      await step(250);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    countWebCrypto();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
    relay = new FakeRelay();
    currentRelay = relay;
  });

  afterEach(async () => {
    for (const session of opened.splice(0)) {
      session.close();
    }
    for (const view of views.splice(0)) {
      view.close();
    }
    retireAllRemoteSessions();
    // A real socket reports its close after close() is called; the fake does
    // not, so every slot still held is handed back here.
    for (const native of FakeNativeWebSocket.instances) {
      native.fire("close", "", 1006, "test-cleanup");
    }
    await step(0);
    expect(hostDialGate.stats()).toMatchObject({ connecting: 0, queued: 0 });
    currentRelay = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not count time queued for a dial slot against an initial relay attach", async () => {
    const holders = await holdEverySlot();
    const { session, evidence, grants } =
      buildRelayFixture("host-queued-attach");
    session.start();
    // The relay socket exists, and waits for a slot, once Noise has begun.
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);
    const queuedAt = Date.now();
    await step(QUEUED_FOR_MS);

    expect(refusalOffsets(evidence, queuedAt, 0)).toEqual([]);
    expect(grants.count).toBe(1);
    expect(relay.legs).toHaveLength(0);

    holders[0].fire("close", "", 1006, "released");
    await advanceUntil(() => session.isReady(), 5_000);

    expect(refusalOffsets(evidence, queuedAt, 0)).toEqual([]);
    expect(relay.legs).toHaveLength(1);
  });

  it("times the attach ack from the socket open, not from the dial request", async () => {
    relay.autoOpen = "hold";
    const { session, evidence } = buildRelayFixture("host-late-open");
    session.start();
    await advanceUntil(() => relay.legs.length === 1, 5_000);

    await step(5_000);
    relay.openLeg(relay.legs[0], "plain");
    const openedAt = Date.now();

    await step(ATTACH_ACK_TIMEOUT_MS - 1);
    expect(refusalOffsets(evidence, openedAt, 0)).toEqual([]);
    await step(1);

    expect(refusalOffsets(evidence, openedAt, 0)).toEqual([
      ATTACH_ACK_TIMEOUT_MS,
    ]);
  });

  it("does not count time queued for a dial slot against a direct pool attach", async () => {
    const holders = await holdEverySlot();
    const evidence = new RecordingEvidence<"pool-direct">();
    let nextRequestId = 0;
    const session: Session = new RemoteSession({
      hostId: "host-queued-pool",
      poolUrl: POOL_URL,
      auth: poolAuth,
      clock: null,
      rpcRegistry: emptyRpcRegistry,
      streamRegistry: emptyStreamRegistry,
      webSocketFactory: createWhatwgStreamWebSocketFactory(),
      requestId: () => `gate-pool-req-${(nextRequestId += 1)}`,
      evidence,
      onNegotiatedMethods: null,
      servedStreamMajors: {},
      unaryResponseMs: 30_000,
      clientIdentity: TEST_CLIENT_IDENTITY,
      livenessProbe: null,
    });
    opened.push(session);
    relay.autoOpen = "plain";
    session.start();
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);
    const queuedAt = Date.now();
    await step(QUEUED_FOR_MS);

    expect(refusalOffsets(evidence, queuedAt, 0)).toEqual([]);
    expect(relay.legs).toHaveLength(0);

    holders[0].fire("close", "", 1006, "released");
    await advanceUntil(() => relay.legs.length === 1, 5_000);
    await step(0);

    expect(refusalOffsets(evidence, queuedAt, 0)).toEqual([]);
    expect(relay.legs[0].binarySends).toBeGreaterThan(0);
  });

  it("does not count time queued for a dial slot against a relink claim dial", async () => {
    const { session, evidence, grants } =
      buildRelayFixture("host-queued-claim");
    session.start();
    await advanceUntil(() => session.isReady(), 5_000);
    const hostSession = relay.host();
    expect(grants.count).toBe(1);

    expect(evidence.refusals).toEqual([]);
    const holders = await holdEverySlot();
    relay.dropLeg(1006, "net");
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);
    const queuedAt = Date.now();
    const reportedAtDrop = evidence.refusals.length;
    await step(QUEUED_FOR_MS);

    expect(refusalOffsets(evidence, queuedAt, reportedAtDrop)).toEqual([]);
    expect(grants.count).toBe(2);
    expect(relay.legs).toHaveLength(1);

    holders[0].fire("close", "", 1006, "released");
    await advanceUntil(() => relay.resumes.length === 1, 5_000);
    await advanceUntil(() => session.isReady(), 5_000);

    expect(refusalOffsets(evidence, queuedAt, reportedAtDrop)).toEqual([]);
    expect(relay.legs).toHaveLength(2);
    expect(relay.legs[1].claim).toBe(`${hostSession.sid}:${hostSession.key}`);
    expect(relay.sessions).toHaveLength(1);
  });

  it("retires a dial whose grant expired in the queue as indeterminate, then attaches on a fresh grant", async () => {
    const holders = await holdEverySlot();
    const { session, evidence, grants } = buildRelayFixture(
      "host-expired-attach",
    );
    session.start();
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);
    const queuedAt = Date.now();
    await step(GRANT_LIFETIME_MS + 1_000);
    expect(refusalOffsets(evidence, queuedAt, 0)).toEqual([]);
    expect(grants.count).toBe(1);

    holders[0].fire("close", "", 1006, "released");
    await advanceUntil(() => relay.legs.length === 1, 5_000);
    await step(0);

    expect(refusalOffsets(evidence, queuedAt, 0)).toEqual([]);
    expect(evidence.indeterminates).toHaveLength(1);

    await advanceUntil(() => grants.count === 2, 30_000);
    await advanceUntil(() => session.isReady(), 30_000);

    expect(refusalOffsets(evidence, queuedAt, 0)).toEqual([]);
    expect(grants.count).toBe(2);
  });

  it("retires a claim dial whose grant expired in the queue as indeterminate, then claims again on a fresh grant", async () => {
    const { session, evidence, grants } =
      buildRelayFixture("host-expired-claim");
    session.start();
    await advanceUntil(() => session.isReady(), 5_000);
    const hostSession = relay.host();
    expect(grants.count).toBe(1);

    const holders = await holdEverySlot();
    relay.dropLeg(1006, "net");
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);
    const queuedAt = Date.now();
    const reportedAtDrop = evidence.refusals.length;
    const indeterminateAtDrop = evidence.indeterminates.length;
    await step(GRANT_LIFETIME_MS + 1_000);
    expect(refusalOffsets(evidence, queuedAt, reportedAtDrop)).toEqual([]);
    expect(grants.count).toBe(2);

    holders[0].fire("close", "", 1006, "released");
    await advanceUntil(() => relay.legs.length === 2, 5_000);
    await step(0);

    expect(refusalOffsets(evidence, queuedAt, reportedAtDrop)).toEqual([]);
    expect(evidence.indeterminates).toHaveLength(indeterminateAtDrop + 1);

    await advanceUntil(() => relay.resumes.length === 1, 60_000);
    await advanceUntil(() => session.isReady(), 5_000);

    expect(refusalOffsets(evidence, queuedAt, reportedAtDrop)).toEqual([]);
    expect(grants.count).toBe(3);
    expect(relay.sessions).toHaveLength(1);
    expect(relay.legs[relay.legs.length - 1].claim).toBe(
      `${hostSession.sid}:${hostSession.key}`,
    );
  });

  it("still reports a refusal when an admitted dial on a live grant fails before it opens", async () => {
    relay.autoOpen = "fail";
    const { session, evidence } = buildRelayFixture("host-failed-upgrade");
    session.start();
    await advanceUntil(() => relay.legs.length === 1, 5_000);
    await step(0);

    expect(evidence.refusals).toHaveLength(1);
    expect(evidence.indeterminates).toEqual([]);
  });

  it("still reports a refusal when a live leg drops after its grant expired", async () => {
    const { session, evidence } = buildRelayFixture("host-live-leg-drop");
    session.start();
    await advanceUntil(() => session.isReady(), 5_000);

    await step(GRANT_LIFETIME_MS + 1_000);
    expect(session.isReady()).toBe(true);
    const reportedBeforeDrop = evidence.refusals.length;

    relay.dropLeg(1006, "net");
    await step(0);

    expect(
      evidence.refusals.length - reportedBeforeDrop,
    ).toBeGreaterThanOrEqual(1);
  });

  it("still reports a refusal when a claim dial on a fresh grant fails before open, after the first grant expired", async () => {
    const { session, evidence, grants } = buildRelayFixture(
      "host-fresh-claim-fails",
    );
    session.start();
    await advanceUntil(() => session.isReady(), 5_000);
    await step(GRANT_LIFETIME_MS + 1_000);
    expect(session.isReady()).toBe(true);
    const grantsBeforeDrop = grants.count;

    relay.autoOpen = "fail";
    relay.dropLeg(1006, "net");
    const reportedAtDrop = evidence.refusals.length;
    await advanceUntil(() => relay.legs.length === 2, 5_000);
    await step(0);

    expect(grants.count).toBe(grantsBeforeDrop + 1);
    expect(evidence.refusals.length).toBeGreaterThan(reportedAtDrop);
  });
  it("sends no other-identity bearer in the OPEN frame when the account switched during the queued attach", async () => {
    const provider = new DefaultRequestContextProvider({ origin: "renderer" });
    signIn(provider, USER_A, "token-a");
    stubGrantEndpoint();
    const holders = await holdEverySlot();
    const view = buildHostTransport(
      "host-switched-attach",
      liveBearer(provider),
    );
    view.start();
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);

    signIn(provider, USER_B, "token-b");
    await step(QUEUED_FOR_MS);
    holders[0].fire("close", "", 1006, "released");
    await untilOpenFrameOrBackoff();

    expect(relay.openBearers).not.toContain("token-b");
    expect(mintAuthorizations).not.toContain("Bearer token-b");
  });

  it("opens with the new token after a same-user re-sign-in during the queued attach", async () => {
    const provider = new DefaultRequestContextProvider({ origin: "renderer" });
    signIn(provider, USER_A, "token-a");
    stubGrantEndpoint();
    const holders = await holdEverySlot();
    const view = buildHostTransport(
      "host-resigned-attach",
      liveBearer(provider),
    );
    view.start();
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);

    signIn(provider, USER_A, "token-a2");
    await step(QUEUED_FOR_MS);
    holders[0].fire("close", "", 1006, "released");
    await advanceUntil(() => relay.openBearers.length === 1, 5_000);

    expect(relay.openBearers).toEqual(["token-a2"]);
  });

  it("mints no grant and sends no OPEN for another identity when the account switched before the next dial", async () => {
    const provider = new DefaultRequestContextProvider({ origin: "renderer" });
    signIn(provider, USER_A, "token-a");
    stubGrantEndpoint();
    const view = buildHostTransport(
      "host-switched-redial",
      liveBearer(provider),
    );
    view.start();
    await advanceUntil(() => relay.openBearers.length === 1, 5_000);
    expect(relay.openBearers).toEqual(["token-a"]);
    const mintsBeforeSwitch = mintAuthorizations.length;

    signIn(provider, USER_B, "token-b");
    relay.dropLeg(1006, "cut");
    await step(REDIAL_MS + 500);
    await step(REDIAL_MS + 500);

    expect(mintAuthorizations.slice(mintsBeforeSwitch)).not.toContain(
      "Bearer token-b",
    );
    expect(relay.openBearers).not.toContain("token-b");
  });

  it("sends no other-identity bearer to the pool when the account switched during the queued attach", async () => {
    relay.autoOpen = "plain";
    const provider = new DefaultRequestContextProvider({ origin: "renderer" });
    signIn(provider, USER_A, "token-a");
    const holders = await holdEverySlot();
    const view = buildPoolTransport(liveBearer(provider));
    view.start();
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);

    signIn(provider, USER_B, "token-b");
    await step(QUEUED_FOR_MS);
    holders[0].fire("close", "", 1006, "released");
    await untilOpenFrameOrBackoff();

    expect(relay.openBearers).not.toContain("token-b");
  });

  it("opens the pool with the new token after a same-user re-sign-in during the queued attach", async () => {
    relay.autoOpen = "plain";
    const provider = new DefaultRequestContextProvider({ origin: "renderer" });
    signIn(provider, USER_A, "token-a");
    const holders = await holdEverySlot();
    const view = buildPoolTransport(liveBearer(provider));
    view.start();
    await advanceUntil(() => hostDialGate.stats().queued === 1, 5_000);

    signIn(provider, USER_A, "token-a2");
    await step(QUEUED_FOR_MS);
    holders[0].fire("close", "", 1006, "released");
    await advanceUntil(() => relay.openBearers.length === 1, 5_000);

    expect(relay.openBearers).toEqual(["token-a2"]);
  });
});
