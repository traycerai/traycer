import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  UNARY_CAPABILITY_IDEMPOTENCY_KEY,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
  defineFallbackMethodDegrade,
  defineRpcContract,
  defineVersionedRpcRegistry,
  type FirstPartyClientIdentity,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type {
  ClientCancelFrame,
  ClientFrame,
  ClientOpenFrame,
  ClientRequestFrame,
  HostFrame,
  HostOpenAckFrame,
} from "@traycer/protocol/framework/ws-protocol";
import {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type RequiredHostMethodVersion,
} from "../host-messenger";
import {
  MutableBearerLease,
  type OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import type { DialPriority } from "../dial-priority";
import { WsRpcClient } from "../ws-rpc-client";
import { resetNegotiatedManifests } from "../negotiated-manifest-registry";
import { createAuthAwareMessenger } from "../auth-aware-messenger";
import { createRetryingMessenger } from "../retrying-messenger";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

/**
 * Local unary connection reuse through the public `WsRpcClient` surface, with
 * a scripted host on the other end of stub sockets.
 */

// Mirrors the host's documented per-session ceiling.
const MAX_RUNNING_REQUESTS = 64;
const IDLE_TIMEOUT_MS = 30_000;

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});
const statusV10 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});
const readFallbackV10 = defineRpcContract({
  method: "host.readFallback",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ summary: z.string() }),
});

