import { describe, expect, it, vi } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { RevalidateOutcome } from "../bearer-revalidator";
import type { BearerSourceProvider } from "../bearer-source";
import {
  hostTokenBearer,
  hostTokenBearerFor,
  hostTokenRevalidator,
  hostTokenStreamAuth,
  hostTokenUnaryRevalidator,
  trackHostTokenMints,
  type HostTokenAccess,
} from "../host-token-lease";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenRenewal,
  type HostTokenMintOutcome,
} from "../host-token-source";
import { mintHostTokenViaHttp } from "../../host-transport/remote/grant-client";
import {
  createReleasedHostMemory,
  hostTokenUnobtainable,
} from "../../host-transport/released-sign-on";
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
      trackHostTokenMints(tokens, createReleasedHostMemory()),
      bearer,
      HOST_IDS[0],
      () => undefined,
    );

    await Promise.all([
      tokens.renew(USER_ID, HOST_IDS),
      tokens.renew(USER_ID, HOST_IDS),
      tokens.renew(USER_ID, HOST_IDS),
    ]);
    const bearerBeforeRotation = streamBearer(HOST_IDS[0], () => true);
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
      () => true,
    );
    const localClient = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => ({ ...mockLocalHostEntry, hostId }),
      hostId,
      bearer: hostTokenBearer(
        trackHostTokenMints(localTokens, createReleasedHostMemory()),
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
      () => true,
    );
    const remote = createRemoteHostTransport({
      opensReleasedWay: () => false,
      confirmRowBeforeSignIn: null,
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
    const bearerMint = deferred<{
      readonly pending: Promise<HostTokenMintOutcome>;
    }>();
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
      loaded: () => tokens.loaded(),
      whenLoaded: () => tokens.whenLoaded(),
      obtain: (userId, requestedHostId, fresh, ask) => {
        const pending = tokens.obtain(userId, requestedHostId, fresh, ask);
        bearerMint.resolve({ pending });
        return pending;
      },
      lastFailureOf: (userId, owner) => tokens.lastFailureOf(userId, owner),
    };
    const bearer = hostTokenBearer(
      trackHostTokenMints(access, createReleasedHostMemory()),
      () => signInLease,
      hostId,
      (_refusedHostId, state) => states.push(state),
    );

    expect(bearer(hostId, () => true)).toBeNull();
    await started.promise;
    const { pending: mintChain } = await bearerMint.promise;
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
    const bearerFor = hostTokenBearerFor(
      trackHostTokenMints(tokens, createReleasedHostMemory()),
      (_refusedHostId, state) => states.push(state),
    );
    const pending = bearerFor(
      hostId,
      signInLease,
      true,
      new AbortController().signal,
    );
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
      hosts: createReleasedHostMemory(),
      currentUserId: () => USER_A,
      hostId: "era-retry-host",
      signInRecovery: null,
      onState: () => undefined,
      now: () => Date.now(),
    });

    const pending = revalidator.revalidateRefused({
      code: "UNAUTHORIZED",
      reason: "the host says the token expired",
      retryable: false,
      doorReason: "token_expired",
      incompatibleMethods: null,
      upgradeGuidance: null,
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
      hosts: createReleasedHostMemory(),
      currentUserId: () => currentUserId,
      hostId: "era-retry-host",
      signInRecovery: null,
      onState: () => undefined,
      now: () => Date.now(),
    });

    const pending = revalidator.revalidateRefused({
      code: "UNAUTHORIZED",
      reason: "the host says the token expired",
      retryable: false,
      doorReason: "token_expired",
      incompatibleMethods: null,
      upgradeGuidance: null,
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

describe("how a pair's last mint ended", () => {
  const HOST_ID = "computer-last-failure";
  const hosts = createReleasedHostMemory();
  const owner = hosts.currentInstance(HOST_ID);
  const ask = { signal: null, owner };

  it("is forgotten when the person's era moves, and a late answer from the old era does not set it", async () => {
    const oldEraAnswer = deferred<HostTokenMintOutcome>();
    const oldEraAsked = deferred<void>();
    let mintCalls = 0;
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        if (mintCalls === 1) return Promise.resolve({ kind: "not-a-member" });
        oldEraAsked.resolve();
        return oldEraAnswer.promise;
      },
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_BEFORE : null),
      now: () => Date.now(),
    });
    await tokens.whenLoaded();

    await tokens.obtain(USER_ID, HOST_ID, true, ask);
    expect(tokens.lastFailureOf(USER_ID, owner)).toBe("not-a-member");

    await tokens.forgetUser(USER_ID);
    expect(tokens.lastFailureOf(USER_ID, owner)).toBeNull();

    const pending = tokens.obtain(USER_ID, HOST_ID, true, ask);
    await oldEraAsked.promise;
    await tokens.forgetUser(USER_ID);
    oldEraAnswer.resolve({ kind: "not-a-member" });
    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(tokens.lastFailureOf(USER_ID, owner)).toBeNull();
  });

  it("is unavailable when the token a mint bought could not be saved, whatever refused the pair before", async () => {
    const memory = createMemoryHostTokenPersistence();
    let saveFails = false;
    let mintCalls = 0;
    const tokens = createHostTokenSource({
      persistence: {
        load: () => memory.load(),
        update: (change) =>
          saveFails
            ? Promise.reject(new Error("disk full"))
            : memory.update(change),
      },
      mint: () => {
        mintCalls += 1;
        return Promise.resolve<HostTokenMintOutcome>(
          mintCalls === 1
            ? { kind: "not-a-member" }
            : {
                kind: "ok",
                token: {
                  token: "unsaved-token",
                  expiresAtMs: Date.now() + 60_000,
                },
              },
        );
      },
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_BEFORE : null),
      now: () => Date.now(),
    });
    await tokens.whenLoaded();
    await tokens.obtain(USER_ID, HOST_ID, true, ask);
    expect(tokens.lastFailureOf(USER_ID, owner)).toBe("not-a-member");

    saveFails = true;
    await expect(tokens.obtain(USER_ID, HOST_ID, true, ask)).rejects.toThrow(
      "disk full",
    );
    expect(tokens.lastFailureOf(USER_ID, owner)).toBe("unavailable");
  });
});

