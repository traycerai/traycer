import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import {
  MutableBearerLease,
  type BearerSourceProvider,
  type OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { HostRpcError } from "../host-messenger";
import type { StreamConnectionStatus } from "../i-stream-session";
import { createWhatwgStreamWebSocketFactory } from "../whatwg-stream-ws-factory";
import { createWhatwgWebSocketFactory } from "../whatwg-ws-factory";
import { hostDialGate } from "../ws-dial-gate";
import { WsRpcClient } from "../ws-rpc-client";
import { WsStreamClient } from "../ws-stream-client";

const QUEUED_FOR_MS = 15_000;
const GATE_SLOTS = 6;
const HOLDER_URL = "wss://holder.example.test/dial";
// Long enough that no redial, ping, ack or frame timer fires inside a test.
const NEVER_MS = 600_000;
const REQUEST_ID = "req-open-frame-bearer";
const REDIAL_BACKOFF_MS = 50;
const REDIAL_WINDOW_MS = 500;
const USER_A = "user-a";
const USER_B = "user-b";

interface FakeEvent {
  readonly data: string;
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

class FakeNativeWebSocket {
  static readonly instances: FakeNativeWebSocket[] = [];

  binaryType = "blob";
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => void>
  >();

  constructor(readonly url: string) {
    FakeNativeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const existing = this.listeners.get(type);
    if (existing === undefined) {
      this.listeners.set(type, [listener]);
    } else {
      existing.push(listener);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.fire("open", "");
  }

  fireClose(): void {
    this.fire("close", "");
  }

  fireMessage(data: string): void {
    this.fire("message", data);
  }

  private fire(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data, code: 1006, reason: "test", wasClean: false });
    }
  }
}

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const echoRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