const statusLine = {
  1: {
    latestMinor: 0 as const,
    versions: { 0: { contract: statusV10, upgradeFromPreviousVersion: null } },
    downgradePathsFromLatest: {},
  },
};
// host.echo is a read (may be cancelled after dispatch); host.status is not.
const registry = defineVersionedRpcRegistry({
  "host.echo": {
    cancelAfterDispatch: true,
    1: {
      latestMinor: 0,
      versions: { 0: { contract: echoV10, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
  "host.status": statusLine,
});
// A cancellable read that degrades onto the non-cancellable host.status.
const degradeRegistry = defineVersionedRpcRegistry({
  "host.readFallback": {
    cancelAfterDispatch: true,
    degrade: defineFallbackMethodDegrade<
      typeof readFallbackV10,
      typeof statusV10,
      "host.status"
    >({
      kind: "fallback",
      to: { method: "host.status", major: 1, minor: 0 },
      adaptRequest: () => ({}),
      adaptResponse: (response) => ({
        summary: response.ready ? "ready" : "not-ready",
      }),
    }),
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: readFallbackV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.status": statusLine,
});

class StubWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sentFrames: ClientFrame[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  constructor(
    private readonly index: number,
    private readonly events: string[],
  ) {}

  send(data: string): void {
    const frame = JSON.parse(data) as ClientFrame;
    this.sentFrames.push(frame);
    this.events.push(`send:${frame.kind}:${this.index}`);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }
  fireMessage(frame: HostFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  fireClose(): void {
    this.onclose?.({ code: 1006, reason: "", wasClean: false });
  }
}

const requestFrames = (socket: StubWebSocket): ClientRequestFrame[] =>
  socket.sentFrames.filter(
    (frame): frame is ClientRequestFrame => frame.kind === "request",
  );
const cancelFrames = (socket: StubWebSocket): ClientCancelFrame[] =>
  socket.sentFrames.filter(
    (frame): frame is ClientCancelFrame => frame.kind === "cancel",
  );
const openFrames = (sockets: readonly StubWebSocket[]): ClientOpenFrame[] =>
  sockets.flatMap((socket) =>
    socket.sentFrames.filter(
      (frame): frame is ClientOpenFrame => frame.kind === "open",
    ),
  );

const HOST_MANIFEST = { "host.status": { major: 1, minor: 0 } };
const PERSISTENT_ACK: HostOpenAckFrame = {
  kind: "openAck",
  manifest: HOST_MANIFEST,
  optionalManifest: { "host.echo": { major: 1, minor: 0 } },
  capabilities: [
    UNARY_CAPABILITY_IDEMPOTENCY_KEY,
    UNARY_CAPABILITY_PERSISTENT_SESSION,
  ],
};
const LEGACY_ACK: HostOpenAckFrame = {
  ...PERSISTENT_ACK,
  capabilities: [UNARY_CAPABILITY_IDEMPOTENCY_KEY],
};
const DEGRADE_ACK: HostOpenAckFrame = {
  kind: "openAck",
  manifest: HOST_MANIFEST,
  optionalManifest: {},
  capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
};

function harness<R extends VersionedRpcRegistry>(
  reg: R,
  identity: FirstPartyClientIdentity,
) {
  const sockets: StubWebSocket[] = [];
  const events: string[] = [];
  const priorities: DialPriority[] = [];
  const factory: IWebSocketFactory = {
    create(_url: string, priority: DialPriority): WebSocketLike {
      priorities.push(priority);
      const socket = new StubWebSocket(sockets.length, events);
      sockets.push(socket);
      return socket;
    },
  };
  let counter = 0;
  const client = new WsRpcClient<R>({
    clientIdentity: identity,
    registry: reg,
    requestId: () => `req-${++counter}`,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    frameTimeoutMs: 1_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
  return { client, sockets, events, priorities };
}

type AuthorityKnobs = {
  readonly verdict: { value: boolean } | undefined;
  readonly cancel: boolean | undefined;
  readonly controller: AbortController | undefined;
};
function authorityWith(
  lease: OpenFrameBearerSource,
  knobs: AuthorityKnobs,
): HostRequestAuthority {
  const controller = knobs.controller ?? new AbortController();
  const verdict = knobs.verdict;
  return {
    endpoint: {
      hostId: mockLocalHostEntry.hostId,
      websocketUrl: mockLocalHostEntry.websocketUrl,
    },
    bearer: lease,
    abortSignal: controller.signal,
    ...(knobs.cancel === undefined
      ? {}
      : { cancelAfterDispatch: knobs.cancel }),
    ...(verdict === undefined ? {} : { cloudAuthorized: () => verdict.value }),
  };
}
const authority = (lease: OpenFrameBearerSource): HostRequestAuthority =>
  authorityWith(lease, {
    verdict: undefined,
    cancel: undefined,
    controller: undefined,
  });
const readAuthority = (
  lease: MutableBearerLease,
  controller: AbortController | undefined,
): HostRequestAuthority =>
  authorityWith(lease, { verdict: undefined, cancel: true, controller });

/** A real releasable credential lease: `credentials.release()` withdraws the bearer, `abort()` releases AND signals abort. */
function realLease(token: string): RequestContext {
  return createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: token,
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
}
function leaseAuthority(lease: RequestContext): HostRequestAuthority {
  return {
    endpoint: {
      hostId: mockLocalHostEntry.hostId,
      websocketUrl: mockLocalHostEntry.websocketUrl,
    },
    bearer: lease.credentials,
    abortSignal: lease.abortSignal,
  };
}
function opts(
  auth: HostRequestAuthority,
  idempotencyKey: string | null,
  requiredHostMethodVersion: RequiredHostMethodVersion | null,
): HostRequestOptions {
  return {
    authority: auth,
    idempotencyKey,
    replayMustBeKeyed: false,
    requiredHostMethodVersion,
  };
}
const plain = (auth: HostRequestAuthority): HostRequestOptions =>
  opts(auth, null, null);

async function settle(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
async function establish(
  socket: StubWebSocket,
  ack: HostOpenAckFrame,
): Promise<void> {
  await settle();
  socket.fireOpen();
  await settle();
  socket.fireMessage(ack);
  await settle();
}
/** Negotiates and caches a capable session with one completed call, so later overlapping calls reuse it. */
async function warmSession(
  client: WsRpcClient<typeof registry>,
  sockets: readonly StubWebSocket[],
  lease: MutableBearerLease,
): Promise<void> {
  const warm = client.request(
    "host.echo",
    { message: "warm" },
    plain(authority(lease)),
  );
  await establish(sockets[0], PERSISTENT_ACK);
  respond(sockets[0], requestFrames(sockets[0])[0], { echoed: "WARM" });
  await warm;
}
/** Answers every request frame not answered yet, whichever socket carries it. */
function answerAll(
  sockets: readonly StubWebSocket[],
  answered: Set<string>,
): void {
  for (const socket of sockets) {
    for (const frame of requestFrames(socket)) {
      if (answered.has(frame.requestId)) continue;
      answered.add(frame.requestId);
      respond(
        socket,
        frame,
        frame.method === "host.status" ? { ready: true } : { echoed: "ok" },
      );
    }
  }
}
function respond(
  socket: StubWebSocket,
  frame: ClientRequestFrame,
  result: unknown,
): void {
  socket.fireMessage({
    kind: "response",
    requestId: frame.requestId,
    method: frame.method,
    schemaVersion: frame.schemaVersion,
    result,
    error: null,
  });
}
/** The host's terminal receipt for a request whose caller already stopped waiting. */
function receipt(socket: StubWebSocket, frame: ClientRequestFrame): void {
  socket.fireMessage({
    kind: "response",
    requestId: frame.requestId,
    method: frame.method,
    schemaVersion: frame.schemaVersion,
    result: null,
    error: { code: "RPC_ERROR", message: "Request cancelled" },
  });
}
const fatalUnauthorized: HostFrame = {
  kind: "fatalError",
  details: {
    code: "UNAUTHORIZED",
    reason: "Bearer expired",
    incompatibleMethods: null,
    upgradeGuidance: null,
  },
};

/** Reads a rotated token once `rotateAfterReads` reads have happened, and logs when it does. */
class ScriptedBearer implements OpenFrameBearerSource {
  readonly identity = { userId: "test-user" };
  rotateAfterReads = Number.POSITIVE_INFINITY;
  reads = 0;
  constructor(private readonly events: string[]) {}
  getBearerToken(): string {
    const rotated = this.reads >= this.rotateAfterReads;
    this.reads += 1;
    if (rotated) this.events.push("read:token-2");
    return rotated ? "token-2" : "token-1";
  }
}

const DESKTOP = TEST_CLIENT_IDENTITY;
const CLI: FirstPartyClientIdentity = {
  kind: "cli",
  compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  appVersion: "0.0.0-test",
};

describe("WsRpcClient persistent local session", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetNegotiatedManifests();
  });

  it("reuses a negotiated session for a burst and later calls, and answers correlated calls out of order", async () => {
    const { client, sockets } = harness(registry, DESKTOP);
    const lease = new MutableBearerLease("token-1", "test-user");
    await warmSession(client, sockets, lease);

    const a = client.request(
      "host.echo",
      { message: "a" },
      plain(authority(lease)),
    );
    const b = client.request(
      "host.echo",
      { message: "b" },
      plain(authority(lease)),
    );
    await settle();
    expect(sockets).toHaveLength(1);
    const [, frameA, frameB] = requestFrames(sockets[0]);
    expect([frameA.sequence, frameB.sequence]).toEqual([2, 3]);
    respond(sockets[0], frameB, { echoed: "B" });
    await expect(b).resolves.toEqual({ echoed: "B" });
    respond(sockets[0], frameA, { echoed: "A" });
    await expect(a).resolves.toEqual({ echoed: "A" });

    const c = client.request(
      "host.echo",
      { message: "c" },
      plain(authority(lease)),
    );
    await settle();
    const frameC = requestFrames(sockets[0])[3];
    expect(frameC.sequence).toBe(4);
    respond(sockets[0], frameC, { echoed: "C" });
    await expect(c).resolves.toEqual({ echoed: "C" });

    expect(sockets).toHaveLength(1);
    expect(openFrames(sockets)).toHaveLength(1);
    expect(sockets[0].closed).toBeNull();
  });

  it("dials each overlapping cold call on its own socket and priority, and both complete", async () => {
    const { client, sockets, priorities } = harness(registry, DESKTOP);
    const lease = new MutableBearerLease("token-1", "test-user");
    const background = client.request(
      "host.status",
      {},
      plain(authority(lease)),
    );
    const interactive = client.request(
      "host.echo",
      { message: "hi" },
      plain(authority(lease)),
    );
    await settle();

    // No handshake is shared while none has completed.
    expect(sockets).toHaveLength(2);
    expect(priorities).toEqual(["background", "interactive"]);

    await establish(sockets[0], PERSISTENT_ACK);
    await establish(sockets[1], PERSISTENT_ACK);
    await settle();
    const answered = new Set<string>();
    answerAll(sockets, answered);
    await settle();
    answerAll(sockets, answered);

    await expect(background).resolves.toEqual({ ready: true });
    await expect(interactive).resolves.toEqual({ echoed: "ok" });
    expect(answered.size).toBe(2);
  });

  it("falls back to a socket per call when the host does not acknowledge the capability", async () => {
    const { client, sockets } = harness(registry, DESKTOP);
    const lease = new MutableBearerLease("token-1", "test-user");
    const a = client.request(
      "host.echo",
      { message: "a" },
      plain(authority(lease)),
    );
    const b = client.request(
      "host.echo",
      { message: "b" },
      plain(authority(lease)),
    );
    await settle();
    expect(sockets).toHaveLength(2);
    await establish(sockets[0], LEGACY_ACK);
    await establish(sockets[1], LEGACY_ACK);

    respond(sockets[0], requestFrames(sockets[0])[0], { echoed: "A" });
    respond(sockets[1], requestFrames(sockets[1])[0], { echoed: "B" });
    await expect(a).resolves.toEqual({ echoed: "A" });
    await expect(b).resolves.toEqual({ echoed: "B" });
    expect(sockets.map((socket) => socket.closed?.code)).toEqual([1000, 1000]);
  });

  it("offers the capability from a desktop client but keeps the CLI one-shot even against a capable host", async () => {
    const desktop = harness(registry, DESKTOP);
    const cli = harness(registry, CLI);
    const lease = new MutableBearerLease("token-1", "test-user");

    void desktop.client
      .request("host.echo", { message: "d" }, plain(authority(lease)))
      .catch(() => undefined);
    await establish(desktop.sockets[0], PERSISTENT_ACK);
    expect(openFrames(desktop.sockets)[0].capabilities).toContain(
      UNARY_CAPABILITY_PERSISTENT_SESSION,
    );

    const first = cli.client.request(
      "host.echo",
      { message: "1" },
      plain(authority(lease)),
    );
    await establish(cli.sockets[0], PERSISTENT_ACK);
    expect(openFrames(cli.sockets)[0].capabilities).not.toContain(
      UNARY_CAPABILITY_PERSISTENT_SESSION,
    );
    respond(cli.sockets[0], requestFrames(cli.sockets[0])[0], { echoed: "1" });
    await first;
    expect(cli.sockets[0].closed?.code).toBe(1000);

    const second = cli.client.request(
      "host.echo",
      { message: "2" },
      plain(authority(lease)),
    );
    await establish(cli.sockets[1], PERSISTENT_ACK);
    respond(cli.sockets[1], requestFrames(cli.sockets[1])[0], { echoed: "2" });
    await second;
    expect(cli.sockets).toHaveLength(2);
  });

  it.each(["token", "verdict"] as const)(
    "drains an in-flight command, then negotiates a fresh session, after the %s changes",
    async (change) => {
      const { client, sockets } = harness(registry, DESKTOP);
      const lease = new MutableBearerLease("token-1", "test-user");
      const verdict = { value: true };
      const auth = authorityWith(lease, {
        verdict,
        cancel: undefined,
        controller: undefined,
      });
      const command = client.request("host.status", {}, plain(auth));
      await establish(sockets[0], PERSISTENT_ACK);
      const commandFrame = requestFrames(sockets[0])[0];

      if (change === "token") lease.rotate("token-2");
      else verdict.value = false;
      const next = client.request(
        "host.echo",
        { message: "next" },
        plain(auth),
      );
      await settle();

      expect(sockets).toHaveLength(2);
      await settle();
      sockets[1].fireOpen();
      await settle();
      expect(openFrames([sockets[1]])[0]).toMatchObject(
        change === "token" ? { token: "token-2" } : { cloudAuthorized: false },
      );
      expect(sockets[0].closed).toBeNull();
      respond(sockets[0], commandFrame, { ready: true });
      await expect(command).resolves.toEqual({ ready: true });
      expect(sockets[0].closed).not.toBeNull();

      sockets[1].fireMessage(PERSISTENT_ACK);
      await settle();
      respond(sockets[1], requestFrames(sockets[1])[0], { echoed: "next" });
      await expect(next).resolves.toEqual({ echoed: "next" });
    },
  );

  it("checks a required host version against the session's own negotiated manifest without dialing again", async () => {
    const { client, sockets } = harness(registry, DESKTOP);
    const lease = new MutableBearerLease("token-1", "test-user");
    const first = client.request(
      "host.echo",
      { message: "a" },
      plain(authority(lease)),
    );
    await establish(sockets[0], PERSISTENT_ACK);
    respond(sockets[0], requestFrames(sockets[0])[0], { echoed: "A" });
    await first;

    const tooNew = client.request(
      "host.echo",
      { message: "b" },
      opts(authority(lease), null, {
        method: "host.echo",
        version: { major: 1, minor: 1 },
      }),
    );

    await expect(tooNew).rejects.toBeInstanceOf(
      HostMethodVersionUnsatisfiedError,
    );
    expect(sockets).toHaveLength(1);
    expect(requestFrames(sockets[0])).toHaveLength(1);
  });

  describe("a break after the request was sent", () => {
    it.each([
      {
        name: "socket close",
        key: null,
        deliver: (socket: StubWebSocket) => socket.fireClose(),
      },
      {
        name: "socket close on a keyed command",
        key: "key-1",
        deliver: (socket: StubWebSocket) => socket.fireClose(),
      },
      {
        name: "session UNAUTHORIZED fatal",
        key: null,
        deliver: (socket: StubWebSocket) =>
          socket.fireMessage(fatalUnauthorized),
      },
    ])(
      "is an ambiguous transport failure that no layer replays: $name",
      async ({ key, deliver }) => {
        const { client, sockets } = harness(registry, DESKTOP);
        const lease = new MutableBearerLease("token-1", "test-user");
        const revalidate = vi.fn(async () => {
          lease.rotate("token-2");
          return "rotated" as const;
        });
        const stack = createRetryingMessenger<typeof registry>(
          createAuthAwareMessenger<typeof registry>(client, {
            revalidateExpectedBearer: revalidate,
          }),
          {
            maxRetries: 3,
            initialDelayMs: 0,
            maxDelayMs: 0,
            sleep: () => Promise.resolve(),
            random: () => 0,
          },
        );

        const pending = stack.request(
          "host.status",
          {},
          opts(authority(lease), key, null),
        );
        const rejection = pending.then(
          () => null,
          (error: unknown) => error,
        );
        await establish(sockets[0], PERSISTENT_ACK);
        expect(requestFrames(sockets[0])).toHaveLength(1);
        deliver(sockets[0]);

        const error = await rejection;
        expect(error).toBeInstanceOf(HostTransportFailureError);
        expect(error).not.toBeInstanceOf(RetryableTransportError);
        expect(revalidate).not.toHaveBeenCalled();
        expect(sockets).toHaveLength(1);
        expect(requestFrames(sockets[0])).toHaveLength(1);
      },
    );
  });

  describe("cancellation of a dispatched call", () => {
    it.each([
      {
        name: "the authority and the method both permit it",
        method: "host.echo",
        cancel: true,
        sends: true,
      },
      {
        name: "the authority does not opt in",
        method: "host.echo",
        cancel: false,
        sends: false,
      },
      {
        name: "the method is not a cancellable read",
        method: "host.status",
        cancel: true,
        sends: false,
      },
    ] as const)(
      "sends a cancel frame only when $name",
      async ({ method, cancel, sends }) => {
        const { client, sockets } = harness(registry, DESKTOP);
        const lease = new MutableBearerLease("token-1", "test-user");
        const controller = new AbortController();
        const auth = authorityWith(lease, {
          verdict: undefined,
          cancel,
          controller,
        });
        const pending =
          method === "host.echo"
            ? client.request("host.echo", { message: "m" }, plain(auth))
            : client.request("host.status", {}, plain(auth));
        const outcome = (async () => {
          try {
            return { value: await pending };
          } catch (error) {
            return { error };
          }
        })();
        await establish(sockets[0], PERSISTENT_ACK);
        const frame = requestFrames(sockets[0])[0];

        controller.abort();
        await settle();

        if (sends) {
          expect(cancelFrames(sockets[0])).toEqual([
            { kind: "cancel", requestId: frame.requestId },
          ]);
          expect(await outcome).toMatchObject({
            error: expect.any(HostRequestAbortedError),
          });
        } else {
          expect(cancelFrames(sockets[0])).toEqual([]);
          respond(
            sockets[0],
            frame,
            method === "host.echo" ? { echoed: "m" } : { ready: true },
          );
          expect(await outcome).toHaveProperty("value");
        }
      },
    );

    it("does not cancel a read that was degraded onto a method that is not cancellable", async () => {
      const { client, sockets } = harness(degradeRegistry, DESKTOP);
      const lease = new MutableBearerLease("token-1", "test-user");
      const controller = new AbortController();
      const pending = client.request(
        "host.readFallback",
        {},
        plain(readAuthority(lease, controller)),
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await establish(sockets[0], DEGRADE_ACK);
      const frame = requestFrames(sockets[0])[0];
      expect(frame.method).toBe("host.status");

      controller.abort();
      await settle();
      expect(cancelFrames(sockets[0])).toEqual([]);
      respond(sockets[0], frame, { ready: true });

      expect(await outcome).toEqual({ value: { summary: "ready" } });
    });
  });

  it("stops a deadline wait without freeing the running slot, and keeps the session for the late receipt", async () => {
    vi.useFakeTimers();
    const { client, sockets } = harness(registry, DESKTOP);
    const lease = new MutableBearerLease("token-1", "test-user");
    const pending = client.requestWithResponseTimeout(
      "host.echo",
      { message: "slow" },
      50,
      plain(readAuthority(lease, undefined)),
    );
    const rejection = expect(pending).rejects.toBeInstanceOf(
      HostTransportFailureError,
    );
    await establish(sockets[0], PERSISTENT_ACK);
    const frame = requestFrames(sockets[0])[0];

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(cancelFrames(sockets[0])).toHaveLength(1);
    expect(sockets[0].closed).toBeNull();

    receipt(sockets[0], frame);
    const next = client.request(
      "host.echo",
      { message: "next" },
      plain(authority(lease)),
    );
    await settle();
    expect(sockets).toHaveLength(1);
    respond(sockets[0], requestFrames(sockets[0])[1], { echoed: "next" });
    await expect(next).resolves.toEqual({ echoed: "next" });
  });

  it("keeps cancelled reads counted against the running cap until the host's terminal receipts arrive", async () => {
    const { client, sockets } = harness(registry, DESKTOP);
    const lease = new MutableBearerLease("token-1", "test-user");
    await warmSession(client, sockets, lease);
    const controllers = Array.from(
      { length: MAX_RUNNING_REQUESTS },
      () => new AbortController(),
    );
    const calls = controllers.map((controller, index) => {
      const call = client.request(
        "host.echo",
        { message: `m${index}` },
        plain(readAuthority(lease, controller)),
      );
      return call.then(
        () => "resolved",
        (error: unknown) => error,
      );
    });
    await settle();
    const frames = requestFrames(sockets[0]).slice(1);
    expect(frames).toHaveLength(MAX_RUNNING_REQUESTS);

    for (const controller of controllers) controller.abort();
    for (const outcome of await Promise.all(calls))
      expect(outcome).toBeInstanceOf(HostRequestAbortedError);
    expect(cancelFrames(sockets[0])).toHaveLength(MAX_RUNNING_REQUESTS);

    const over = client.request(
      "host.echo",
      { message: "over" },
      plain(authority(lease)),
    );
    // Nothing was written, so this refusal is safe to retry as-is.
    await expect(over).rejects.toBeInstanceOf(RetryableTransportError);
    await expect(over).rejects.toMatchObject({ replaySafetyFromKey: false });
    expect(requestFrames(sockets[0])).toHaveLength(MAX_RUNNING_REQUESTS + 1);
    expect(sockets).toHaveLength(1);

    receipt(sockets[0], frames[0]);
    const fits = client.request(
      "host.echo",
      { message: "fits" },
      plain(authority(lease)),
    );
    await settle();
    expect(requestFrames(sockets[0])).toHaveLength(MAX_RUNNING_REQUESTS + 2);
    respond(sockets[0], requestFrames(sockets[0])[MAX_RUNNING_REQUESTS + 1], {
      echoed: "fits",
    });
    await expect(fits).resolves.toEqual({ echoed: "fits" });
  });

  it("closes after the idle window and negotiates a new session for the next call", async () => {
    vi.useFakeTimers();
    const { client, sockets } = harness(registry, DESKTOP);
    const lease = new MutableBearerLease("token-1", "test-user");
    const first = client.request(
      "host.echo",
      { message: "a" },
      plain(authority(lease)),
    );
    await establish(sockets[0], PERSISTENT_ACK);
    respond(sockets[0], requestFrames(sockets[0])[0], { echoed: "A" });
    await first;

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(sockets[0].closed).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0].closed).not.toBeNull();

    const second = client.request(
      "host.echo",
      { message: "b" },
      plain(authority(lease)),
    );
    await settle();
    expect(sockets).toHaveLength(2);
    await establish(sockets[1], PERSISTENT_ACK);
    respond(sockets[1], requestFrames(sockets[1])[0], { echoed: "B" });
    await expect(second).resolves.toEqual({ echoed: "B" });
    expect(openFrames(sockets)).toHaveLength(2);
  });

  it("never dispatches on a session negotiated under a token the client has already seen replaced", async () => {
    for (const rotateAfterReads of [0, 1, 2, 3, 4, 5]) {
      const { client, sockets, events } = harness(registry, DESKTOP);
      const bearer = new ScriptedBearer(events);
      const first = client.request(
        "host.echo",
        { message: "a" },
        plain(authority(bearer)),
      );
      await establish(sockets[0], PERSISTENT_ACK);
      respond(sockets[0], requestFrames(sockets[0])[0], { echoed: "A" });
      await first;

      bearer.rotateAfterReads = rotateAfterReads;
      bearer.reads = 0;
      const second = client.request(
        "host.echo",
        { message: "b" },
        plain(authority(bearer)),
      );
      const outcome = second.then(
        () => "resolved",
        (error: unknown) => error,
      );
      await settle();
      if (sockets.length > 1) await establish(sockets[1], PERSISTENT_ACK);
      const newest = sockets[sockets.length - 1];
      const pendingFrame = requestFrames(newest).find(
        (frame) => frame.requestId === "req-2",
      );
      if (pendingFrame !== undefined)
        respond(newest, pendingFrame, { echoed: "B" });

      const result = await outcome;
      if (result !== "resolved") {
        // Definitely unsent: retry-safe, and nothing may have reached any socket.
        expect(result).toBeInstanceOf(RetryableTransportError);
        expect(
          events.filter((event) => event.startsWith("send:request")),
        ).toEqual(["send:request:0"]);
      }
      const rotatedAt = events.indexOf("read:token-2");
      if (rotatedAt >= 0)
        expect(events.slice(rotatedAt)).not.toContain("send:request:0");
    }
  });

  it.each(
    (["before-ack", "at-handoff"] as const).flatMap((timing) =>
      (["abort", "release"] as const).flatMap((release) =>
        [
          { host: "capable", ack: PERSISTENT_ACK },
          { host: "old", ack: LEGACY_ACK },
        ].map(({ host, ack }) => ({ timing, release, host, ack })),
      ),
    ),
  )(
    "closes the cold socket and writes nothing when the credential lease ends $timing ($release, $host host)",
    async ({ timing, release, ack }) => {
      const { client, sockets } = harness(registry, DESKTOP);
      const lease = realLease("token-1");
      const call = client.request(
        "host.echo",
        { message: "m" },
        plain(leaseAuthority(lease)),
      );
      const outcome = call.then(
        () => null,
        (error: unknown) => error,
      );
      await settle();
      expect(sockets).toHaveLength(1);
      sockets[0].fireOpen();
      await settle();
      expect(sockets[0].sentFrames.map((frame) => frame.kind)).toEqual([
        "open",
      ]);

      const end = (): void => {
        if (release === "abort") lease.abort("superseded");
        else lease.credentials.release();
      };
      if (timing === "before-ack") {
        end();
        sockets[0].fireMessage(ack);
      } else {
        // The ack's continuation is already queued when the lease ends, so the handshake completes first and the
        // release lands in the gap before the caller resumes to re-read the bearer.
        sockets[0].fireMessage(ack);
        queueMicrotask(end);
      }

      const error = await outcome;
      await settle();
      if (release === "abort")
        expect(error).toBeInstanceOf(HostRequestAbortedError);
      else {
        expect(error).toBeInstanceOf(HostRpcError);
        expect(error).not.toBeInstanceOf(HostRequestAbortedError);
      }
      expect(sockets[0].closed).not.toBeNull();
      expect(requestFrames(sockets[0])).toEqual([]);
      expect(sockets).toHaveLength(1);
    },
  );

  it.each([
    { name: "dial against a capable host", phase: "dial", ack: PERSISTENT_ACK },
    {
      name: "ack wait against a capable host",
      phase: "ack",
      ack: PERSISTENT_ACK,
    },
    { name: "dial against an old host", phase: "dial", ack: LEGACY_ACK },
    { name: "ack wait against an old host", phase: "ack", ack: LEGACY_ACK },
  ] as const)(
    "closes a cold caller's own socket promptly when it aborts during the $name, without disturbing the other caller",
    async ({ phase, ack }) => {
      const { client, sockets } = harness(registry, DESKTOP);
      const lease = new MutableBearerLease("token-1", "test-user");
      const aborting = new AbortController();
      const abortingCall = client.request(
        "host.echo",
        { message: "aborting" },
        plain(
          authorityWith(lease, {
            verdict: undefined,
            cancel: undefined,
            controller: aborting,
          }),
        ),
      );
      const other = client.request(
        "host.echo",
        { message: "other" },
        plain(authority(lease)),
      );
      const abortingOutcome = abortingCall.then(
        () => null,
        (error: unknown) => error,
      );
      await settle();
      expect(sockets).toHaveLength(2);
      const own = sockets[0];
      if (phase === "ack") {
        own.fireOpen();
        await settle();
        expect(own.sentFrames.map((frame) => frame.kind)).toEqual(["open"]);
      }

      aborting.abort();

      expect(await abortingOutcome).toBeInstanceOf(HostRequestAbortedError);
      expect(own.closed).not.toBeNull();
      own.fireOpen();
      own.fireMessage(ack);
      await settle();
      expect(own.sentFrames.map((frame) => frame.kind)).toEqual(
        phase === "ack" ? ["open"] : [],
      );

      await establish(sockets[1], ack);
      respond(sockets[1], requestFrames(sockets[1])[0], { echoed: "OTHER" });
      await expect(other).resolves.toEqual({ echoed: "OTHER" });
      expect(requestFrames(own)).toEqual([]);
    },
  );
});