describe("a held host-only token the host refused as expired while this clock reads it usable", () => {
  const HOST_ID = "computer-refused-usable";
  const refusedToken = "usable-but-refused-host-token";
  const freshToken = "host-token-bought-after-the-refusal";

  async function rigWithRefusedToken() {
    const answer = deferred<HostTokenMintOutcome>();
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => answer.promise,
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_BEFORE : null),
      now: () => Date.now(),
    });
    await source.adopt(
      USER_ID,
      HOST_ID,
      { token: refusedToken, expiresAtMs: Date.now() + 60_000 },
      source.era(USER_ID),
      () => true,
    );
    const hosts = createReleasedHostMemory();
    const tokens = trackHostTokenMints(source, hosts);
    tokens.noteHeldRefused(
      hosts.currentInstance(HOST_ID),
      USER_ID,
      refusedToken,
    );
    const bearerFor = hostTokenBearerFor(tokens, () => undefined);
    const lease = new MutableBearerLease(SIGN_IN_BEFORE, USER_ID);
    return {
      source,
      answerWithFreshToken: () =>
        answer.resolve({
          kind: "ok",
          token: { token: freshToken, expiresAtMs: Date.now() + 60_000 },
        }),
      bearerFor: (waitForMint: boolean) =>
        bearerFor(HOST_ID, lease, waitForMint, new AbortController().signal),
    };
  }

  it("is no token to a call that does not wait: none at once, while a fresh mint buys another in the background", async () => {
    const rig = await rigWithRefusedToken();

    expect(await rig.bearerFor(false)).toBeNull();
    rig.answerWithFreshToken();
    await vi.waitFor(() =>
      expect(rig.source.current(USER_ID, HOST_ID)?.token).toBe(freshToken),
    );
  });

  it("is replaced by the token a fresh mint buys, for a call that waits", async () => {
    const rig = await rigWithRefusedToken();
    const waiting = rig.bearerFor(true);
    rig.answerWithFreshToken();

    const lease = await waiting;
    expect(lease?.getBearerToken()).toBe(freshToken);
  });
});

