import { describe, expect, it, vi } from "vitest";
import type { BearerSourceProvider } from "../bearer-source";
import {
  hostTokenBearer,
  hostTokenBearerFor,
  hostTokenRevalidator,
  type HostTokenAccess,
} from "../host-token-lease";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenRenewal,
  type HostTokenMintOutcome,
} from "../host-token-source";
import { mintHostTokenViaHttp } from "../../host-transport/remote/grant-client";
import { WsStreamClient } from "../../host-transport/ws-stream-client";
import { createWhatwgStreamWebSocketFactory } from "../../host-transport/whatwg-stream-ws-factory";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { SESSION_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/host-transport/mux";
import { MutableBearerLease } from "../bearer-source";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { NO_TRANSPORT_EVIDENCE } from "../../host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "../../test-fixtures/client-identity";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  sentFramesOfKind,
  signIn,
  USER_A,
} from "../../test-fixtures/dial-gate-harness";
import { RemoteMuxTestPeer } from "../../host-transport/__tests__/remote-mux-test-peer";
import { createRemoteHostTransport } from "../../host-transport/remote/create-remote-transport";
import { retireAllRemoteSessions } from "../../host-transport/remote/active-remote-sessions";

const USER_ID = "user-a";
const HOST_IDS = ["local-computer", "remote-computer"] as const;
const AUTHN = "https://authn.test";
const SIGN_IN_BEFORE = "sign-in-token-before-rotation";
const SIGN_IN_AFTER = "sign-in-token-after-rotation";

