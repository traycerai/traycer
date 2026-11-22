import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { UNARY_CAPABILITY_PERSISTENT_SESSION } from "@traycer/protocol/framework/index";
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
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import type { HostDoorObserver, HostDoorStateKind } from "../host-door-state";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "@traycer/protocol/host-transport/websocket";
import { HostRequestAbortedError } from "@traycer/protocol/host-transport/remote/rpc-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import type { IWebSocketFactory } from "../ws-factory";
import {
  heldTokenRefused,
  signInForLocalRow,
  createReleasedHostMemory,
  type ReleasedHostMemory,
  type ReleasedSignOnRow,
} from "../released-sign-on";
import { WsRpcClient } from "../ws-rpc-client";
import { echoRegistry } from "./__fixtures__/echo-registry";

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

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code: number, _reason: string): void {}

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
  return { tokens: trackHostTokenMints(source), mintCalls: () => mintCalls };
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
} {
  const refusals: FatalErrorDetails[] = [];
  const states: HostDoorStateKind[] = [];
  return {
    refusals,
    states,
    door: {
      refused: (details) => {
        refusals.push(details);
      },
      admitted: () => () => undefined,
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
  return { source, tokens: trackHostTokenMints(source) };
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
  return { tokens: trackHostTokenMints(source), mintCalls: () => mintCalls };
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
  readonly client: WsRpcClient<typeof echoRegistry>;
  readonly sockets: UnarySocket[];
  readonly refusals: FatalErrorDetails[];
  readonly states: HostDoorStateKind[];
  readonly settled: Promise<EchoResult>;
  finished: boolean;
}

function requestEcho(
  client: WsRpcClient<typeof echoRegistry>,
): Promise<EchoResult> {
  return requestEchoUntil(client, new AbortController().signal);
}

function requestEchoUntil(
  client: WsRpcClient<typeof echoRegistry>,
  abortSignal: AbortSignal,
): Promise<EchoResult> {
  return client
    .request(
      "host.echo",
      { message: "hi" },
      {
        idempotencyKey: null,
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

/** The real client, with the row read live at every decision and the sign-in's refresh and the host memory the test gives it. */
function driveCallOnRow(input: {
  readonly tokens: TrackedHostTokens;
  readonly readRow: () => ReleasedSignOnRow | null;
  readonly recovery: StreamAuthRevalidator | null;
  readonly hosts: ReleasedHostMemory | null;
  readonly abortSignal: AbortSignal;
}): DrivenCall {
  const { tokens, readRow, recovery, hosts, abortSignal } = input;
  const sockets: UnarySocket[] = [];
  const factory: IWebSocketFactory = {
    create: () => {
      const socket = new UnarySocket();
      sockets.push(socket);
      return socket;
    },
  };
  const { door, refusals, states } = recordingDoor();
  let nextRequestId = 0;
  const client = new WsRpcClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: echoRegistry,
    requestId: () => `req-${(nextRequestId += 1)}`,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    frameTimeoutMs: 1_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
    hostBearerFor: hostTokenBearerFor(tokens, (_hostId, kind) => {
      states.push(kind);
    }),
    releasedSignOnFor: signInForLocalRow(readRow, recovery, tokens),
    ...(hosts === null ? {} : { releasedHosts: hosts }),
    heldTokenRefusedFor: (authority, presented) =>
      heldTokenRefused(
        tokens,
        authority.bearer.identity.userId,
        authority.endpoint.hostId,
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
    finished: false,
    settled: requestEchoUntil(client, abortSignal),
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

const clients: WsRpcClient<typeof echoRegistry>[] = [];

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
    const tokens = trackHostTokenMints(source);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, false, null);
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
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, false, null);
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
    const tokens = trackHostTokenMints(source);
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
    const driven = driveCall(trackHostTokenMints(source), null);
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
      trackHostTokenMints(source),
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
    const tokens = trackHostTokenMints(source);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, true, null);
    await source.adopt(
      USER_ID,
      mockLocalHostEntry.hostId,
      usable,
      source.era(USER_ID),
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
    const tokens = trackHostTokenMints(source);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, true, null);
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
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, false, null);
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

  async function untilEnded(driven: DrivenCall, sockets: number): Promise<void> {
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
    const tokens = trackHostTokenMints(source);
    const driven = driveCall(tokens, PERSONAL_ROW);
    clients.push(driven.client);
    await planOwnerSignIn(driven);
    minting.answer({
      kind: "ok",
      token: { token: "minted-host-token", expiresAtMs: Date.now() + 3_600_000 },
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

  it("dials the owner's invited sign-in on its own socket, never as a request on a persistent session admitted earlier on a token the host has since refused", async () => {
    const expired = expiredJwt(Date.now());
    const { source, tokens } = sourceOf([
      { kind: "unavailable", detail: "authn offline" },
      { kind: "unavailable", detail: "authn still offline" },
    ]);
    await holdExpired(source, expired);
    await tokens.obtain(USER_ID, mockLocalHostEntry.hostId, false, null);
    // Call B: its host-only token is presented, and the host admits a persistent session on it.
    const driven = driveCallOnRow({
      tokens,
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

    // The host then refuses that token as expired, so it counts as no token held.
    heldTokenRefused(
      tokens,
      USER_ID,
      mockLocalHostEntry.hostId,
      expired.token,
    );

    // Call A probes and is invited to send the owner's sign-in.
    void requestEcho(driven.client);
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const probe = driven.sockets[1];
    if (probe === undefined) throw new Error("probe dial missing");
    expect((await openAndRead(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    await vi.waitFor(
      () => expect(driven.sockets.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    const invited = driven.sockets[2];
    if (invited === undefined) throw new Error("invited dial missing");
    expect((await openAndRead(invited)).token).toBe(SIGN_IN);
    expect(session.sent.join("\n")).not.toContain(SIGN_IN);
  });

  it("applies no decline and plans no sign-in when the probe's answer comes from a host process that was since replaced", async () => {
    const hosts = createReleasedHostMemory();
    hosts.observeInstance(mockLocalHostEntry.hostId, "process-a");
    const driven = driveCallOnRow({
      tokens: blackHoledTokens().tokens,
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
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({
      kind: "rejected",
      error: { message: NO_HOST_TOKEN_MESSAGE },
    });
    expect(hosts.probeDeclined(USER_ID, mockLocalHostEntry.hostId)).toBe(false);
    expect(driven.sockets).toHaveLength(1);
  });

  it("marks nothing for the current host process and tells the door nothing when a refusal comes from one that was since replaced", async () => {
    const hosts = createReleasedHostMemory();
    hosts.observeInstance(mockLocalHostEntry.hostId, "process-a");
    const { source, tokens } = sourceOf([]);
    await source.adopt(
      USER_ID,
      mockLocalHostEntry.hostId,
      { token: "usable-host-token", expiresAtMs: Date.now() + 3_600_000 },
      source.era(USER_ID),
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
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(hosts.namedReason(mockLocalHostEntry.hostId)).toBe(false);
    expect(driven.refusals).toEqual([]);
    expect(everythingWritten(driven)).not.toContain(SIGN_IN);
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
    const tokens = trackHostTokenMints(source);
    const hostId = mockLocalHostEntry.hostId;
    for (const held of [
      { token: "older-host-token", expiresAtMs: Date.now() - 60_000 },
      { token: "newer-host-token", expiresAtMs: Date.now() - 30_000 },
    ]) {
      await source.adopt(USER_ID, hostId, held, source.era(USER_ID));
    }

    heldTokenRefused(tokens, USER_ID, hostId, "newer-host-token");
    heldTokenRefused(tokens, USER_ID, hostId, "older-host-token");

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