describe("a late refusal of an older mint", () => {
  const HOST_ID = "computer-late-refusal";

  it("leaves the newer mint's success standing, and no invitation is answered with the sign-in because of it", async () => {
    // Two mints for one pair run at once: the sign-in rotated between them, so
    // they are separate flights. The older stays pending while the newer
    // obtains and stores a token.
    let signIn = signInToken(1_000_000);
    const olderAnswer = deferred<HostTokenMintOutcome>();
    const olderAsked = deferred<void>();
    const newerToken = {
      token: "host-token-of-the-newer-mint",
      expiresAtMs: Date.now() + 60_000,
    };
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (_hostId, mintedWith) => {
        if (mintedWith === signInToken(1_000_000)) {
          olderAsked.resolve();
          return olderAnswer.promise;
        }
        return Promise.resolve<HostTokenMintOutcome>({
          kind: "ok",
          token: newerToken,
        });
      },
      signIn: (userId) => (userId === USER_ID ? signIn : null),
      now: () => Date.now(),
    });
    await source.whenLoaded();
    const hosts = createReleasedHostMemory();
    const ask = { signal: null, owner: hosts.currentInstance(HOST_ID) };

    const older = source.obtain(USER_ID, HOST_ID, true, ask);
    await olderAsked.promise;
    signIn = signInToken(2_000_000);
    await source.obtain(USER_ID, HOST_ID, true, ask);
    expect(source.current(USER_ID, HOST_ID)?.token).toBe(newerToken.token);

    olderAnswer.resolve({ kind: "not-admitted" });
    await expect(older).resolves.toEqual({ kind: "not-admitted" });

    expect(source.lastFailureOf(USER_ID, ask.owner)).toBeNull();
    expect(
      hostTokenUnobtainable(
        trackHostTokenMints(source, hosts),
        USER_ID,
        HOST_ID,
      ),
    ).toBe(false);
  });
});

describe("how a pair's last mint ended, across host process instances", () => {
  const HOST_ID = "computer-replaced";

  it("starts afresh for a replacement process, whatever its predecessor's mint ended in", async () => {
    const hosts = createReleasedHostMemory();
    hosts.observeInstance(HOST_ID, "process-a");
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "not-a-member" }),
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_BEFORE : null),
      now: () => Date.now(),
    });
    await source.whenLoaded();
    const tokens = trackHostTokenMints(source, hosts);

    await tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: hosts.currentInstance(HOST_ID),
    });
    expect(tokens.lastFailure(USER_ID, HOST_ID)).toBe("not-a-member");

    hosts.observeInstance(HOST_ID, "process-b");
    expect(tokens.lastFailure(USER_ID, HOST_ID)).toBeNull();
  });
});

describe("a session recovery's sign-in refresh across an admission", () => {
  const HOST_ID = "computer-refresh-across-admission";
  const REFUSED_NOT_ADMITTED: FatalErrorDetails = {
    code: "UNAUTHORIZED",
    reason: "current-host-refusal",
    doorReason: "not_admitted",
    retryable: false,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };

  /** A local stream's recovery whose mints authn always refuses the sign-in for. */
  async function recoveryWithAuthnRefusingTheSignIn() {
    const hosts = createReleasedHostMemory();
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "sign-in-rejected" }),
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_BEFORE : null),
      now: () => Date.now(),
    });
    await source.adopt(
      USER_ID,
      HOST_ID,
      { token: "held-host-token", expiresAtMs: Date.now() + 60_000 },
      source.era(USER_ID),
      () => true,
    );
    // The refresh requests authn received, each answered when the test says so.
    const refreshRequests: Array<(outcome: RevalidateOutcome) => void> = [];
    const stream = hostTokenStreamAuth(
      {
        tokens: trackHostTokenMints(source, hosts),
        hosts,
        currentUserId: () => USER_ID,
        hostId: HOST_ID,
        signInRecovery: {
          revalidateForReconnect: () =>
            new Promise<RevalidateOutcome>((resolve) => {
              refreshRequests.push(resolve);
            }),
        },
        onState: () => undefined,
        now: () => Date.now(),
      },
      null,
    );
    return {
      refreshRequests,
      refused: () =>
        stream.auth(() => true).revalidateRefused(REFUSED_NOT_ADMITTED),
      admitted: () => stream.door.admitted(hosts.currentInstance(HOST_ID)),
    };
  }

  it("refreshes again for the newer sequence when the older refresh answers after the admission", async () => {
    const rig = await recoveryWithAuthnRefusingTheSignIn();
    const older = rig.refused();
    await vi.waitFor(() => expect(rig.refreshRequests).toHaveLength(1));

    rig.admitted();
    rig.refreshRequests[0]("rotated");
    await older;

    const newer = rig.refused();
    await vi.waitFor(() => expect(rig.refreshRequests).toHaveLength(2));
    rig.refreshRequests[1]("network-error");
    await newer;
  });

  it("refreshes for the newer sequence's own refusal, never joining the older sequence's refresh still running", async () => {
    const rig = await recoveryWithAuthnRefusingTheSignIn();
    const older = rig.refused();
    await vi.waitFor(() => expect(rig.refreshRequests).toHaveLength(1));

    rig.admitted();
    const newer = rig.refused();
    await vi.waitFor(() => expect(rig.refreshRequests).toHaveLength(2));

    rig.refreshRequests[1]("network-error");
    rig.refreshRequests[0]("network-error");
    await Promise.all([older, newer]);
  });
});

