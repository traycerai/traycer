import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
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
import type { HostDoorStateKind } from "../host-door-state";
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "@traycer/protocol/host-transport/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import type { IWebSocketFactory } from "../ws-factory";
import {
  signInForLocalRow,
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
  doorReason: "not_admitted",
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

function expiredJwt(nowMs: number): { readonly token: string; readonly expiresAtMs: number } {
  const expiresAtMs = nowMs - ELEVEN_MINUTES_MS;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
  ).toString("base64url");
  return { token: `${header}.${payload}.`, expiresAtMs };
}

function recordingDoor(): {
  readonly door: SessionDoorObserver;
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
      admitted: () => undefined,
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

function requestEcho(client: WsRpcClient<typeof echoRegistry>): Promise<EchoResult> {
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
          abortSignal: new AbortController().signal,
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
    releasedSignOnFor: signInForLocalRow(() => row, null, tokens),
    doorFor: () => door,
  });
  const driven: DrivenCall = {
    client,
    sockets,
    refusals,
    states,
    finished: false,
    settled: requestEcho(client),
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

async function openAndRead(socket: UnarySocket): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0), WAIT);
  return readFrame(socket.sent[0]);
}

function ackAndEcho(
  socket: UnarySocket,
  open: Record<string, unknown>,
): void {
  socket.fireMessage({
    kind: "openAck",
    manifest: open.manifest,
    optionalManifest: open.optionalManifest,
  });
}

async function answerEcho(socket: UnarySocket): Promise<void> {
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThanOrEqual(2), WAIT);
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
    const { source, tokens } = sourceOf(
      [
        { kind: "unavailable", detail: "authn offline" },
        { kind: "unavailable", detail: "authn still offline" },
      ],
    );
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
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    expect(driven.sockets).toHaveLength(0);
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
