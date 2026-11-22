import { z } from "zod";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  UNARY_CAPABILITY_IDEMPOTENCY_KEY,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
} from "@traycer/protocol/framework/index";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  hostTokenBearerFor,
  trackHostTokenMints,
  type TrackedHostTokens,
} from "@traycer-clients/shared/auth/host-token-lease";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  defineFallbackMethodDegrade,
  defineRpcContract,
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import type { HostDoorObserver, HostDoorStateKind } from "../host-door-state";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "@traycer/protocol/host-transport/websocket";
import {
  HostRequestAbortedError,
  isTargetAnswer,
  mayHaveReachedHost,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import type { IWebSocketFactory } from "../ws-factory";
import {
  heldTokenRefused,
  signInForLocalRow,
  createReleasedHostMemory,
  type ReleasedHostMemory,
  type ReleasedSignOnRow,
  type ReleasedUnaryCause,
  type ReleasedUnarySignOn,
} from "../released-sign-on";
import type { HostRequestAuthority, IHostMessenger } from "../host-messenger";
import {
  HostTransportFailureError,
  RetryableTransportError,
} from "../host-messenger";
import { createRetryingMessenger } from "../retrying-messenger";
import { WsRpcClient } from "../ws-rpc-client";
import { createAuthAwareMessenger } from "../auth-aware-messenger";
import type { RefusalAwareAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  getNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "../negotiated-manifest-registry";

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const echo2V10 = defineRpcContract({
  method: "host.echo2",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

/** `host.echo2` degrades to `host.echo` against a host that does not advertise it. */
const unaryRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.echo2": {
    degrade: defineFallbackMethodDegrade<
      typeof echo2V10,
      typeof echoV10,
      "host.echo"
    >({
      kind: "fallback",
      to: { method: "host.echo", major: 1, minor: 0 },
      adaptRequest: (request) => request,
      adaptResponse: (response) => response,
    }),
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echo2V10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

/** The method the call under test names; `host.echo2` is the one that degrades. */
let calledMethod: "host.echo" | "host.echo2" = "host.echo";
/** A reporter that appends the name of each report to `log`, in order. */
function recordingEvidence(log: string[]): TransportEvidenceReporter {
  const record = (name: string) => () => {
    log.push(name);
  };
  return {
    sessionEstablished: record("sessionEstablished"),
    sessionLost: record("sessionLost"),
    reportDialSuccess: record("dialSuccess"),
    reportDialRefusal: record("dialRefusal"),
    reportDialTimeout: record("dialTimeout"),
    reportDialIndeterminate: record("dialIndeterminate"),
    reportCompatVerdict: record("compatVerdict"),
    reportRestartIntent: record("restartIntent"),
  };
}
/** The idempotency key the driven call carries; none unless a test sets one. */
let callKey: string | null = null;

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const SIGN_IN = "person-sign-in";
const WAIT = { timeout: 2_000, interval: 10 };
const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

const PERSONAL_ROW: ReleasedSignOnRow = {
  owner: { kind: "user", id: USER_ID },
  sandbox: null,
};
const TEAM_ROW: ReleasedSignOnRow = {
  owner: { kind: "team", id: "team-1", name: "Team" },
  sandbox: null,
};
const OTHER_USER_ROW: ReleasedSignOnRow = {
  owner: { kind: "user", id: "someone-else" },
  sandbox: null,
};

class UnarySocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** A dial the transport refused before the socket opened. */
  fireClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.({ code, reason, wasClean });
  }
}

function readFrame(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("frame was not an object");
  }
  const frame: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    frame[key] = entry;
  }
  return frame;
}

function readManifest(manifest: unknown): Record<string, unknown> {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  )
    throw new Error("the manifest was not an object");
  const entries: Record<string, unknown> = {};
  for (const [method, version] of Object.entries(manifest))
    entries[method] = version;
  return entries;
}

function openToken(socket: UnarySocket): unknown {
  return readFrame(socket.sent[0]).token;
}

function releasedRefusal(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "released-host-token-refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function namedRefusal(
  doorReason: "not_admitted" | "owner_sign_in" | "token_expired",
): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason,
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function expiredJwt(nowMs: number): {
  readonly token: string;
  readonly expiresAtMs: number;
} {
  const expiresAtMs = nowMs - ELEVEN_MINUTES_MS;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
  ).toString("base64url");
  return { token: `${header}.${payload}.`, expiresAtMs };
}

/** Authn never answers: every mint for the pair stays pending. */
function blackHoledTokens(): {
  readonly tokens: TrackedHostTokens;
  readonly mintCalls: () => number;
} {
  let mintCalls = 0;
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      mintCalls += 1;
      return new Promise<HostTokenMintOutcome>(() => undefined);
    },
    signIn: () => SIGN_IN,
    now: () => Date.now(),
  });
  return {
    tokens: trackHostTokenMints(source, memory),
    mintCalls: () => mintCalls,
  };
}

/** A mint that answers when the test says so. */
function deferredMint(): {
  readonly mint: () => Promise<HostTokenMintOutcome>;
  readonly answer: (outcome: HostTokenMintOutcome) => void;
} {
  let answer: (outcome: HostTokenMintOutcome) => void = () => undefined;
  const pending = new Promise<HostTokenMintOutcome>((resolve) => {
    answer = resolve;
  });
  return { mint: () => pending, answer: (outcome) => answer(outcome) };
}

function recordingDoor(): {
  readonly door: HostDoorObserver;
  readonly refusals: FatalErrorDetails[];
  readonly states: HostDoorStateKind[];
  readonly admissions: () => number;
} {
  const refusals: FatalErrorDetails[] = [];
  const states: HostDoorStateKind[] = [];
  let admissions = 0;
  return {
    refusals,
    states,
    admissions: () => admissions,
    door: {
      refused: (details) => {
        refusals.push(details);
      },
      admitted: () => {
        admissions += 1;
        return () => undefined;
      },
    },
  };
}

function sourceOf(outcomes: readonly HostTokenMintOutcome[]): {
  readonly source: HostTokenSource;
  readonly tokens: TrackedHostTokens;
} {
  const queue = [...outcomes];
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      const outcome = queue.shift();
      if (outcome === undefined) throw new Error("unexpected host-token mint");
      return Promise.resolve(outcome);
    },
    signIn: () => SIGN_IN,
    now: () => Date.now(),
  });
  return { source, tokens: trackHostTokenMints(source, memory) };
}

/**
 * An unverified session: `signIn` returns null, so the mint ends `no-sign-in`
 * and authn is never asked. The call's bearer lease is still the stored sign-in.
 */
async function unverifiedSource(
  held: { readonly token: string; readonly expiresAtMs: number } | null,
): Promise<{
  readonly tokens: TrackedHostTokens;
  readonly mintCalls: () => number;
}> {
  let mintCalls = 0;
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      mintCalls += 1;
      return Promise.resolve({
        kind: "unavailable",
        detail: "authn was asked",
      });
    },
    signIn: () => null,
    now: () => Date.now(),
  });
  if (held !== null) await holdExpired(source, held);
  return {
    tokens: trackHostTokenMints(source, memory),
    mintCalls: () => mintCalls,
  };
}

async function holdExpired(
  source: HostTokenSource,
  token: { readonly token: string; readonly expiresAtMs: number },
): Promise<void> {
  await source.adopt(
    USER_ID,
    mockLocalHostEntry.hostId,
    token,
    source.era(USER_ID),
    () => true,
  );
}

interface EchoSettlement {
  readonly kind: "fulfilled";
  readonly value: { readonly echoed: string };
}

interface EchoRejection {
  readonly kind: "rejected";
  readonly error: unknown;
}

type EchoResult = EchoSettlement | EchoRejection;

interface DrivenCall {
  readonly client: WsRpcClient<typeof unaryRegistry>;
  readonly sockets: UnarySocket[];
  readonly refusals: FatalErrorDetails[];
  readonly states: HostDoorStateKind[];
  /** How many connections the door was told the host admitted. */
  readonly admissions: () => number;
  /** What the client reported to the selection authority, by report name. */
  readonly evidence: readonly string[];
  readonly settled: Promise<EchoResult>;
  finished: boolean;
}

function requestEcho(
  client: WsRpcClient<typeof unaryRegistry>,
): Promise<EchoResult> {
  return requestEchoUntil(client, new AbortController().signal);
}