describe("a recovery's bounds across host process instances", () => {
  const HOST_ID = "computer-recovery-replaced";
  const REFUSED_NOT_ADMITTED: FatalErrorDetails = {
    code: "UNAUTHORIZED",
    reason: "current-host-refusal",
    doorReason: "not_admitted",
    retryable: false,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };

  /** A source holding a token for the computer, whose every mint buys the next one. */
  async function sourceHoldingAToken() {
    const mints: string[] = [];
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId) => {
        mints.push(hostId);
        const outcome: HostTokenMintOutcome = {
          kind: "ok",
          token: {
            token: `host-token-${mints.length}`,
            expiresAtMs: Date.now() + 3_600_000,
          },
        };
        return Promise.resolve(outcome);
      },
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_BEFORE : null),
      now: () => Date.now(),
    });
    await source.adopt(
      USER_ID,
      HOST_ID,
      { token: "held-host-token", expiresAtMs: Date.now() + 3_600_000 },
      source.era(USER_ID),
      () => true,
    );
    return { source, mints };
  }

  it("asks authn again for the replacement process's first not_admitted refusal, after the earlier process's refusal was recovered", async () => {
    const hosts = createReleasedHostMemory();
    hosts.observeInstance(HOST_ID, "process-a");
    const { source, mints } = await sourceHoldingAToken();
    const reports: string[] = [];
    const stream = hostTokenStreamAuth(
      {
        tokens: trackHostTokenMints(source, hosts),
        hosts,
        currentUserId: () => USER_ID,
        hostId: HOST_ID,
        signInRecovery: null,
        onState: (_hostId, state) => reports.push(state),
        now: () => Date.now(),
      },
      null,
    );
    const revalidator = stream.auth(() => true);
    await expect(
      revalidator.revalidateRefused(REFUSED_NOT_ADMITTED),
    ).resolves.toBe("rotated");
    expect(mints).toHaveLength(1);

    hosts.observeInstance(HOST_ID, "process-b");

    await expect(
      revalidator.revalidateRefused(REFUSED_NOT_ADMITTED),
    ).resolves.toBe("rotated");
    expect(mints).toHaveLength(2);
    expect(reports).toEqual([]);
  });

  it("asks authn again for a call to the replacement process whose first not_admitted refusal follows the earlier process's recovered one", async () => {
    const hosts = createReleasedHostMemory();
    hosts.observeInstance(HOST_ID, "process-a");
    const { source, mints } = await sourceHoldingAToken();
    const reports: string[] = [];
    const unary = hostTokenUnaryRevalidator({
      tokens: trackHostTokenMints(source, hosts),
      hosts,
      currentUserId: () => USER_ID,
      signInRecovery: null,
      onState: (_hostId, state) => reports.push(state),
      now: () => Date.now(),
    });
    const lease = new MutableBearerLease(SIGN_IN_BEFORE, USER_ID);
    const refusedCall = (): Promise<unknown> =>
      unary.revalidateRefusedBearer(
        lease,
        HOST_ID,
        REFUSED_NOT_ADMITTED,
        new AbortController().signal,
      );
    await expect(refusedCall()).resolves.toBe("rotated");
    expect(mints).toHaveLength(1);

    hosts.observeInstance(HOST_ID, "process-b");

    await expect(refusedCall()).resolves.toBe("rotated");
    expect(mints).toHaveLength(2);
    expect(reports).toEqual([]);
  });
});

describe("an owned ask while a renewal's mint is running", () => {
  const HOST_ID = "computer-owned-ask-joins-renewal";
  const RENEWED_TOKEN = {
    token: "renewed-host-token",
    expiresAtMs: 10_000_000,
  };

  it("joins the renewal's mint, and takes its outcome", async () => {
    const renewalMint = deferred<HostTokenMintOutcome>();
    const mints: string[] = [];
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId) => {
        mints.push(hostId);
        return renewalMint.promise;
      },
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_BEFORE : null),
      now: () => 1_000,
    });
    const renewal = source.renew(USER_ID, [HOST_ID]);
    await vi.waitFor(() => expect(mints).toHaveLength(1));

    const ask = source.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: { hostId: HOST_ID, observed: "100" },
    });
    renewalMint.resolve({ kind: "ok", token: RENEWED_TOKEN });

    await expect(ask).resolves.toEqual({ kind: "ok", token: RENEWED_TOKEN });
    await renewal;
    expect(mints).toHaveLength(1);
  });
});