function signInToken(expiration: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expiration })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("host-token renewal", () => {
  it("renews each live computer once per sign-in rotation and makes the new token available to the stream", async () => {
    let signInTokenValue = signInToken(2_000_000);
    const mintInputs: Array<{
      readonly hostId: string;
      readonly signIn: string;
    }> = [];
    let tokenIndex = 0;
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId, signIn) => {
        mintInputs.push({ hostId, signIn });
        tokenIndex += 1;
        const outcome: HostTokenMintOutcome = {
          kind: "ok",
          token: {
            token: `host-token-${tokenIndex}`,
            expiresAtMs: Date.now() + 3_600_000,
          },
        };
        return Promise.resolve(outcome);
      },
      signIn: (userId) => (userId === USER_ID ? signInTokenValue : null),
      now: () => Date.now(),
    });
    const signInLease = {
      identity: { userId: USER_ID },
      getBearerToken: () => signInTokenValue,
    };
    const bearer: BearerSourceProvider = () => signInLease;
    const streamBearer = hostTokenBearer(
      tokens,
      bearer,
      HOST_IDS[0],
      () => undefined,
    );

    await Promise.all([
      tokens.renew(USER_ID, HOST_IDS),
      tokens.renew(USER_ID, HOST_IDS),
      tokens.renew(USER_ID, HOST_IDS),
    ]);
    const bearerBeforeRotation = streamBearer();
    if (bearerBeforeRotation === null)
      throw new Error("host token is unavailable");
    expect(bearerBeforeRotation.getBearerToken()).toBe("host-token-1");
    expect(mintInputs).toEqual([
      { hostId: HOST_IDS[0], signIn: signInTokenValue },
      { hostId: HOST_IDS[1], signIn: signInTokenValue },
    ]);

    signInTokenValue = signInToken(2_100_000);
    await Promise.all([
      tokens.renew(USER_ID, HOST_IDS),
      tokens.renew(USER_ID, HOST_IDS),
      tokens.renew(USER_ID, HOST_IDS),
    ]);

    expect(mintInputs.slice(2)).toEqual([
      { hostId: HOST_IDS[0], signIn: signInTokenValue },
      { hostId: HOST_IDS[1], signIn: signInTokenValue },
    ]);
    expect(bearerBeforeRotation.getBearerToken()).toBe("host-token-3");
    expect(tokens.current(USER_ID, HOST_IDS[1])?.token).toBe("host-token-4");
  });

  it("updates live local and relay transports in place after a sign-in rotation", async () => {
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
    retireAllRemoteSessions();

    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_BEFORE);
    let localSignInToken = SIGN_IN_BEFORE;
    const hostId = "renewal-local-computer";
    const relayHostId = "renewal-relay-computer";
    const relayPeer = new RemoteMuxTestPeer();
    relayPeer.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
    let localRenewalAvailable = false;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith(`/${relayHostId}/attach-grant`)) {
        return jsonResponse({
          grant: "relay-pass",
          role: "client",
          expires_in: 300,
          session_grant: "relay-host-token-before-rotation",
          session_grant_expires_in: 3_600,
        });
      }
      if (url.endsWith(`/${hostId}/session-grant`) && !localRenewalAvailable) {
        return new Response("authn unavailable", { status: 503 });
      }
      const hostToken = url.endsWith(`/${relayHostId}/session-grant`)
        ? "relay-host-token-after-rotation"
        : "local-host-token-after-rotation";
      return jsonResponse({
        session_grant: hostToken,
        session_grant_expires_in: 3_600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const localTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (targetHostId, token, signal) =>
        mintHostTokenViaHttp(AUTHN, targetHostId, token, signal),
      signIn: (userId) => (userId === USER_A ? localSignInToken : null),
      now: () => Date.now(),
    });
    await localTokens.adopt(
      USER_A,
      hostId,
      {
        token: "local-host-token-before-rotation",
        expiresAtMs: Date.now() + 3_600_000,
      },
      localTokens.era(USER_A),
    );
    const localClient = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => ({ ...mockLocalHostEntry, hostId }),
      hostId,
      bearer: hostTokenBearer(
        localTokens,
        liveBearer(provider),
        hostId,
        () => undefined,
      ),
      userId: USER_A,
      auth: null,
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: createWhatwgStreamWebSocketFactory(),
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const localSession = localClient.subscribe("epic.subscribe", {
      epicId: "epic-a",
    });
    let localRenewalResult: HostTokenRenewal | null = null;
    let localIsOpen = false;
    localSession.onStatusChange((status) => {
      localIsOpen = status === "open";
    });
    const stopLocalTokenUpdates = localTokens.subscribe(
      ({ userId, hostId: changedHostId }) => {
        if (userId === USER_A && changedHostId === hostId)
          localClient.notifyBearerRotated();
      },
    );
    const stopProviderRotation = provider.onBearerRotated(() => {
      localClient.notifyBearerRotated();
      localSignInToken = SIGN_IN_AFTER;
      void localTokens.renew(USER_A, [hostId]).then((renewal) => {
        localRenewalResult = renewal;
      });
    });

    const relayLease = new MutableBearerLease(SIGN_IN_BEFORE, USER_A);
    let relaySignInValue = SIGN_IN_BEFORE;
    const relayTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (targetHostId, token, signal) =>
        mintHostTokenViaHttp(AUTHN, targetHostId, token, signal),
      signIn: (userId) => (userId === USER_A ? relaySignInValue : null),
      now: () => Date.now(),
    });
    await relayTokens.adopt(
      USER_A,
      relayHostId,
      {
        token: "relay-host-token-before-rotation",
        expiresAtMs: Date.now() + 3_600_000,
      },
      relayTokens.era(USER_A),
    );
    const remote = createRemoteHostTransport({
      hostId: relayHostId,
      userId: USER_A,
      relayAttachUrl: "wss://relay.test/attach",
      authnBaseUrl: AUTHN,
      hostPublicKey: relayPeer.hostPublicKey,
      bearer: () => relayLease,
      hostTokens: relayTokens,
      door: null,
      onState: () => undefined,
      cloudAuthorized: () => true,
      auth: null,
      clock: null,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: relayPeer.factory,
      requestId: () => "renewal-relay-request",
      evidence: NO_TRANSPORT_EVIDENCE,
      clientIdentity: TEST_CLIENT_IDENTITY,
      proactiveWakeEligible: false,
    });
    if (remote === null)
      throw new Error("relay renewal transport did not build");

    try {
      await vi.waitFor(() =>
        expect(FakeNativeWebSocket.instances).toHaveLength(1),
      );
      const localSocket = FakeNativeWebSocket.instances[0];
      localSocket.fireOpen();
      await vi.waitFor(() =>
        expect(sentFramesOfKind(localSocket, "open")).toHaveLength(1),
      );
      const localOpen = sentFramesOfKind(localSocket, "open")[0];
      localSocket.fireMessage(
        JSON.stringify({
          kind: "openAck",
          manifest: localOpen.manifest,
          capabilities: [SESSION_CAPABILITY_CREDENTIAL_UPDATE],
        }),
      );
      await vi.waitFor(() => expect(localIsOpen).toBe(true));

      remote.session.start();
      await vi.waitFor(() => expect(relayPeer.openCount).toBe(1));
      await vi.waitFor(() => expect(remote.session.isReady()).toBe(true));

      provider.rotateCurrentBearer({
        userId: USER_A,
        bearerToken: SIGN_IN_AFTER,
      });
      await vi.waitFor(() => expect(localRenewalResult).not.toBeNull());
      expect(localRenewalResult).toEqual({
        kind: "renewed",
        delayed: [hostId],
      });
      expect(localSocket.closed).toBeNull();
      expect(sentFramesOfKind(localSocket, "open")).toHaveLength(1);
      expect(FakeNativeWebSocket.instances).toHaveLength(1);

      localRenewalAvailable = true;
      await expect(localTokens.renew(USER_A, [hostId])).resolves.toEqual({
        kind: "renewed",
        delayed: [],
      });
      relaySignInValue = SIGN_IN_AFTER;
      relayLease.rotate(SIGN_IN_AFTER);
      await relayTokens.renew(USER_A, [relayHostId]);

      await vi.waitFor(() =>
        expect(
          sentFramesOfKind(localSocket, "credentialUpdate").some(
            (frame) => frame.token === "local-host-token-after-rotation",
          ),
        ).toBe(true),
      );
      await vi.waitFor(() =>
        expect(relayPeer.credentialUpdates).toContainEqual({
          bearer: "relay-host-token-after-rotation",
          memberCredential: null,
        }),
      );

      expect(localTokens.current(USER_A, hostId)?.token).toBe(
        "local-host-token-after-rotation",
      );
      expect(relayTokens.current(USER_A, relayHostId)?.token).toBe(
        "relay-host-token-after-rotation",
      );
      expect(sentFramesOfKind(localSocket, "open")).toHaveLength(1);
      expect(localSocket.closed).toBeNull();
      expect(relayPeer.openCount).toBe(1);
      expect(relayPeer.closeReasons).toEqual([]);
      expect(relayPeer.errors).toEqual([]);
    } finally {
      stopProviderRotation();
      stopLocalTokenUpdates();
      localSession.close();
      localClient.close("test complete");
      remote.session.close();
      retireAllRemoteSessions();
      for (const socket of FakeNativeWebSocket.instances)
        socket.fireClose(1006, "test teardown");
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe("host-token lease after a user era changes", () => {
  it("does not raise state when hostTokenBearer's pending refusal is superseded", async () => {
    const answer = deferred<HostTokenMintOutcome>();
    const started = deferred<void>();
    const bearerMint = deferred<Promise<HostTokenMintOutcome>>();
    const hostId = "era-stream-computer";
    const states: string[] = [];
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        started.resolve();
        return answer.promise;
      },
      signIn: (userId) => (userId === USER_A ? "sign-in-a" : null),
      now: () => 0,
    });
    const signInLease = {
      identity: { userId: USER_A },
      getBearerToken: () => "sign-in-a",
    };
    const access: HostTokenAccess = {
      current: (userId, requestedHostId) =>
        tokens.current(userId, requestedHostId),
      obtain: (userId, requestedHostId, fresh, signal) => {
        const pending = tokens.obtain(userId, requestedHostId, fresh, signal);
        bearerMint.resolve(pending);
        return pending;
      },
    };
    const bearer = hostTokenBearer(
      access,
      () => signInLease,
      hostId,
      (_refusedHostId, state) => states.push(state),
    );

    expect(bearer()).toBeNull();
    await started.promise;
    const mintChain = await bearerMint.promise;
    await tokens.forgetUser(USER_A);
    answer.resolve({ kind: "not-a-member" });

    await expect(mintChain).resolves.toEqual({ kind: "superseded" });
    expect(states).toEqual([]);
  });

  it("does not raise state when hostTokenBearerFor's pending refusal is superseded", async () => {
    const answer = deferred<HostTokenMintOutcome>();
    const started = deferred<void>();
    const hostId = "era-unary-computer";
    const states: string[] = [];
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        started.resolve();
        return answer.promise;
      },
      signIn: (userId) => (userId === USER_A ? "sign-in-a" : null),
      now: () => 0,
    });
    const signInLease = {
      identity: { userId: USER_A },
      getBearerToken: () => "sign-in-a",
    };
    const bearerFor = hostTokenBearerFor(tokens, (_refusedHostId, state) =>
      states.push(state),
    );
    const pending = bearerFor(hostId, signInLease);
    await started.promise;
    await tokens.forgetUser(USER_A);
    answer.resolve({ kind: "not-a-member" });

    await expect(pending).resolves.toBeNull();
    expect(states).toEqual([]);
  });
});