function requestEchoUntil(
  client: Pick<IHostMessenger<typeof unaryRegistry>, "request">,
  abortSignal: AbortSignal,
): Promise<EchoResult> {
  return client
    .request(
      calledMethod,
      { message: "hi" },
      {
        idempotencyKey: callKey,
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        authority: {
          endpoint: {
            hostId: mockLocalHostEntry.hostId,
            websocketUrl: mockLocalHostEntry.websocketUrl,
          },
          bearer: new MutableBearerLease(SIGN_IN, USER_ID),
          abortSignal,
        },
      },
    )
    .then(
      (value) => ({ kind: "fulfilled" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
}

function driveCall(
  tokens: TrackedHostTokens,
  row: ReleasedSignOnRow | null,
): DrivenCall {
  return driveCallUntil(tokens, row, new AbortController().signal);
}

function driveCallUntil(
  tokens: TrackedHostTokens,
  row: ReleasedSignOnRow | null,
  abortSignal: AbortSignal,
): DrivenCall {
  return driveCallOnRow({
    tokens,
    readRow: () => row,
    recovery: null,
    hosts: null,
    abortSignal,
  });
}

/** The client's ask of whether a sign-in may go, as `signInForLocalRow` answers it. */
type SignOnFor = (
  authority: HostRequestAuthority,
  cause: ReleasedUnaryCause,
) => ReleasedUnarySignOn | null;

/** The real client, with the row read live at every decision and the sign-in's refresh and the host memory the test gives it. */
function driveCallOnRow(input: {
  readonly tokens: TrackedHostTokens;
  readonly readRow: () => ReleasedSignOnRow | null;
  readonly recovery: StreamAuthRevalidator | null;
  readonly hosts: ReleasedHostMemory | null;
  readonly abortSignal: AbortSignal;
}): DrivenCall {
  return driveCallThroughSignOn(
    input,
    (answerFromRow) => answerFromRow,
    (client) => client,
  );
}

/** As {@link driveCallOnRow}, with the answer from the row passed through `throughSignOn` before the client sees it. */
function driveCallThroughSignOn(
  input: {
    readonly tokens: TrackedHostTokens;
    readonly readRow: () => ReleasedSignOnRow | null;
    readonly recovery: StreamAuthRevalidator | null;
    readonly hosts: ReleasedHostMemory | null;
    readonly abortSignal: AbortSignal;
  },
  throughSignOn: (answerFromRow: SignOnFor) => SignOnFor,
  messengerOver: (
    client: WsRpcClient<typeof unaryRegistry>,
  ) => IHostMessenger<typeof unaryRegistry>,
): DrivenCall {
  const { tokens, readRow, recovery, hosts, abortSignal } = input;
  const sockets: UnarySocket[] = [];
  /** What this client told the selection authority, in order, by report name. */
  const evidence: string[] = [];
  const factory: IWebSocketFactory = {
    create: () => {
      const socket = new UnarySocket();
      sockets.push(socket);
      return socket;
    },
  };
  const { door, refusals, states, admissions } = recordingDoor();
  let nextRequestId = 0;
  const client = new WsRpcClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: unaryRegistry,
    requestId: () => `req-${(nextRequestId += 1)}`,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    frameTimeoutMs: 1_000,
    hostAttestationWindowMs: 0,
    evidence: recordingEvidence(evidence),
    hostBearerFor: hostTokenBearerFor(tokens, (_hostId, kind) => {
      states.push(kind);
    }),
    releasedSignOnFor: throughSignOn(
      signInForLocalRow(readRow, recovery, tokens),
    ),
    releasedHosts: hosts ?? memory,
    heldTokenRefusedFor: (authority, presented, instance) =>
      heldTokenRefused(
        tokens,
        authority.bearer.identity.userId,
        instance,
        presented,
      ),
    forgetHeldRefusalFor: (authority) =>
      tokens.forgetHeldRefused(
        authority.bearer.identity.userId,
        authority.endpoint.hostId,
      ),
    doorFor: () => door,
  });
  const driven: DrivenCall = {
    client,
    sockets,
    refusals,
    states,
    admissions,
    evidence,
    finished: false,
    settled: requestEchoUntil(messengerOver(client), abortSignal),
  };
  void driven.settled.then(
    () => {
      driven.finished = true;
    },
    () => {
      driven.finished = true;
    },
  );
  return driven;
}

async function openAndRead(
  socket: UnarySocket,
): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0), WAIT);
  return readFrame(socket.sent[0]);
}

function ackAndEcho(socket: UnarySocket, open: Record<string, unknown>): void {
  socket.fireMessage({
    kind: "openAck",
    manifest: open.manifest,
    optionalManifest: open.optionalManifest,
  });
}

async function answerEcho(socket: UnarySocket): Promise<void> {
  await vi.waitFor(
    () => expect(socket.sent.length).toBeGreaterThanOrEqual(2),
    WAIT,
  );
  const request = readFrame(socket.sent[1]);
  socket.fireMessage({
    kind: "response",
    requestId: request.requestId,
    method: request.method,
    schemaVersion: request.schemaVersion,
    result: { echoed: "hi" },
    error: null,
  });
}

const clients: WsRpcClient<typeof unaryRegistry>[] = [];

/** The memory of the host's answers that every client and token source of a case shares. */
let memory: ReleasedHostMemory = createReleasedHostMemory();

beforeEach(() => {
  memory = createReleasedHostMemory();
  calledMethod = "host.echo";
  callKey = null;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.releaseIdleLocalSessions();
  vi.useRealTimers();
});