describe("asks for an observed and an unobserved host process", () => {
  const HOST_ID = "computer-observed-and-unobserved";
  const OK_TOKEN = { token: "observed-host-token", expiresAtMs: 10_000_000 };

  interface HeldMint {
    readonly promise: Promise<HostTokenMintOutcome>;
    readonly resolve: (value: HostTokenMintOutcome) => void;
  }

  /** A source whose every mint request waits for the test, in arrival order. */
  function sourceHoldingEveryMint() {
    const requests: HeldMint[] = [];
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        const request = deferred<HostTokenMintOutcome>();
        requests.push(request);
        return request.promise;
      },
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_BEFORE : null),
      now: () => 1_000,
    });
    return { source, requests };
  }

  const unobserved = { hostId: HOST_ID, observed: null };
  const observed = { hostId: HOST_ID, observed: "200" };

  it("gives a known process's ask its own mint, and its own outcome, when an unobserved process's ask is held first", async () => {
    const { source, requests } = sourceHoldingEveryMint();
    const unknownAsk = source.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: unobserved,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const knownAsk = source.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: observed,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    requests[0].resolve({ kind: "not-admitted" });
    requests[1].resolve({ kind: "ok", token: OK_TOKEN });

    await expect(unknownAsk).resolves.toEqual({ kind: "not-admitted" });
    await expect(knownAsk).resolves.toEqual({ kind: "ok", token: OK_TOKEN });
    expect(source.lastFailureOf(USER_ID, observed)).toBeNull();
  });

  it("gives an unobserved process's ask its own mint, and keeps its outcome from a known process, when the known process's ask is held first", async () => {
    const { source, requests } = sourceHoldingEveryMint();
    const knownAsk = source.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: observed,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const unknownAsk = source.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: unobserved,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    requests[0].resolve({ kind: "ok", token: OK_TOKEN });
    requests[1].resolve({ kind: "not-admitted" });

    await expect(knownAsk).resolves.toEqual({ kind: "ok", token: OK_TOKEN });
    await expect(unknownAsk).resolves.toEqual({ kind: "not-admitted" });
    expect(source.lastFailureOf(USER_ID, observed)).toBeNull();
  });
});

describe("an adopted token whose caller stopped wanting it before the write", () => {
  const HOST_ID = "computer-adopt-no-longer-wanted";
  const OLD_TOKEN = { token: "old-host-token", expiresAtMs: 10_000_000 };
  const NEW_TOKEN = { token: "new-host-token", expiresAtMs: 10_000_000 };

  it("keeps the held token when the write is released after the caller stopped wanting the new one", async () => {
    const inner = createMemoryHostTokenPersistence();
    let writeHeld = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = createHostTokenSource({
      persistence: {
        load: () => inner.load(),
        update: async (change) => {
          if (writeHeld) await gate;
          return inner.update(change);
        },
      },
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => 1_000,
    });
    await source.adopt(
      USER_ID,
      HOST_ID,
      OLD_TOKEN,
      source.era(USER_ID),
      () => true,
    );
    expect(source.current(USER_ID, HOST_ID)).toEqual(OLD_TOKEN);

    writeHeld = true;
    let wanted = true;
    const adopting = source.adopt(
      USER_ID,
      HOST_ID,
      NEW_TOKEN,
      source.era(USER_ID),
      () => wanted,
    );
    wanted = false;
    release();
    await adopting;

    expect(source.current(USER_ID, HOST_ID)).toEqual(OLD_TOKEN);
  });
});

describe("two adopted tokens for one pair, the older one's write landing last", () => {
  const HOST_ID = "computer-adopt-write-order";
  const OLDER = { token: "older-adopted-token", expiresAtMs: 10_000_000 };
  const NEWER = { token: "newer-adopted-token", expiresAtMs: 10_000_000 };

  it("drops the older adopt's write and keeps the table at the newer token", async () => {
    const inner = createMemoryHostTokenPersistence();
    let writes = 0;
    let releaseFirstWrite: () => void = () => undefined;
    const firstWriteHeld = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const source = createHostTokenSource({
      persistence: {
        load: () => inner.load(),
        update: async (change) => {
          writes += 1;
          if (writes === 1) await firstWriteHeld;
          return inner.update(change);
        },
      },
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => 1_000,
    });
    const era = source.era(USER_ID);

    const olderAdopt = source.adopt(USER_ID, HOST_ID, OLDER, era, () => true);
    await vi.waitFor(() => expect(writes).toBe(1));
    await source.adopt(USER_ID, HOST_ID, NEWER, era, () => true);
    expect(source.current(USER_ID, HOST_ID)).toEqual(NEWER);

    releaseFirstWrite();
    await olderAdopt;

    expect(source.current(USER_ID, HOST_ID)).toEqual(NEWER);
  });
});