describe("host-token revalidation after an era changes", () => {
  it("retries one superseded mint for the same signed-in person", async () => {
    const firstAnswer = deferred<HostTokenMintOutcome>();
    const firstStarted = deferred<void>();
    let mintCalls = 0;
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        if (mintCalls === 1) {
          firstStarted.resolve();
          return firstAnswer.promise;
        }
        return Promise.resolve({
          kind: "ok",
          token: {
            token: "current-era-token",
            expiresAtMs: Date.now() + 60_000,
          },
        });
      },
      signIn: (userId) => (userId === USER_A ? "sign-in-a" : null),
      now: () => Date.now(),
    });
    const revalidator = hostTokenRevalidator({
      tokens,
      currentUserId: () => USER_A,
      hostId: "era-retry-host",
      signInRecovery: null,
      onState: () => undefined,
      now: () => Date.now(),
    });

    const pending = revalidator.revalidateRefused({
      code: "UNAUTHORIZED",
      retryable: false,
      doorReason: "token_expired",
    });
    await firstStarted.promise;
    await tokens.forgetUser(USER_A);
    firstAnswer.resolve({
      kind: "ok",
      token: { token: "stale-era-token", expiresAtMs: Date.now() + 60_000 },
    });

    await expect(pending).resolves.toBe("rotated");
    expect(mintCalls).toBe(2);
    expect(tokens.current(USER_A, "era-retry-host")?.token).toBe(
      "current-era-token",
    );
  });

  it("does not retry a superseded mint after another person signs in", async () => {
    const firstAnswer = deferred<HostTokenMintOutcome>();
    const firstStarted = deferred<void>();
    let currentUserId: string | null = USER_A;
    let mintCalls = 0;
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        firstStarted.resolve();
        return firstAnswer.promise;
      },
      signIn: (userId) => (userId === USER_A ? "sign-in-a" : null),
      now: () => Date.now(),
    });
    const revalidator = hostTokenRevalidator({
      tokens,
      currentUserId: () => currentUserId,
      hostId: "era-retry-host",
      signInRecovery: null,
      onState: () => undefined,
      now: () => Date.now(),
    });

    const pending = revalidator.revalidateRefused({
      code: "UNAUTHORIZED",
      retryable: false,
      doorReason: "token_expired",
    });
    await firstStarted.promise;
    currentUserId = "user-b";
    await tokens.forgetUser(USER_A);
    firstAnswer.resolve({
      kind: "ok",
      token: { token: "stale-era-token", expiresAtMs: Date.now() + 60_000 },
    });

    await expect(pending).resolves.toBe("rejected");
    expect(mintCalls).toBe(1);
  });
});