describe("local unary while authn cannot mint", () => {
  it("carries the held expired token without waiting for another mint", async () => {
    const expired = expiredJwt(Date.now());
    let secondMint: Promise<HostTokenMintOutcome> | null = null;
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        if (secondMint === null) {
          secondMint = new Promise<HostTokenMintOutcome>(() => undefined);
          return Promise.resolve({
            kind: "unavailable",
            detail: "authn offline",
          });
        }
        return secondMint;
      },
      signIn: () => SIGN_IN,
      now: () => Date.now(),
    });
    await holdExpired(source, expired);
    const tokens = trackHostTokenMints(source, memory);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, false, {
      signal: null,
      owner: memory.currentInstance(mockLocalHostEntry.hostId),
    });
    const driven = driveCall(tokens, PERSONAL_ROW);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      { timeout: 500, interval: 10 },
    );
    const socket = driven.sockets[0];
    if (socket === undefined) throw new Error("dial missing");
    const open = await openAndRead(socket);
    expect(open.token).toBe(expired.token);
    expect(driven.finished).toBe(false);
    ackAndEcho(socket, open);
    await answerEcho(socket);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.states).toEqual([]);
    expect(driven.sockets).toHaveLength(1);
  });

  it("opens a released host with the sign-in after the held expired token is refused", async () => {
    const expired = expiredJwt(Date.now());
    const { source, tokens } = sourceOf([
      { kind: "unavailable", detail: "authn offline" },
      { kind: "unavailable", detail: "authn still offline" },
    ]);
    await holdExpired(source, expired);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, false, {
      signal: null,
      owner: memory.currentInstance(mockLocalHostEntry.hostId),
    });
    const driven = driveCall(tokens, PERSONAL_ROW);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const first = driven.sockets[0];
    if (first === undefined) throw new Error("host-token dial missing");
    const refused = await openAndRead(first);
    expect(refused.token).toBe(expired.token);
    first.fireMessage(releasedRefusal());
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const second = driven.sockets[1];
    if (second === undefined) throw new Error("sign-in dial missing");
    const open = await openAndRead(second);
    expect(open.token).toBe(SIGN_IN);
    ackAndEcho(second, open);
    await answerEcho(second);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.refusals).toEqual([]);
  });

  it("opens with the placeholder, then the sign-in, when none is held", async () => {
    const { tokens } = sourceOf([
      { kind: "unavailable", detail: "authn offline" },
      { kind: "unavailable", detail: "authn still offline" },
    ]);
    const driven = driveCall(tokens, null);
    clients.push(driven.client);
    await admitAfterProbe(driven);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.refusals).toEqual([]);
  });

  it("opens with the placeholder, then the sign-in, when the mint says this computer has no row", async () => {
    const { tokens } = sourceOf([
      { kind: "not-admitted" },
      { kind: "not-admitted" },
    ]);
    const driven = driveCall(tokens, null);
    clients.push(driven.client);
    await admitAfterProbe(driven);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.refusals).toEqual([]);
  });

  it.each([
    { name: "a team row", row: TEAM_ROW },
    { name: "another person's row", row: OTHER_USER_ROW },
  ])("never sends the sign-in for $name", async ({ row }) => {
    const { tokens } = sourceOf([{ kind: "not-admitted" }]);
    const driven = driveCall(tokens, row);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const probe = driven.sockets[0];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    // One probe socket and no sign-in.
    expect(driven.sockets.map(openToken)).toEqual([NO_HOST_TOKEN_PROBE]);
    expect(driven.states).toEqual(["not-admitted"]);
  });

  it("sends only the placeholder when a current host names the probe's refusal", async () => {
    const { tokens } = sourceOf([
      { kind: "unavailable", detail: "authn offline" },
      { kind: "unavailable", detail: "authn still offline" },
    ]);
    const driven = driveCall(tokens, null);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const socket = driven.sockets[0];
    if (socket === undefined) throw new Error("probe dial missing");
    const open = await openAndRead(socket);
    expect(open.token).toBe(NO_HOST_TOKEN_PROBE);
    socket.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    expect(driven.refusals).toEqual([]);
    const again = requestEcho(driven.client);
    expect(await again).toMatchObject({ kind: "rejected" });
    expect(driven.sockets).toHaveLength(1);
    expect(openToken(socket)).toBe(NO_HOST_TOKEN_PROBE);
  });

  it("probes again after the first probe dial is refused, then admits with the sign-in", async () => {
    const { tokens } = sourceOf([
      { kind: "unavailable", detail: "authn offline" },
      { kind: "unavailable", detail: "authn still offline" },
      { kind: "unavailable", detail: "authn still offline" },
    ]);
    const driven = driveCall(tokens, null);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const refusedDial = driven.sockets[0];
    if (refusedDial === undefined) throw new Error("probe dial missing");
    refusedDial.fireClose(1006, "connection refused", false);
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    expect(refusedDial.sent).toEqual([]);
    expect(driven.refusals).toEqual([]);

    const again = requestEcho(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const probe = driven.sockets[1];
    if (probe === undefined) throw new Error("second probe dial missing");
    const probed = await openAndRead(probe);
    expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(releasedRefusal());
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    const signIn = driven.sockets[2];
    if (signIn === undefined) throw new Error("sign-in dial missing");
    const open = await openAndRead(signIn);
    expect(open.token).toBe(SIGN_IN);
    ackAndEcho(signIn, open);
    await answerEcho(signIn);
    expect(await again).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.refusals).toEqual([]);
  });

  it("carries the held expired token when the session is unverified", async () => {
    const expired = expiredJwt(Date.now());
    const { tokens, mintCalls } = await unverifiedSource(expired);
    const driven = driveCall(tokens, PERSONAL_ROW);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const socket = driven.sockets[0];
    if (socket === undefined) throw new Error("dial missing");
    const open = await openAndRead(socket);
    expect(open.token).toBe(expired.token);
    expect(mintCalls()).toBe(0);
    ackAndEcho(socket, open);
    await answerEcho(socket);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.states).toEqual([]);
    expect(driven.sockets).toHaveLength(1);
  });

  it("opens with the placeholder, then the sign-in, when the session is unverified and none is held", async () => {
    const { tokens, mintCalls } = await unverifiedSource(null);
    const driven = driveCall(tokens, null);
    clients.push(driven.client);
    await admitAfterProbe(driven);
    expect(mintCalls()).toBe(0);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.refusals).toEqual([]);
  });

  it("opens a released host with the sign-in after the unverified session's held token is refused", async () => {
    const expired = expiredJwt(Date.now());
    const { tokens, mintCalls } = await unverifiedSource(expired);
    const driven = driveCall(tokens, PERSONAL_ROW);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const first = driven.sockets[0];
    if (first === undefined) throw new Error("host-token dial missing");
    const refused = await openAndRead(first);
    expect(refused.token).toBe(expired.token);
    first.fireMessage(releasedRefusal());
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const second = driven.sockets[1];
    if (second === undefined) throw new Error("sign-in dial missing");
    const open = await openAndRead(second);
    expect(open.token).toBe(SIGN_IN);
    expect(mintCalls()).toBe(0);
    ackAndEcho(second, open);
    await answerEcho(second);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.refusals).toEqual([]);
  });

  it("sends only the placeholder when a current host names the refusal and the session is unverified", async () => {
    const { tokens, mintCalls } = await unverifiedSource(null);
    const driven = driveCall(tokens, null);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const socket = driven.sockets[0];
    if (socket === undefined) throw new Error("probe dial missing");
    const open = await openAndRead(socket);
    expect(open.token).toBe(NO_HOST_TOKEN_PROBE);
    socket.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    expect(driven.refusals).toEqual([]);
    const again = requestEcho(driven.client);
    expect(await again).toMatchObject({ kind: "rejected" });
    expect(mintCalls()).toBe(0);
    expect(driven.sockets).toHaveLength(1);
    expect(openToken(socket)).toBe(NO_HOST_TOKEN_PROBE);
  });

  it.each([
    {
      name: "a released host",
      answer: () => releasedRefusal(),
      followedBySignIn: true,
    },
    {
      name: "a current personal host",
      answer: () => namedRefusal("owner_sign_in"),
      followedBySignIn: true,
    },
    {
      name: "a current team host",
      answer: () => namedRefusal("not_admitted"),
      followedBySignIn: false,
    },
  ])(
    "dials $name at once while authn never answers",
    async ({ answer, followedBySignIn }) => {
      vi.useFakeTimers();
      const { tokens, mintCalls } = blackHoledTokens();
      const driven = driveCall(tokens, null);
      clients.push(driven.client);
      // No timer is advanced: the first socket must not wait on the mint.
      await vi.advanceTimersByTimeAsync(0);
      expect(mintCalls()).toBe(1);
      expect(driven.sockets).toHaveLength(1);
      const probe = driven.sockets[0];
      if (probe === undefined) throw new Error("probe dial missing");
      expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      probe.fireMessage(answer());
      if (!followedBySignIn) {
        await vi.advanceTimersByTimeAsync(0);
        // The host named its reason: the call waits on the mint for a
        // host-only token and is never handed the sign-in.
        expect(driven.finished).toBe(false);
        expect(driven.sockets.map(openToken)).toEqual([NO_HOST_TOKEN_PROBE]);
        return;
      }
      await vi.waitFor(() => expect(driven.sockets).toHaveLength(2));
      const second = driven.sockets[1];
      if (second === undefined) throw new Error("sign-in dial missing");
      const open = await openAndRead(second);
      expect(open.token).toBe(SIGN_IN);
      ackAndEcho(second, open);
      await answerEcho(second);
      expect(await driven.settled).toEqual({
        kind: "fulfilled",
        value: { echoed: "hi" },
      });
      expect(driven.refusals).toEqual([]);
    },
  );

  it("hands a current personal host the sign-in once and the host-only token on the next call, once the mint answers ok", async () => {
    vi.useFakeTimers();
    const minted = "host-only-token-after-mint";
    const mint = deferredMint();
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: mint.mint,
      signIn: () => SIGN_IN,
      now: () => Date.now(),
    });
    const tokens = trackHostTokenMints(source, memory);
    const first = driveCall(tokens, null);
    clients.push(first.client);
    await vi.advanceTimersByTimeAsync(0);
    const probe = first.sockets[0];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    await vi.waitFor(() => expect(first.sockets).toHaveLength(2));
    const invited = first.sockets[1];
    if (invited === undefined) throw new Error("sign-in dial missing");
    const open = await openAndRead(invited);
    expect(open.token).toBe(SIGN_IN);
    ackAndEcho(invited, open);
    await answerEcho(invited);
    expect(await first.settled).toMatchObject({ kind: "fulfilled" });

    mint.answer({
      kind: "ok",
      token: { token: minted, expiresAtMs: Date.now() + 60_000 },
    });
    await vi.waitFor(() =>
      expect(source.current(USER_ID, mockLocalHostEntry.hostId)?.token).toBe(
        minted,
      ),
    );
    const next = requestEcho(first.client);
    await vi.waitFor(() => expect(first.sockets).toHaveLength(3));
    const third = first.sockets[2];
    if (third === undefined) throw new Error("host-token dial missing");
    const carried = await openAndRead(third);
    ackAndEcho(third, carried);
    await answerEcho(third);
    expect(await next).toMatchObject({ kind: "fulfilled" });
    expect(first.sockets.map(openToken)).toEqual([
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
      minted,
    ]);
  });

  it("completes a call to a current team host on the token the pending mint buys, once the host has named its reason", async () => {
    vi.useFakeTimers();
    const minted = "host-only-token-bought-in-the-call";
    const mint = deferredMint();
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: mint.mint,
      signIn: () => SIGN_IN,
      now: () => Date.now(),
    });
    const driven = driveCall(trackHostTokenMints(source, memory), null);
    clients.push(driven.client);
    await vi.advanceTimersByTimeAsync(0);
    const probe = driven.sockets[0];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("not_admitted"));
    await vi.advanceTimersByTimeAsync(0);
    expect(driven.sockets).toHaveLength(1);
    expect(driven.finished).toBe(false);

    mint.answer({
      kind: "ok",
      token: { token: minted, expiresAtMs: Date.now() + 60_000 },
    });
    await vi.waitFor(() => expect(driven.sockets).toHaveLength(2));
    const second = driven.sockets[1];
    if (second === undefined) throw new Error("host-token dial missing");
    const open = await openAndRead(second);
    expect(open.token).toBe(minted);
    ackAndEcho(second, open);
    await answerEcho(second);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(driven.sockets.map(openToken)).toEqual([
      NO_HOST_TOKEN_PROBE,
      minted,
    ]);
    expect(driven.refusals).toEqual([]);
  });

  it("rejects at once with the abort error when the call is aborted while it waits for the post-probe mint, and the mint still completes", async () => {
    vi.useFakeTimers();
    const mint = deferredMint();
    let mintCompleted = false;
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () =>
        mint.mint().then((outcome) => {
          mintCompleted = true;
          return outcome;
        }),
      signIn: () => SIGN_IN,
      now: () => Date.now(),
    });
    const abort = new AbortController();
    const driven = driveCallUntil(
      trackHostTokenMints(source, memory),
      null,
      abort.signal,
    );
    clients.push(driven.client);
    await vi.advanceTimersByTimeAsync(0);
    const probe = driven.sockets[0];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("not_admitted"));
    await vi.advanceTimersByTimeAsync(0);
    expect(driven.finished).toBe(false);

    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(driven.finished).toBe(true);
    const outcome = await driven.settled;
    if (outcome.kind !== "rejected") throw new Error("call was admitted");
    expect(outcome.error).toBeInstanceOf(HostRequestAbortedError);

    mint.answer({
      kind: "ok",
      token: { token: "late-host-token", expiresAtMs: Date.now() + 60_000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mintCompleted).toBe(true);
    expect(source.current(USER_ID, mockLocalHostEntry.hostId)?.token).toBe(
      "late-host-token",
    );
    expect(driven.sockets).toHaveLength(1);
  });

  it("rejects with one door notification and dials no probe or second socket when a locally usable host-only token is refused as expired", async () => {
    // A clock-skewed host calls a token this clock still reads as usable
    // expired; a mint failed for the pair earlier, so the held-token rule is
    // live for it.
    const usable = {
      token: "locally-usable-host-token",
      expiresAtMs: Date.now() + 60_000,
    };
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () =>
        Promise.resolve({ kind: "unavailable", detail: "authn offline" }),
      signIn: () => SIGN_IN,
      now: () => Date.now(),
    });
    const tokens = trackHostTokenMints(source, memory);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, true, {
      signal: null,
      owner: memory.currentInstance(mockLocalHostEntry.hostId),
    });
    await source.adopt(
      USER_ID,
      mockLocalHostEntry.hostId,
      usable,
      source.era(USER_ID),
      () => true,
    );
    const driven = driveCall(tokens, PERSONAL_ROW);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const socket = driven.sockets[0];
    if (socket === undefined) throw new Error("host-token dial missing");
    expect((await openAndRead(socket)).token).toBe(usable.token);
    socket.fireMessage(namedRefusal("token_expired"));
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    // The recovery that asks for a fresh mint lies above this client; here no
    // probe and no sign-in is dialed.
    expect(driven.refusals.map((details) => details.doorReason)).toEqual([
      "token_expired",
    ]);
    expect(driven.sockets).toHaveLength(1);
  });
});

