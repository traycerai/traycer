import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import {
  MutableBearerLease,
  type BearerSourceProvider,
  type OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import {
  FakeNativeWebSocket,
  GATE_SLOTS,
  holdEveryGateSlot,
  liveBearer,
  NEVER_MS,
  newProvider,
  QUEUED_FOR_MS,
  settle,
  signIn,
  USER_A,
  USER_B,
  userFixture,
  sentTokens,
} from "../../test-fixtures/dial-gate-harness";
import { echoRegistry } from "./__fixtures__/echo-registry";
import { HostRpcError } from "../host-messenger";
import type { StreamConnectionStatus } from "../i-stream-session";
import { createWhatwgStreamWebSocketFactory } from "../whatwg-stream-ws-factory";
import { createWhatwgWebSocketFactory } from "../whatwg-ws-factory";
import { hostDialGate } from "../ws-dial-gate";
import { WsRpcClient } from "../ws-rpc-client";
import { WsStreamClient } from "../ws-stream-client";

const REQUEST_ID = "req-open-frame-bearer";
const REDIAL_BACKOFF_MS = 50;
const LEASE_USER_ID = "user-1";
const REDIAL_WINDOW_MS = 500;

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
  expect(FakeNativeWebSocket.instances).toHaveLength(GATE_SLOTS);
  holders[0].fireOpen();
  await settle();
  expect(FakeNativeWebSocket.instances).toHaveLength(GATE_SLOTS + 1);
  const native = FakeNativeWebSocket.instances[GATE_SLOTS];
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
    for (const native of FakeNativeWebSocket.instances) {
      native.fireClose(1006, "test");
    }
    await settle();
    expect(hostDialGate.stats()).toMatchObject({ connecting: 0, queued: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("stream", () => {
    function subscribe(lease: MutableBearerLease): StreamConnectionStatus[] {
      return subscribeWith(() => lease, LEASE_USER_ID, NEVER_MS).statuses;
    }

    function subscribeWith(
      bearer: BearerSourceProvider,
      userId: string,
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
        userId,
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
      const lease = new MutableBearerLease("token-a", LEASE_USER_ID);
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
      const lease = new MutableBearerLease("token-a", LEASE_USER_ID);
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
        subscribeWith(liveBearer(provider), USER_A, REDIAL_BACKOFF_MS);
        await settle();
        const first = FakeNativeWebSocket.instances[0];
        first.fireOpen();
        first.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        first.fireClose(1006, "test");
        const socketsBeforeSwitch = FakeNativeWebSocket.instances.length;
        signIn(provider, USER_B, "token-b");
        await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);
        for (const native of FakeNativeWebSocket.instances.slice(1)) {
          native.fireOpen();
        }
        await settle();

        expect(FakeNativeWebSocket.instances).toHaveLength(socketsBeforeSwitch);
        expect(sentTokens()).not.toContain("token-b");
      });

      it("sends no other-identity bearer on an open that waited for a slot", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const holders = await holdEveryGateSlot();
        subscribeWith(liveBearer(provider), USER_A, NEVER_MS);
        await settle();

        await grantAndOpenAfterWait(holders, () => {
          signIn(provider, USER_B, "token-b");
        });

        expect(sentTokens()).not.toContain("token-b");
      });

      it("sends no other-identity bearer in a rotation push after the account switched", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const { client } = subscribeWith(
          liveBearer(provider),
          USER_A,
          NEVER_MS,
        );
        await settle();
        const native = FakeNativeWebSocket.instances[0];
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
        subscribeWith(liveBearer(provider), USER_A, NEVER_MS);
        await settle();
        const native = FakeNativeWebSocket.instances[0];
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
        subscribeWith(liveBearer(provider), USER_A, NEVER_MS);
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
        subscribeWith(liveBearer(provider), USER_A, REDIAL_BACKOFF_MS);
        await settle();
        const first = FakeNativeWebSocket.instances[0];
        first.fireOpen();
        first.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        first.fireClose(1006, "test");
        signIn(provider, USER_A, "token-a2");
        await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);
        for (const native of FakeNativeWebSocket.instances.slice(1)) {
          native.fireOpen();
        }
        await settle();

        expect(sentTokens()).toContain("token-a2");
      });

      it("sends no other-identity bearer on a new session of a client that already served another user", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const { client } = subscribeWith(
          liveBearer(provider),
          USER_A,
          NEVER_MS,
        );
        await settle();
        const first = FakeNativeWebSocket.instances[0];
        first.fireOpen();
        first.fireMessage(openAckAdvertisingCredentialUpdate());
        await settle();

        signIn(provider, USER_B, "token-b");
        const second = client.subscribe("epic.subscribe", { epicId: "epic-2" });
        cleanups.push(() => {
          second.close();
        });
        await settle();
        for (const native of FakeNativeWebSocket.instances.slice(1)) {
          native.fireOpen();
        }
        await settle();

        expect(sentTokens()).not.toContain("token-b");
      });

      it("pushes the rotated token to an open session after a same-user rotation in place", async () => {
        const provider = newProvider();
        signIn(provider, USER_A, "token-a");
        const { client } = subscribeWith(
          liveBearer(provider),
          USER_A,
          NEVER_MS,
        );
        await settle();
        const native = FakeNativeWebSocket.instances[0];
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
      const lease = new MutableBearerLease("token-a", LEASE_USER_ID);
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
      const lease = new MutableBearerLease("token-a", LEASE_USER_ID);
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