function instances(): FakeNativeWebSocket[] {
  return FakeNativeWebSocket.instances;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Six real dials with no client attached: every slot stays taken. */
async function holdEveryGateSlot(): Promise<FakeNativeWebSocket[]> {
  const factory = createWhatwgWebSocketFactory();
  for (let slot = 0; slot < GATE_SLOTS; slot += 1) {
    factory.create(HOLDER_URL, "interactive");
  }
  await settle();
  expect(hostDialGate.stats().connecting).toBe(GATE_SLOTS);
  return instances().slice(0, GATE_SLOTS);
}

/**
 * Waits behind the held slots for 15 s, then frees one: the native of the
 * queued dial is built, and the socket opens.
 */
async function waitQueuedThenGrantAndOpen(
  holders: readonly FakeNativeWebSocket[],
  rotateTo: string,
  lease: MutableBearerLease,
): Promise<FakeNativeWebSocket> {
  return grantAndOpenAfterWait(holders, () => {
    lease.rotate(rotateTo);
  });
}

/** The same wait, with `duringWait` run once the dial is queued. */
async function grantAndOpenAfterWait(
  holders: readonly FakeNativeWebSocket[],
  duringWait: () => void,
): Promise<FakeNativeWebSocket> {
  expect(hostDialGate.stats().queued).toBe(1);
  duringWait();
  await vi.advanceTimersByTimeAsync(QUEUED_FOR_MS);
  expect(instances()).toHaveLength(GATE_SLOTS);
  holders[0].fireOpen();
  await settle();
  expect(instances()).toHaveLength(GATE_SLOTS + 1);
  const native = instances()[GATE_SLOTS];
  native.fireOpen();
  await settle();
  return native;
}

function tokenOfOpenFrame(native: FakeNativeWebSocket): unknown {
  const frame: unknown = JSON.parse(native.sent[0]);
  if (typeof frame !== "object" || frame === null || !("token" in frame)) {
    throw new Error("Expected the first frame sent to carry a token");
  }
  return frame.token;
}

interface RpcCall {
  readonly outcome: Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  >;
  readonly isSettled: () => boolean;
}

function startEcho(lease: MutableBearerLease): RpcCall {
  return startEchoFor(lease, new AbortController().signal);
}

function startEchoFor(
  bearer: OpenFrameBearerSource,
  abortSignal: AbortSignal,
): RpcCall {
  let settled = false;
  const client = new WsRpcClient<typeof echoRegistry>({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: echoRegistry,
    requestId: () => REQUEST_ID,
    webSocketFactory: createWhatwgWebSocketFactory(),
    dialTimeoutMs: NEVER_MS,
    frameTimeoutMs: NEVER_MS,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
  const outcome = client
    .request(
      "host.echo",
      { message: "hi" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: {
          endpoint: {
            hostId: mockLocalHostEntry.hostId,
            websocketUrl: mockLocalHostEntry.websocketUrl,
          },
          bearer,
          abortSignal,
        },
      },
    )
    .then(
      () => {
        settled = true;
        return { ok: true as const };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
  return { outcome, isSettled: () => settled };
}

function userFixture(userId: string): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return { ...base, user: { ...base.user, id: userId } };
}

function newProvider(): DefaultRequestContextProvider {
  return new DefaultRequestContextProvider({ origin: "renderer" });
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

/** Every token any frame sent on any fake socket carried, in send order. */
function sentTokens(): unknown[] {
  const tokens: unknown[] = [];
  for (const native of instances()) {
    for (const raw of native.sent) {
      const frame: unknown = JSON.parse(raw);
      if (typeof frame === "object" && frame !== null && "token" in frame) {
        tokens.push(frame.token);
      }
    }
  }
  return tokens;
}

function openAckAdvertisingCredentialUpdate(): string {
  return JSON.stringify({
    kind: "openAck",
    manifest: buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    ),
    capabilities: ["credentialUpdate"],
  });
}

describe("open frame bearer after a wait for a dial slot", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    // A real socket reports its close after close() is called; the fake does
    // not, so every slot still held is handed back here.
    for (const native of instances()) {
      native.fireClose();
    }
    await settle();
    expect(hostDialGate.stats()).toMatchObject({ connecting: 0, queued: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("stream", () => {
    function subscribe(lease: MutableBearerLease): StreamConnectionStatus[] {
      return subscribeWith(() => lease, NEVER_MS).statuses;
    }

    function subscribeWith(
      bearer: BearerSourceProvider,
      backoffMs: number,
    ): {
      readonly statuses: StreamConnectionStatus[];
      readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
    } {
      const client = new WsStreamClient({
        clientIdentity: TEST_CLIENT_IDENTITY,
        registry: hostStreamRpcRegistry,
        endpoint: () => mockLocalHostEntry,
        hostId: mockLocalHostEntry.hostId,
        bearer,
        auth: null,
        clock: null,
        hostCredentialMint: null,
        onHostCredentialState: null,
        evidence: NO_TRANSPORT_EVIDENCE,
        webSocketFactory: createWhatwgStreamWebSocketFactory(),
        dialTimeoutMs: NEVER_MS,
        openAckTimeoutMs: NEVER_MS,
        pingIntervalMs: NEVER_MS,
        pongTimeoutMs: NEVER_MS,
        initialBackoffMs: backoffMs,
        maxBackoffMs: backoffMs,
      });
      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      cleanups.push(() => {
        session.close();
      });
      const statuses: StreamConnectionStatus[] = [];
      session.onStatusChange((status) => {
        statuses.push(status);
      });
      return { statuses, client };
    }

    it("sends the bearer current at the grant, not the one read before the wait", async () => {
      const lease = new MutableBearerLease("token-a", "user-1");
      const holders = await holdEveryGateSlot();
      subscribe(lease);
      await settle();

      const native = await waitQueuedThenGrantAndOpen(
        holders,
        "token-b",
        lease,
      );

      expect(tokenOfOpenFrame(native)).toBe("token-b");
    });

    it("sends no open frame and redials when the bearer is gone at the grant", async () => {
      const lease = new MutableBearerLease("token-a", "user-1");
      const holders = await holdEveryGateSlot();
      const statuses = subscribe(lease);
      await settle();

      const native = await waitQueuedThenGrantAndOpen(holders, "", lease);

      expect(native.sent).toEqual([]);
      expect(native.closed).toEqual({
        code: 4000,
        reason: "missing-open-token",
      });
      expect(statuses).toContain("reconnecting");
      expect(statuses).not.toContain("closed");
    });

    describe("account switch", () => {
      it("sends no other-identity bearer on the next dial after the account switched while the socket was down", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        subscribeWith(liveBearer(provider), REDIAL_BACKOFF_MS);
        await settle();
        const first = instances()[0];
        first.fireOpen();
        first.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        first.fireClose();
        const socketsBeforeSwitch = instances().length;
        signIn(provider, USER_B, "token-b");
        await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);
        for (const native of instances().slice(1)) {
          native.fireOpen();
        }
        await settle();

        expect(instances()).toHaveLength(socketsBeforeSwitch);
        expect(sentTokens()).not.toContain("token-b");
      });

      it("sends no other-identity bearer on an open that waited for a slot", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const holders = await holdEveryGateSlot();
        subscribeWith(liveBearer(provider), NEVER_MS);
        await settle();

        await grantAndOpenAfterWait(holders, () => {
          signIn(provider, USER_B, "token-b");
        });

        expect(sentTokens()).not.toContain("token-b");
      });

      it("sends no other-identity bearer in a rotation push after the account switched", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const { client } = subscribeWith(liveBearer(provider), NEVER_MS);
        await settle();
        const native = instances()[0];
        native.fireOpen();
        native.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        signIn(provider, USER_B, "token-b");
        client.notifyBearerRotated();
        await settle();

        expect(sentTokens()).not.toContain("token-b");
      });

      it("sends no other-identity bearer when the account switched between the open frame and the openAck", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        subscribeWith(liveBearer(provider), NEVER_MS);
        await settle();
        const native = instances()[0];
        native.fireOpen();
        await settle();

        signIn(provider, USER_B, "token-b");
        native.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        expect(sentTokens()).not.toContain("token-b");
      });

      it("opens with the new token after a same-user re-sign-in during the wait", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const holders = await holdEveryGateSlot();
        subscribeWith(liveBearer(provider), NEVER_MS);
        await settle();

        const native = await grantAndOpenAfterWait(holders, () => {
          signIn(provider, USER_A, "token-a2");
        });

        expect(native.sent).toHaveLength(1);
        expect(tokenOfOpenFrame(native)).toBe("token-a2");
      });

      it("dials with the new token after a same-user re-sign-in while the socket was down", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        subscribeWith(liveBearer(provider), REDIAL_BACKOFF_MS);
        await settle();
        const first = instances()[0];
        first.fireOpen();
        first.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        first.fireClose();
        signIn(provider, USER_A, "token-a2");
        await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);
        for (const native of instances().slice(1)) {
          native.fireOpen();
        }
        await settle();

        expect(sentTokens()).toContain("token-a2");
      });

      it("sends no other-identity bearer on a new session of a client that already served another user", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const { client } = subscribeWith(liveBearer(provider), NEVER_MS);
        await settle();
        const first = instances()[0];
        first.fireOpen();
        first.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        signIn(provider, USER_B, "token-b");
        const second = client.subscribe("epic.subscribe", { epicId: "epic-2" });
        cleanups.push(() => {
          second.close();
        });
        await settle();
        for (const native of instances().slice(1)) {
          native.fireOpen();
        }
        await settle();

        expect(sentTokens()).not.toContain("token-b");
      });

      it("pushes the rotated token to an open session after a same-user rotation in place", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const { client } = subscribeWith(liveBearer(provider), NEVER_MS);
        await settle();
        const native = instances()[0];
        native.fireOpen();
        native.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        provider.rotateCurrentBearer({
          userId: USER_A,
          bearerToken: "token-a2",
        });
        client.notifyBearerRotated();
        await settle();

        expect(sentTokens()).toContain("token-a2");
      });
    });
  });

  describe("unary", () => {
    it("sends the bearer current at the grant, not the one read before the wait", async () => {
      const lease = new MutableBearerLease("token-a", "user-1");
      const holders = await holdEveryGateSlot();
      startEcho(lease);
      await settle();

      const native = await waitQueuedThenGrantAndOpen(
        holders,
        "token-b",
        lease,
      );

      expect(tokenOfOpenFrame(native)).toBe("token-b");
    });

    it("sends no open frame and rejects naming the bearer when it is gone at the grant", async () => {
      const lease = new MutableBearerLease("token-a", "user-1");
      const holders = await holdEveryGateSlot();
      const call = startEcho(lease);
      await settle();

      const native = await waitQueuedThenGrantAndOpen(holders, "", lease);

      expect(native.sent).toEqual([]);
      expect(call.isSettled()).toBe(true);
      const result = await call.outcome;
      if (result.ok || !(result.error instanceof HostRpcError)) {
        throw new Error("Expected the call to fail with a HostRpcError");
      }
      expect(result.error.code).toBe("RPC_ERROR");
      expect(result.error.message).toMatch(/bearer/i);
      expect(native.closed).not.toBeNull();
    });

    it("rejects a call queued behind the gate when the account switches, and sends no other-identity bearer", async () => {
      const provider = newProvider();
      const contextA = provider.setSignedIn({
        user: userFixture(USER_A),
        bearerToken: "token-a",
        operationId: undefined,
        externalAbortSignal: undefined,
      });
      const holders = await holdEveryGateSlot();
      const call = startEchoFor(contextA.credentials, contextA.abortSignal);
      await settle();
      expect(hostDialGate.stats().queued).toBe(1);

      signIn(provider, USER_B, "token-b");
      await vi.advanceTimersByTimeAsync(QUEUED_FOR_MS);
      holders[0].fireOpen();
      await settle();

      expect(sentTokens()).not.toContain("token-b");
      expect(call.isSettled()).toBe(true);
      const result = await call.outcome;
      expect(result.ok).toBe(false);
    });
  });
});