describe("a held host-only token that the host refuses as expired, while authn is down", () => {
  const held = expiredJwt(Date.now());

  /** Authn has not answered the pair's mint, and the token held for it is past its end. */
  async function heldWhileAuthnDown(): Promise<TrackedHostTokens> {
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () =>
        Promise.resolve({ kind: "unavailable", detail: "authn offline" }),
      signIn: () => SIGN_IN,
      now: () => Date.now(),
    });
    await holdExpired(source, held);
    const tokens = trackHostTokenMints(source, memory);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, true, {
      signal: null,
      owner: memory.currentInstance(mockLocalHostEntry.hostId),
    });
    return tokens;
  }

  async function refuseHeldTokenAsExpired(driven: DrivenCall): Promise<void> {
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const socket = driven.sockets[0];
    if (socket === undefined) throw new Error("host-token dial missing");
    expect((await openAndRead(socket)).token).toBe(held.token);
    socket.fireMessage(namedRefusal("token_expired"));
  }

  it("dials no probe on a team row and fails the call with the host's token_expired refusal, which the door hears once", async () => {
    const driven = driveCall(await heldWhileAuthnDown(), TEAM_ROW);
    clients.push(driven.client);
    await refuseHeldTokenAsExpired(driven);
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({
      kind: "rejected",
      error: { fatalDetails: { doorReason: "token_expired" } },
    });
    expect(driven.refusals.map((details) => details.doorReason)).toEqual([
      "token_expired",
    ]);
    expect(driven.sockets).toHaveLength(1);
  });

  it("still probes on the person's own row", async () => {
    const driven = driveCall(await heldWhileAuthnDown(), PERSONAL_ROW);
    clients.push(driven.client);
    await refuseHeldTokenAsExpired(driven);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const probe = driven.sockets[1];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
  });

  it("probes a team row at once when no host-only token is held and its mint has not answered", async () => {
    const { tokens } = blackHoledTokens();
    const driven = driveCall(tokens, TEAM_ROW);
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const probe = driven.sockets[0];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    expect(driven.finished).toBe(false);
  });
});

describe("a sign-in is written only where its row and its host still allow it", () => {
  const NO_HOST_TOKEN_MESSAGE = "No host-only token is held for this host";

  function everythingWritten(driven: DrivenCall): string {
    return driven.sockets.flatMap((socket) => socket.sent).join("\n");
  }

  function signInOpens(driven: DrivenCall): number {
    return driven.sockets.filter((socket) =>
      socket.sent.some((raw) => readFrame(raw).token === SIGN_IN),
    ).length;
  }

  /** Resolves every pending sign-in refresh as the test says; each one is asked of authn. */
  function pendingRefreshes(): {
    readonly recovery: StreamAuthRevalidator;
    readonly asked: () => number;
    readonly answer: (outcome: "rotated" | "network-error") => void;
  } {
    const pending: Array<(outcome: "rotated" | "network-error") => void> = [];
    const refresh = (): Promise<"rotated" | "network-error"> =>
      new Promise((resolve) => {
        pending.push(resolve);
      });
    return {
      recovery: {
        revalidateForReconnect: refresh,
        revalidateRefused: refresh,
      },
      asked: () => pending.length,
      answer: (outcome) => {
        for (const resolve of pending.splice(0)) resolve(outcome);
      },
    };
  }

  async function heldExpiredReleasedHost(): Promise<TrackedHostTokens> {
    const { source, tokens } = sourceOf([
      { kind: "unavailable", detail: "authn offline" },
      { kind: "unavailable", detail: "authn still offline" },
    ]);
    await holdExpired(source, expiredJwt(Date.now()));
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, false, {
      signal: null,
      owner: memory.currentInstance(mockLocalHostEntry.hostId),
    });
    return tokens;
  }

  /** The held token is refused the released way: the call plans the person's sign-in on a second socket. */
  async function planReleasedSignIn(driven: DrivenCall): Promise<void> {
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const first = driven.sockets[0];
    if (first === undefined) throw new Error("host-token dial missing");
    await openAndRead(first);
    first.fireMessage(releasedRefusal());
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
  }

  /** The probe is answered `owner_sign_in`: the call plans the owner's sign-in on a second socket. */
  async function planOwnerSignIn(driven: DrivenCall): Promise<void> {
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const probe = driven.sockets[0];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
  }

  async function untilEnded(
    driven: DrivenCall,
    sockets: number,
  ): Promise<void> {
    await vi.waitFor(
      () =>
        expect(driven.finished || driven.sockets.length >= sockets).toBe(true),
      WAIT,
    );
  }

  it("writes no sign-in on any socket when the row moves to a team between the released plan and the OPEN", async () => {
    let row: ReleasedSignOnRow = PERSONAL_ROW;
    const driven = driveCallOnRow({
      tokens: await heldExpiredReleasedHost(),
      readRow: () => row,
      recovery: null,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planReleasedSignIn(driven);
    row = TEAM_ROW;
    driven.sockets[1]?.fireOpen();
    await untilEnded(driven, 3);
    expect(everythingWritten(driven)).not.toContain(SIGN_IN);
  });

  it("writes no second sign-in when the row moves to a team while the released sign-in's refresh runs", async () => {
    let row: ReleasedSignOnRow = PERSONAL_ROW;
    const refreshes = pendingRefreshes();
    const driven = driveCallOnRow({
      tokens: await heldExpiredReleasedHost(),
      readRow: () => row,
      recovery: refreshes.recovery,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planReleasedSignIn(driven);
    const signInSocket = driven.sockets[1];
    if (signInSocket === undefined) throw new Error("sign-in dial missing");
    expect((await openAndRead(signInSocket)).token).toBe(SIGN_IN);
    signInSocket.fireMessage(releasedRefusal());
    await vi.waitFor(() => expect(refreshes.asked()).toBe(1), WAIT);
    row = TEAM_ROW;
    refreshes.answer("rotated");
    await untilEnded(driven, 3);
    // Any later dial is opened too, so what it would write is on the wire; a
    // dial whose sign-in is withdrawn writes nothing and ends the call.
    for (const socket of driven.sockets.slice(2)) socket.fireOpen();
    await vi.waitFor(
      () => expect(driven.finished || signInOpens(driven) > 1).toBe(true),
      WAIT,
    );
    expect(signInOpens(driven)).toBe(1);
  });

  it("writes no sign-in on any socket when the row moves to a team between the owner's invitation and the OPEN", async () => {
    let row: ReleasedSignOnRow = PERSONAL_ROW;
    const driven = driveCallOnRow({
      tokens: blackHoledTokens().tokens,
      readRow: () => row,
      recovery: null,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planOwnerSignIn(driven);
    row = TEAM_ROW;
    driven.sockets[1]?.fireOpen();
    await untilEnded(driven, 3);
    expect(everythingWritten(driven)).not.toContain(SIGN_IN);
  });

  it("writes no second sign-in when the row moves to a team while the owner's sign-in refresh runs", async () => {
    let row: ReleasedSignOnRow = PERSONAL_ROW;
    const refreshes = pendingRefreshes();
    const driven = driveCallOnRow({
      tokens: blackHoledTokens().tokens,
      readRow: () => row,
      recovery: refreshes.recovery,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planOwnerSignIn(driven);
    const signInSocket = driven.sockets[1];
    if (signInSocket === undefined) throw new Error("sign-in dial missing");
    expect((await openAndRead(signInSocket)).token).toBe(SIGN_IN);
    signInSocket.fireMessage(namedRefusal("token_expired"));
    await vi.waitFor(() => expect(refreshes.asked()).toBe(1), WAIT);
    row = TEAM_ROW;
    refreshes.answer("rotated");
    await untilEnded(driven, 3);
    // Any later dial is opened too, so what it would write is on the wire; a
    // dial whose sign-in is withdrawn writes nothing and ends the call.
    for (const socket of driven.sockets.slice(2)) socket.fireOpen();
    await vi.waitFor(
      () => expect(driven.finished || signInOpens(driven) > 1).toBe(true),
      WAIT,
    );
    expect(signInOpens(driven)).toBe(1);
  });

  it("dials the host-only token, never the invited sign-in, when a mint answers ok while the invited socket is dialing", async () => {
    const minting = deferredMint();
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: minting.mint,
      signIn: () => SIGN_IN,
      now: () => Date.now(),
    });
    const tokens = trackHostTokenMints(source, memory);
    const driven = driveCall(tokens, PERSONAL_ROW);
    clients.push(driven.client);
    await planOwnerSignIn(driven);
    minting.answer({
      kind: "ok",
      token: {
        token: "minted-host-token",
        expiresAtMs: Date.now() + 3_600_000,
      },
    });
    await vi.waitFor(
      () =>
        expect(tokens.current(USER_ID, mockLocalHostEntry.hostId)?.token).toBe(
          "minted-host-token",
        ),
      WAIT,
    );
    driven.sockets[1]?.fireOpen();
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    const next = driven.sockets[2];
    if (next === undefined) throw new Error("host-token redial missing");
    expect((await openAndRead(next)).token).toBe("minted-host-token");
    expect(everythingWritten(driven)).not.toContain(SIGN_IN);
  });

  it("sends the placeholder, not the refreshed sign-in, on the attempt after the invited sign-in is refused token_expired", async () => {
    const refreshes = pendingRefreshes();
    const driven = driveCallOnRow({
      tokens: blackHoledTokens().tokens,
      readRow: () => PERSONAL_ROW,
      recovery: refreshes.recovery,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planOwnerSignIn(driven);
    const signInSocket = driven.sockets[1];
    if (signInSocket === undefined) throw new Error("sign-in dial missing");
    expect((await openAndRead(signInSocket)).token).toBe(SIGN_IN);
    signInSocket.fireMessage(namedRefusal("token_expired"));
    await vi.waitFor(() => expect(refreshes.asked()).toBe(1), WAIT);
    refreshes.answer("rotated");
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    const next = driven.sockets[2];
    if (next === undefined) throw new Error("next attempt missing");
    expect((await openAndRead(next)).token).toBe(NO_HOST_TOKEN_PROBE);
    expect(signInOpens(driven)).toBe(1);
  });

  it("tells the door nothing when the owner's invited sign-in is refused bare", async () => {
    const driven = driveCall(blackHoledTokens().tokens, PERSONAL_ROW);
    clients.push(driven.client);
    await planOwnerSignIn(driven);
    const signInSocket = driven.sockets[1];
    if (signInSocket === undefined) throw new Error("sign-in dial missing");
    expect((await openAndRead(signInSocket)).token).toBe(SIGN_IN);
    signInSocket.fireMessage(releasedRefusal());
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    expect(driven.refusals).toEqual([]);
    expect(driven.states).toEqual([]);
  });

  it("ends with the host's refusal, having spent no refresh, when the sign-in's refresh never reaches authn", async () => {
    const refreshes = pendingRefreshes();
    const driven = driveCallOnRow({
      tokens: await heldExpiredReleasedHost(),
      readRow: () => PERSONAL_ROW,
      recovery: refreshes.recovery,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planReleasedSignIn(driven);
    const signInSocket = driven.sockets[1];
    if (signInSocket === undefined) throw new Error("sign-in dial missing");
    expect((await openAndRead(signInSocket)).token).toBe(SIGN_IN);
    signInSocket.fireMessage(releasedRefusal());
    await vi.waitFor(() => expect(refreshes.asked()).toBe(1), WAIT);
    refreshes.answer("network-error");
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({
      kind: "rejected",
      error: { fatalDetails: { reason: "released-host-token-refusal" } },
    });
    expect(driven.refusals).toEqual([]);
    expect(driven.sockets).toHaveLength(2);
  });

  /** A persistent session admitted on a usable host-only token while host process "100" is the one observed. */
  async function sessionAdmittedUnderProcess100(
    hosts: ReleasedHostMemory,
  ): Promise<{ readonly driven: DrivenCall; readonly session: UnarySocket }> {
    hosts.observeInstance(mockLocalHostEntry.hostId, "100");
    const { source, tokens } = sourceOf([]);
    await source.adopt(
      USER_ID,
      mockLocalHostEntry.hostId,
      { token: "usable-host-token", expiresAtMs: Date.now() + 3_600_000 },
      source.era(USER_ID),
      () => true,
    );
    const driven = driveCallOnRow({
      tokens,
      readRow: () => PERSONAL_ROW,
      recovery: null,
      hosts,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const session = driven.sockets[0];
    if (session === undefined) throw new Error("host-token dial missing");
    const open = await openAndRead(session);
    expect(open.token).toBe("usable-host-token");
    session.fireMessage({
      kind: "openAck",
      manifest: open.manifest,
      optionalManifest: open.optionalManifest,
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    await answerEcho(session);
    expect(await driven.settled).toMatchObject({ kind: "fulfilled" });
    return { driven, session };
  }

  it("dials a new socket and writes nothing on a persistent session admitted by a host process that was since replaced", async () => {
    const hosts = memory;
    const { driven, session } = await sessionAdmittedUnderProcess100(hosts);
    const writtenBefore = session.sent.length;
    hosts.observeInstance(mockLocalHostEntry.hostId, "200");
    void requestEcho(driven.client);
    await vi.waitFor(
      () =>
        expect(
          session.sent.length > writtenBefore || driven.sockets.length >= 2,
        ).toBe(true),
      WAIT,
    );
    expect(session.sent).toHaveLength(writtenBefore);
    expect(driven.sockets).toHaveLength(2);
  });

  it("sends a second call on the persistent session already admitted when the host process has not changed", async () => {
    const { driven, session } = await sessionAdmittedUnderProcess100(memory);
    const writtenBefore = session.sent.length;
    void requestEcho(driven.client);
    await vi.waitFor(
      () =>
        expect(
          session.sent.length > writtenBefore || driven.sockets.length >= 2,
        ).toBe(true),
      WAIT,
    );
    expect(session.sent.length).toBeGreaterThan(writtenBefore);
    expect(driven.sockets).toHaveLength(1);
  });

  it("applies no decline and plans no sign-in when the probe's answer comes from a host process that was since replaced, and redials the probe once", async () => {
    const hosts = memory;
    hosts.observeInstance(mockLocalHostEntry.hostId, "process-a");
    const { tokens } = sourceOf([
      { kind: "not-admitted" },
      { kind: "not-admitted" },
    ]);
    const driven = driveCallOnRow({
      tokens,
      readRow: () => PERSONAL_ROW,
      recovery: null,
      hosts,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const probe = driven.sockets[0];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    hosts.observeInstance(mockLocalHostEntry.hostId, "process-b");
    probe.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    // The stale answer declined nothing and planned nothing: the call probes again.
    expect(hosts.probeDeclined(USER_ID, mockLocalHostEntry.hostId)).toBe(false);
    expect(driven.finished).toBe(false);
    const redialed = driven.sockets[1];
    if (redialed === undefined) throw new Error("redial missing");
    expect((await openAndRead(redialed)).token).toBe(NO_HOST_TOKEN_PROBE);
    redialed.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({
      kind: "rejected",
      error: { message: NO_HOST_TOKEN_MESSAGE },
    });
    // The current process's own answer is the one that counts.
    expect(hosts.probeDeclined(USER_ID, mockLocalHostEntry.hostId)).toBe(true);
    expect(everythingWritten(driven)).not.toContain(SIGN_IN);
    expect(driven.sockets).toHaveLength(2);
  });

  it("marks nothing for the current host process and tells the door nothing when a refusal comes from one that was since replaced, and serves the redial", async () => {
    const hosts = memory;
    hosts.observeInstance(mockLocalHostEntry.hostId, "process-a");
    const { source, tokens } = sourceOf([]);
    await source.adopt(
      USER_ID,
      mockLocalHostEntry.hostId,
      { token: "usable-host-token", expiresAtMs: Date.now() + 3_600_000 },
      source.era(USER_ID),
      () => true,
    );
    const driven = driveCallOnRow({
      tokens,
      readRow: () => PERSONAL_ROW,
      recovery: null,
      hosts,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const socket = driven.sockets[0];
    if (socket === undefined) throw new Error("host-token dial missing");
    expect((await openAndRead(socket)).token).toBe("usable-host-token");
    hosts.observeInstance(mockLocalHostEntry.hostId, "process-b");
    socket.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    expect(hosts.namedReason(mockLocalHostEntry.hostId)).toBe(false);
    expect(driven.refusals).toEqual([]);
    const redialed = driven.sockets[1];
    if (redialed === undefined) throw new Error("redial missing");
    const open = await openAndRead(redialed);
    expect(open.token).toBe("usable-host-token");
    ackAndEcho(redialed, open);
    await answerEcho(redialed);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    expect(hosts.namedReason(mockLocalHostEntry.hostId)).toBe(false);
    expect(driven.refusals).toEqual([]);
    expect(everythingWritten(driven)).not.toContain(SIGN_IN);
    expect(driven.sockets).toHaveLength(2);
  });

  /** A bare refusal by host process "100" plans the sign-in; the replacement socket has not yet written its OPEN. */
  async function plannedByProcess100(hosts: ReleasedHostMemory): Promise<{
    readonly driven: DrivenCall;
    readonly replacement: UnarySocket;
  }> {
    hosts.observeInstance(mockLocalHostEntry.hostId, "100");
    const driven = driveCallOnRow({
      tokens: await heldExpiredReleasedHost(),
      readRow: () => PERSONAL_ROW,
      recovery: null,
      hosts,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planReleasedSignIn(driven);
    const replacement = driven.sockets[1];
    if (replacement === undefined) throw new Error("replacement dial missing");
    return { driven, replacement };
  }

  async function replacementWritesOrCallEnds(
    driven: DrivenCall,
    replacement: UnarySocket,
  ): Promise<void> {
    replacement.fireOpen();
    await vi.waitFor(
      () =>
        expect(
          replacement.sent.length > 0 ||
            driven.finished ||
            driven.sockets.length >= 3,
        ).toBe(true),
      WAIT,
    );
  }

  it("writes no sign-in on the replacement socket when the host process that refused the token bare was replaced before the socket's OPEN", async () => {
    const hosts = memory;
    const { driven, replacement } = await plannedByProcess100(hosts);
    hosts.observeInstance(mockLocalHostEntry.hostId, "200");
    await replacementWritesOrCallEnds(driven, replacement);
    expect(replacement.sent.join("\n")).not.toContain(SIGN_IN);
    expect(signInOpens(driven)).toBe(0);
  });

  it("still writes the person's sign-in on the replacement socket's OPEN when the host process has not changed since its bare refusal", async () => {
    const { driven, replacement } = await plannedByProcess100(memory);
    await replacementWritesOrCallEnds(driven, replacement);
    expect(openToken(replacement)).toBe(SIGN_IN);
  });

  it("writes no sign-in when another transport hears the host name a reason before the OPEN is written", async () => {
    const hosts = memory;
    const { driven, replacement } = await plannedByProcess100(hosts);
    hosts.refusedNamingReason(
      hosts.currentInstance(mockLocalHostEntry.hostId),
      false,
    );
    await replacementWritesOrCallEnds(driven, replacement);
    expect(replacement.sent.join("\n")).not.toContain(SIGN_IN);
    expect(signInOpens(driven)).toBe(0);
  });

  it("writes no sign-in on a persistent session once the row moves to a team before the invited call's request, drops the session and dials the call as a first dial", async () => {
    let row: ReleasedSignOnRow = PERSONAL_ROW;
    const expired = expiredJwt(Date.now());
    const { source, tokens } = sourceOf([
      { kind: "unavailable", detail: "authn offline" },
      { kind: "unavailable", detail: "authn still offline" },
    ]);
    await holdExpired(source, expired);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, false, {
      signal: null,
      owner: memory.currentInstance(mockLocalHostEntry.hostId),
    });
    const driven = driveCallThroughSignOn(
      {
        tokens,
        readRow: () => row,
        recovery: null,
        hosts: memory,
        abortSignal: new AbortController().signal,
      },
      // The row answers the invitation as a personal computer's, then becomes
      // a team's: everything that writes the sign-in afterwards reads the team's.
      (answerFromRow) => (authority, cause) => {
        const answer = answerFromRow(authority, cause);
        if (cause === "owner-sign-in") row = TEAM_ROW;
        return answer;
      },
      (client) => client,
    );
    clients.push(driven.client);
    // Call B: its host-only token is presented and the host admits a persistent session on it.
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const session = driven.sockets[0];
    if (session === undefined) throw new Error("host-token dial missing");
    const open = await openAndRead(session);
    expect(open.token).toBe(expired.token);
    session.fireMessage({
      kind: "openAck",
      manifest: open.manifest,
      optionalManifest: open.optionalManifest,
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    await answerEcho(session);
    expect(await driven.settled).toMatchObject({ kind: "fulfilled" });
    // The host then refuses that token, so call A probes and is invited to send the owner's sign-in.
    heldTokenRefused(
      tokens,
      USER_ID,
      memory.currentInstance(mockLocalHostEntry.hostId),
      expired.token,
    );
    void requestEcho(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const probe = driven.sockets[1];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    // The invited call is written once the person's computer is a team's.
    const opened = new Set<UnarySocket>();
    const openWhenDialed = (index: number): void => {
      const dialed = driven.sockets[index];
      if (dialed !== undefined && !opened.has(dialed)) {
        opened.add(dialed);
        dialed.fireOpen();
      }
    };
    await vi.waitFor(() => {
      openWhenDialed(2);
      expect(driven.sockets[2]?.sent.length ?? 0).toBeGreaterThan(0);
    }, WAIT);
    expect(session.sent.join("\n")).not.toContain(SIGN_IN);
    const firstDial = driven.sockets[2];
    if (firstDial === undefined) throw new Error("first dial missing");
    expect(openToken(firstDial)).not.toBe(SIGN_IN);
    // The session is out of reuse: once the first dial has answered as a host
    // without persistent sessions, a call with no sign-in dials a new socket
    // and writes nothing on B's session.
    ackAndEcho(firstDial, readFrame(firstDial.sent[0]));
    await answerEcho(firstDial);
    const writtenOnB = session.sent.length;
    void requestEcho(driven.client);
    await vi.waitFor(
      () =>
        expect(
          session.sent.length > writtenOnB || driven.sockets.length >= 4,
        ).toBe(true),
      WAIT,
    );
    expect(session.sent).toHaveLength(writtenOnB);
    expect(driven.sockets).toHaveLength(4);
  });

  it("writes no sign-in in discovery's first request when the row becomes a team's while the openAck is awaited", async () => {
    let row: ReleasedSignOnRow = PERSONAL_ROW;
    const driven = driveCallOnRow({
      tokens: await heldExpiredReleasedHost(),
      readRow: () => row,
      recovery: null,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planReleasedSignIn(driven);
    const replacement = driven.sockets[1];
    if (replacement === undefined) throw new Error("replacement dial missing");
    const open = await openAndRead(replacement);
    expect(open.token).toBe(SIGN_IN);
    // The sign-in is on the wire; the row moves while the host's answer is awaited.
    row = TEAM_ROW;
    replacement.fireMessage({
      kind: "openAck",
      manifest: open.manifest,
      optionalManifest: open.optionalManifest,
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    await vi.waitFor(
      () =>
        expect(
          replacement.sent.length > 1 ||
            driven.finished ||
            driven.sockets.length >= 3,
        ).toBe(true),
      WAIT,
    );
    expect(replacement.sent.slice(1).join("\n")).not.toContain(SIGN_IN);
  });

  it("writes no sign-in in a degraded request when the row becomes a team's while the openAck is awaited", async () => {
    calledMethod = "host.echo2";
    let row: ReleasedSignOnRow = PERSONAL_ROW;
    const driven = driveCallOnRow({
      tokens: await heldExpiredReleasedHost(),
      readRow: () => row,
      recovery: null,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await planReleasedSignIn(driven);
    const replacement = driven.sockets[1];
    if (replacement === undefined) throw new Error("replacement dial missing");
    const open = await openAndRead(replacement);
    expect(open.token).toBe(SIGN_IN);
    row = TEAM_ROW;
    // The host advertises only `host.echo`, so the call to `host.echo2` degrades to it.
    const advertised = Object.fromEntries(
      Object.entries(readManifest(open.manifest)).filter(
        ([method]) => method !== "host.echo2",
      ),
    );
    replacement.fireMessage({
      kind: "openAck",
      manifest: advertised,
      optionalManifest: open.optionalManifest,
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    await vi.waitFor(
      () =>
        expect(
          replacement.sent.length > 1 ||
            driven.finished ||
            driven.sockets.length >= 3,
        ).toBe(true),
      WAIT,
    );
    expect(replacement.sent.slice(1).join("\n")).not.toContain(SIGN_IN);
  });
});

describe("a held token's refusal", () => {
  it("stays on the newer held token when a late refusal of an older token arrives, so the newer one is not presented again", async () => {
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () =>
        Promise.resolve({ kind: "unavailable", detail: "authn offline" }),
      signIn: () => SIGN_IN,
      now: () => Date.now(),
    });
    await source.whenLoaded();
    const tokens = trackHostTokenMints(source, memory);
    const hostId = mockLocalHostEntry.hostId;
    for (const held of [
      { token: "older-host-token", expiresAtMs: Date.now() - 60_000 },
      { token: "newer-host-token", expiresAtMs: Date.now() - 30_000 },
    ]) {
      await source.adopt(
        USER_ID,
        hostId,
        held,
        source.era(USER_ID),
        () => true,
      );
    }

    heldTokenRefused(
      tokens,
      USER_ID,
      memory.currentInstance(hostId),
      "newer-host-token",
    );
    heldTokenRefused(
      tokens,
      USER_ID,
      memory.currentInstance(hostId),
      "older-host-token",
    );

    expect(tokens.heldRefused(USER_ID, hostId)).toBe(true);
  });
});

async function admitAfterProbe(driven: DrivenCall): Promise<void> {
  await vi.waitFor(
    () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
    WAIT,
  );
  const probe = driven.sockets[0];
  if (probe === undefined) throw new Error("probe dial missing");
  const probed = await openAndRead(probe);
  expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
  probe.fireMessage(releasedRefusal());
  await vi.waitFor(
    () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
    WAIT,
  );
  const second = driven.sockets[1];
  if (second === undefined) throw new Error("sign-in dial missing");
  const open = await openAndRead(second);
  expect(open.token).toBe(SIGN_IN);
  ackAndEcho(second, open);
  await answerEcho(second);
}

describe("a frame from a host process that was since replaced crosses nothing", () => {
  const HOST_ID = mockLocalHostEntry.hostId;

  async function usableTokens(): Promise<TrackedHostTokens> {
    const { source, tokens } = sourceOf([]);
    await source.adopt(
      USER_ID,
      HOST_ID,
      { token: "usable-host-token", expiresAtMs: Date.now() + 3_600_000 },
      source.era(USER_ID),
      () => true,
    );
    return tokens;
  }

  async function firstDialUnderProcess100(): Promise<{
    readonly driven: DrivenCall;
    readonly first: UnarySocket;
    readonly open: Record<string, unknown>;
  }> {
    resetNegotiatedManifests();
    memory.observeInstance(HOST_ID, "100");
    const driven = driveCallOnRow({
      tokens: await usableTokens(),
      readRow: () => PERSONAL_ROW,
      recovery: null,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const first = driven.sockets[0];
    if (first === undefined) throw new Error("first dial missing");
    return { driven, first, open: await openAndRead(first) };
  }

  /** B has a ready persistent session under process "100", and a second call is written on it. */
  async function secondCallWrittenOnSession(): Promise<{
    readonly driven: DrivenCall;
    readonly session: UnarySocket;
    readonly second: Promise<EchoResult>;
    readonly written: Record<string, unknown>;
  }> {
    const { driven, first, open } = await firstDialUnderProcess100();
    first.fireMessage({
      kind: "openAck",
      manifest: open.manifest,
      optionalManifest: open.optionalManifest,
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    await answerEcho(first);
    expect(await driven.settled).toMatchObject({ kind: "fulfilled" });
    const second = requestEcho(driven.client);
    await vi.waitFor(
      () => expect(first.sent.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    return {
      driven,
      session: first,
      second,
      written: readFrame(first.sent[2]),
    };
  }

  const ackFrame = (
    open: Record<string, unknown>,
    capabilities: readonly string[],
  ): unknown => ({
    kind: "openAck",
    manifest: open.manifest,
    optionalManifest: open.optionalManifest,
    capabilities,
  });

  it.each([
    {
      name: "an openAck that admits a persistent session",
      frame: (open: Record<string, unknown>): unknown =>
        ackFrame(open, [UNARY_CAPABILITY_PERSISTENT_SESSION]),
    },
    {
      name: "an openAck of a host without persistent sessions",
      frame: (open: Record<string, unknown>): unknown => ackFrame(open, []),
    },
    {
      name: "an openAck that covers none of the call's methods",
      frame: (open: Record<string, unknown>): unknown => ({
        kind: "openAck",
        manifest: {},
        optionalManifest: open.optionalManifest,
      }),
    },
    {
      name: "a fatal naming not_admitted",
      frame: (): unknown => namedRefusal("not_admitted"),
    },
  ])(
    "tells the door nothing, records no manifest and redials once on $name before the request is written",
    async ({ frame }) => {
      const { driven, first, open } = await firstDialUnderProcess100();
      memory.observeInstance(HOST_ID, "200");
      first.fireMessage(frame(open));
      await vi.waitFor(
        () => expect(driven.finished || driven.sockets.length >= 2).toBe(true),
        WAIT,
      );
      expect(driven.admissions()).toBe(0);
      expect(driven.refusals).toEqual([]);
      expect(getNegotiatedHostMethods(HOST_ID)).toBeNull();
      expect(driven.sockets.length).toBeGreaterThanOrEqual(2);
      expect(driven.finished).toBe(false);
      expect(first.sent).toHaveLength(1);
    },
  );

  it("pools later calls on one session after a stale ack of a host without persistent sessions, never latching the key to one socket per call", async () => {
    const { driven, first, open } = await firstDialUnderProcess100();
    memory.observeInstance(HOST_ID, "200");
    first.fireMessage(ackFrame(open, []));
    // The next call, before anything is said about a redial of the stale one.
    let nextSettled = false;
    void requestEcho(driven.client).then(() => {
      nextSettled = true;
    });
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const session = driven.sockets[1];
    if (session === undefined) throw new Error("pooled dial missing");
    const reopen = await openAndRead(session);
    session.fireMessage(
      ackFrame(reopen, [UNARY_CAPABILITY_PERSISTENT_SESSION]),
    );
    const answered = new Set<unknown>();
    const answerNewRequests = (): void => {
      for (const raw of session.sent) {
        const frame = readFrame(raw);
        if (frame.kind !== "request" || answered.has(frame.requestId)) continue;
        answered.add(frame.requestId);
        session.fireMessage({
          kind: "response",
          requestId: frame.requestId,
          method: frame.method,
          schemaVersion: frame.schemaVersion,
          result: { echoed: "hi" },
          error: null,
        });
      }
    };
    await vi.waitFor(() => {
      answerNewRequests();
      expect(nextSettled).toBe(true);
    }, WAIT);
    // A third call rides the same session: one socket does not serve one call.
    const writtenBefore = session.sent.length;
    void requestEcho(driven.client);
    await vi.waitFor(
      () =>
        expect(
          session.sent.length > writtenBefore || driven.sockets.length >= 3,
        ).toBe(true),
      WAIT,
    );
    expect(driven.sockets).toHaveLength(2);
    expect(session.sent.length).toBeGreaterThan(writtenBefore);
  });

  it("starts no refusal recovery in the app wrapper when a stale fatal naming not_admitted arrives", async () => {
    resetNegotiatedManifests();
    memory.observeInstance(HOST_ID, "100");
    const recoveries: Array<FatalErrorDetails | null> = [];
    const auth: RefusalAwareAuthRevalidator = {
      revalidateExpectedBearer: () => Promise.resolve("rejected"),
      revalidateRefusedBearer: (_bearer, _hostId, refusal) => {
        recoveries.push(refusal);
        return Promise.resolve("rejected");
      },
    };
    const driven = driveCallThroughSignOn(
      {
        tokens: await usableTokens(),
        readRow: () => PERSONAL_ROW,
        recovery: null,
        hosts: null,
        abortSignal: new AbortController().signal,
      },
      (answerFromRow) => answerFromRow,
      (client) => createAuthAwareMessenger(client, auth, "always"),
    );
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const first = driven.sockets[0];
    if (first === undefined) throw new Error("first dial missing");
    await openAndRead(first);
    memory.observeInstance(HOST_ID, "200");
    first.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(
      () => expect(driven.finished || driven.sockets.length >= 2).toBe(true),
      WAIT,
    );
    expect(recoveries).toEqual([]);
    expect(driven.sockets.length).toBeGreaterThanOrEqual(2);
    expect(driven.finished).toBe(false);
  });

  it("lets the response to a request already written on the session pass", async () => {
    const { driven, session, second, written } =
      await secondCallWrittenOnSession();
    memory.observeInstance(HOST_ID, "200");
    session.fireMessage({
      kind: "response",
      requestId: written.requestId,
      method: written.method,
      schemaVersion: written.schemaVersion,
      result: { echoed: "hi" },
      error: null,
    });
    expect(await second).toMatchObject({ kind: "fulfilled" });
    expect(driven.sockets).toHaveLength(1);
  });

  it("lets a method error answering a written request pass, and tells the door nothing", async () => {
    const { driven, session, second, written } =
      await secondCallWrittenOnSession();
    memory.observeInstance(HOST_ID, "200");
    session.fireMessage({
      kind: "response",
      requestId: written.requestId,
      method: written.method,
      schemaVersion: written.schemaVersion,
      result: null,
      error: { code: "RPC_ERROR", message: "the method failed" },
    });
    expect(await second).toMatchObject({
      kind: "rejected",
      error: { message: "the method failed" },
    });
    expect(driven.refusals).toEqual([]);
    expect(driven.sockets).toHaveLength(1);
  });

  /** The request frames every socket was sent, in the order the sockets were dialed. */
  function requestFramesWritten(
    driven: DrivenCall,
  ): Array<Record<string, unknown>> {
    return driven.sockets
      .flatMap((socket) => socket.sent.map(readFrame))
      .filter((frame) => frame.kind === "request");
  }

  /** Opens and acks each redial as a host with `capabilities` would, so a request re-sent on one is written. */
  function servingRedials(
    driven: DrivenCall,
    capabilities: readonly string[],
  ): () => void {
    const opened = new Set<UnarySocket>();
    const acked = new Set<UnarySocket>();
    return () => {
      for (const socket of driven.sockets.slice(1)) {
        if (!opened.has(socket)) {
          opened.add(socket);
          socket.fireOpen();
        } else if (!acked.has(socket) && socket.sent.length > 0) {
          acked.add(socket);
          socket.fireMessage(ackFrame(readFrame(socket.sent[0]), capabilities));
        }
      }
    };
  }

  function rejectionOf(result: EchoResult): unknown {
    if (result.kind !== "rejected") throw new Error("the call did not reject");
    return result.error;
  }

  interface WrittenRequest {
    readonly driven: DrivenCall;
    /** The socket the request was written on. */
    readonly socket: UnarySocket;
    readonly written: Record<string, unknown>;
    readonly outcome: Promise<EchoResult>;
    /** What the host's ack advertised, and so what a redial is acked with. */
    readonly capabilities: readonly string[];
  }

  /** A one-shot socket (a host without persistent sessions) carrying the request, written and unanswered. */
  async function writtenOnOneShotSocket(): Promise<WrittenRequest> {
    const { driven, first, open } = await firstDialUnderProcess100();
    first.fireMessage(ackFrame(open, []));
    await vi.waitFor(
      () => expect(first.sent.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    return {
      driven,
      socket: first,
      written: readFrame(first.sent[1]),
      outcome: driven.settled,
      capabilities: [],
    };
  }

  async function writtenOnPersistentSession(): Promise<WrittenRequest> {
    const { driven, session, second, written } =
      await secondCallWrittenOnSession();
    return {
      driven,
      socket: session,
      written,
      outcome: second,
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    };
  }

  const responseWithError = (
    written: Record<string, unknown>,
    error: Record<string, unknown>,
  ): unknown => ({
    kind: "response",
    requestId: written.requestId,
    method: written.method,
    schemaVersion: written.schemaVersion,
    result: null,
    error,
  });

  const staleAfterWrite = [
    {
      name: "a fatal naming not_admitted",
      frame: (): unknown => namedRefusal("not_admitted"),
    },
    {
      name: "a retryable per-request door refusal",
      frame: (written: Record<string, unknown>): unknown =>
        responseWithError(written, {
          code: "UNAUTHORIZED",
          message: "not admitted",
          retryable: true,
          doorReason: "not_admitted",
        }),
    },
    {
      name: "a non-retryable per-request door refusal",
      frame: (written: Record<string, unknown>): unknown =>
        responseWithError(written, {
          code: "UNAUTHORIZED",
          message: "not admitted",
          retryable: false,
          doorReason: "not_admitted",
        }),
    },
  ];
  const writtenOn = [
    { socketKind: "a one-shot socket", stage: writtenOnOneShotSocket },
    { socketKind: "a persistent session", stage: writtenOnPersistentSession },
  ];

  it.each(
    staleAfterWrite.flatMap((stale) =>
      writtenOn.map((on) => ({ ...stale, ...on })),
    ),
  )(
    "ends as a socket loss and writes the request on no second socket when $name from a replaced process arrives on $socketKind after the write",
    async ({ frame, stage }) => {
      const { driven, socket, written, outcome, capabilities } = await stage();
      let ended = false;
      void outcome.then(() => {
        ended = true;
      });
      const before = requestFramesWritten(driven).length;
      memory.observeInstance(HOST_ID, "200");
      socket.fireMessage(frame(written));
      const serveRedials = servingRedials(driven, capabilities);
      await vi.waitFor(() => {
        serveRedials();
        expect(requestFramesWritten(driven).length > before || ended).toBe(
          true,
        );
      }, WAIT);
      // An unkeyed request that may have run is never sent a second time.
      expect(requestFramesWritten(driven)).toHaveLength(before);
      const error = rejectionOf(await outcome);
      expect(error).toBeInstanceOf(HostTransportFailureError);
      expect(error).not.toBeInstanceOf(RetryableTransportError);
      expect(mayHaveReachedHost(error)).toBe(true);
      expect(isTargetAnswer(error)).toBe(false);
      expect(driven.refusals).toEqual([]);
    },
  );

  it("retries a keyed request with the same key when a fatal from a replaced process arrives after it was written", async () => {
    callKey = "key-written-before-stale-fatal";
    resetNegotiatedManifests();
    memory.observeInstance(HOST_ID, "100");
    const driven = driveCallThroughSignOn(
      {
        tokens: await usableTokens(),
        readRow: () => PERSONAL_ROW,
        recovery: null,
        hosts: null,
        abortSignal: new AbortController().signal,
      },
      (answerFromRow) => answerFromRow,
      (client) =>
        createRetryingMessenger(client, {
          maxRetries: 2,
          initialDelayMs: 0,
          maxDelayMs: 0,
          sleep: () => Promise.resolve(),
          random: () => 0,
        }),
    );
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const first = driven.sockets[0];
    if (first === undefined) throw new Error("first dial missing");
    const open = await openAndRead(first);
    first.fireMessage(ackFrame(open, [UNARY_CAPABILITY_IDEMPOTENCY_KEY]));
    await vi.waitFor(
      () => expect(first.sent.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    expect(readFrame(first.sent[1]).idempotencyKey).toBe(callKey);
    memory.observeInstance(HOST_ID, "200");
    first.fireMessage(namedRefusal("not_admitted"));
    const serveRedials = servingRedials(driven, [
      UNARY_CAPABILITY_IDEMPOTENCY_KEY,
    ]);
    await vi.waitFor(() => {
      serveRedials();
      expect(requestFramesWritten(driven)).toHaveLength(2);
    }, WAIT);
    expect(
      requestFramesWritten(driven).map((frame) => frame.idempotencyKey),
    ).toEqual([callKey, callKey]);
    const retry = driven.sockets[1];
    if (retry === undefined) throw new Error("retry dial missing");
    await answerEcho(retry);
    expect(await driven.settled).toMatchObject({ kind: "fulfilled" });
    expect(driven.refusals).toEqual([]);
  });

  async function dialedUnderProcess100(): Promise<{
    readonly driven: DrivenCall;
    readonly stale: UnarySocket;
  }> {
    resetNegotiatedManifests();
    memory.observeInstance(HOST_ID, "100");
    const driven = driveCallOnRow({
      tokens: await usableTokens(),
      readRow: () => PERSONAL_ROW,
      recovery: null,
      hosts: null,
      abortSignal: new AbortController().signal,
    });
    clients.push(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const stale = driven.sockets[0];
    if (stale === undefined) throw new Error("first dial missing");
    return { driven, stale };
  }

  it("reports no dial success and no live session for a socket whose host process was replaced before it opened, and redials once", async () => {
    const { driven, stale } = await dialedUnderProcess100();
    memory.observeInstance(HOST_ID, "200");
    stale.fireOpen();
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    expect(driven.evidence).toEqual([]);
    expect(driven.admissions()).toBe(0);
    expect(driven.finished).toBe(false);
    // The redial is a first dial to the current process, and the call proceeds on it.
    const redial = driven.sockets[1];
    if (redial === undefined) throw new Error("redial missing");
    const open = await openAndRead(redial);
    expect(open.token).toBe("usable-host-token");
    ackAndEcho(redial, open);
    await answerEcho(redial);
    expect(await driven.settled).toEqual({
      kind: "fulfilled",
      value: { echoed: "hi" },
    });
    // The redial's own open is the first thing reported (its close may follow).
    expect(driven.evidence.slice(0, 2)).toEqual([
      "dialSuccess",
      "sessionEstablished",
    ]);
    expect(driven.sockets).toHaveLength(2);
  });

  it.each([
    {
      name: "a close before it opened",
      fail: (stale: UnarySocket): void => {
        stale.fireClose(1006, "abnormal", false);
      },
    },
    {
      name: "a dial that timed out",
      fail: (): void => undefined,
    },
  ])(
    "reports nothing for the dial of a socket whose host process was replaced before it failed: $name",
    async ({ fail }) => {
      const { driven, stale } = await dialedUnderProcess100();
      memory.observeInstance(HOST_ID, "200");
      fail(stale);
      await vi.waitFor(
        () => expect(driven.finished || driven.sockets.length >= 2).toBe(true),
        { timeout: 5_000, interval: 20 },
      );
      expect(driven.evidence).toEqual([]);
    },
  );

  it("reports a per-request door refusal of the current owner to the door (control)", async () => {
    const { driven, session, written } = await secondCallWrittenOnSession();
    session.fireMessage({
      kind: "response",
      requestId: written.requestId,
      method: written.method,
      schemaVersion: written.schemaVersion,
      result: null,
      error: {
        code: "UNAUTHORIZED",
        message: "not admitted",
        retryable: true,
        doorReason: "not_admitted",
      },
    });
    await vi.waitFor(
      () => expect(driven.refusals.length).toBeGreaterThan(0),
      WAIT,
    );
    expect(driven.refusals[0]).toMatchObject({ doorReason: "not_admitted" });
  });
});
