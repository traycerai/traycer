import { afterEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { HostDirectoryEntry } from "../../host-client/host-directory";
import {
  LocalOpenAuth,
  SESSION_GRANT_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED,
} from "../local-open-auth";
import { NO_TRANSPORT_EVIDENCE } from "../../host-selection/transport-evidence";
import { WsStreamClient } from "../ws-stream-client";
import { TEST_CLIENT_IDENTITY } from "../../test-fixtures/client-identity";
import { MutableBearerLease } from "../../auth/bearer-source";
import type { StreamAuthRevalidator } from "../../auth/bearer-revalidator";
import { resetNegotiatedStreamVersions } from "../negotiated-stream-version-registry";
import { resetStreamMethodSupportMemo } from "../stream-method-support-registry";
import {
  createLocalGrantStreamSocketFactory,
  parseLocalGrantStreamText,
  type LocalGrantStreamSocket,
  type LocalGrantStreamSocketFactory,
} from "./local-team-grant-test-support";

const host: HostDirectoryEntry = {
  hostId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  label: "Test local computer",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "test",
  transportDialability: "dialable",
};

const method = "host.notifications.feed.subscribe";
const userId = createAuthenticatedUserFixture(undefined).user.id;

function makeClient(
  factory: LocalGrantStreamSocketFactory["factory"],
  localOpenAuth: LocalOpenAuth,
  bearer: MutableBearerLease,
  auth: StreamAuthRevalidator | null,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    hostId: host.hostId,
    userId,
    endpoint: () => host,
    bearer: () => bearer,
    localOpenAuth,
    auth,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 100,
  });
}

function openFrame(socket: LocalGrantStreamSocket): Record<string, unknown> {
  const frame = socket.textSent
    .map(parseLocalGrantStreamText)
    .find((item) => item.kind === "open");
  if (frame === undefined) throw new Error("Expected an open frame");
  return frame;
}

function openAck(socket: LocalGrantStreamSocket): object {
  return { kind: "openAck", manifest: openFrame(socket).manifest };
}

function sessionGrantChallenge(): object {
  return {
    kind: "fatalError",
    details: {
      code: SESSION_GRANT_REQUIRED,
      reason: "session grant required",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function changedDoorFatal(): object {
  return {
    kind: "fatalError",
    details: {
      code: "LOCAL_HOST_REPLACED",
      reason: "host identity changed",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function membershipRequiredFatal(): object {
  return {
    kind: "fatalError",
    details: {
      code: TEAM_MEMBERSHIP_REQUIRED,
      reason: "membership required",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("WsStreamClient local grant recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetNegotiatedStreamVersions();
    resetStreamMethodSupportMemo();
  });

  it("revalidates an expired user bearer before minting a cached-path grant", async () => {
    vi.useFakeTimers();
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    const expiredBearer = new MutableBearerLease(
      "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.sig",
      userId,
    );
    const events: string[] = [];
    const revalidation = deferred<"rotated">();
    const revalidateStarted = deferred<void>();
    const auth: StreamAuthRevalidator = {
      revalidateForReconnect: () => {
        events.push("revalidate");
        revalidateStarted.resolve();
        return revalidation.promise;
      },
    };
    const mintSessionGrant = vi.fn(() => {
      events.push("mint");
      return Promise.resolve({ kind: "ok", token: "one-use-grant" } as const);
    });
    const localOpenAuth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant,
    });
    localOpenAuth.noteSessionGrantRequired(host.hostId);
    const client = makeClient(factory, localOpenAuth, expiredBearer, auth);
    const session = client.subscribe(method, {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });

    await revalidateStarted.promise;
    expect(sockets).toHaveLength(0);
    expect(mintSessionGrant).not.toHaveBeenCalled();

    expiredBearer.rotate("eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDB9.sig");
    events.push("revalidated");
    revalidation.resolve("rotated");
    const socketPromise = nextSocket();
    await vi.advanceTimersByTimeAsync(10);
    const socket = await socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    const open = await openWait;

    expect(open.token).toBe("one-use-grant");
    expect(events).toEqual(["revalidate", "revalidated", "mint"]);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    session.close();
    client.close("test-teardown");
  });

  it("keeps the no-revalidator path on the existing direct grant behavior", async () => {
    vi.useFakeTimers();
    const { factory, nextSocket } = createLocalGrantStreamSocketFactory();
    const bearer = new MutableBearerLease(
      "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.sig",
      userId,
    );
    const mintStarted = deferred<void>();
    const mintSessionGrant = vi.fn(() => {
      mintStarted.resolve();
      return Promise.resolve({ kind: "ok", token: "one-use-grant" } as const);
    });
    const localOpenAuth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant,
    });
    localOpenAuth.noteSessionGrantRequired(host.hostId);
    const client = makeClient(factory, localOpenAuth, bearer, null);
    const session = client.subscribe(method, {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });

    await mintStarted.promise;
    const socket = await nextSocket();
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    expect((await openWait).token).toBe("one-use-grant");
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    session.close();
    client.close("test-teardown");
  });

  it("resets the one-reprobe allowance after a quiet healthy dwell", async () => {
    vi.useFakeTimers();
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    let grantNumber = 0;
    const mintSessionGrant = vi.fn(() => {
      grantNumber += 1;
      return Promise.resolve({
        kind: "ok",
        token: `one-use-grant-${grantNumber}`,
      } as const);
    });
    const bearer = new MutableBearerLease("user-bearer", userId);
    const localOpenAuth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant,
    });
    const client = makeClient(factory, localOpenAuth, bearer, null);
    const session = client.subscribe(method, {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });

    const userSocket = await nextSocket();
    const userOpenWait = userSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    userSocket.fireOpen();
    expect((await userOpenWait).token).toBe("user-bearer");

    const firstGrantSocketPromise = nextSocket();
    userSocket.fireText(sessionGrantChallenge());
    const firstGrantSocket = await firstGrantSocketPromise;
    const firstGrantOpenWait = firstGrantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstGrantSocket.fireOpen();
    expect((await firstGrantOpenWait).token).toBe("one-use-grant-1");
    const reprobeSocketPromise = nextSocket();
    firstGrantSocket.fireText(changedDoorFatal());
    await vi.advanceTimersByTimeAsync(10);
    const reprobeSocket = await reprobeSocketPromise;
    const reprobeOpenWait = reprobeSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    reprobeSocket.fireOpen();
    expect((await reprobeOpenWait).token).toBe("user-bearer");

    const healthyGrantSocketPromise = nextSocket();
    reprobeSocket.fireText(sessionGrantChallenge());
    const healthyGrantSocket = await healthyGrantSocketPromise;
    const healthyGrantOpenWait = healthyGrantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    healthyGrantSocket.fireOpen();
    expect((await healthyGrantOpenWait).token).toBe("one-use-grant-2");
    const subscribeWait = healthyGrantSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    healthyGrantSocket.fireText(openAck(healthyGrantSocket));
    await subscribeWait;

    await vi.advanceTimersByTimeAsync(10_000);
    const wakeSocketPromise = nextSocket();
    client.reconnectAll("test-wake", {
      probeFirst: false,
      wakeProbe: null,
    });
    await vi.advanceTimersByTimeAsync(10);
    const wakeSocket = await wakeSocketPromise;
    const wakeOpenWait = wakeSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    wakeSocket.fireOpen();
    expect((await wakeOpenWait).token).toBe("one-use-grant-3");

    const recoveredUserSocketPromise = nextSocket();
    wakeSocket.fireText(changedDoorFatal());
    await vi.advanceTimersByTimeAsync(10);
    const recoveredUserSocket = await recoveredUserSocketPromise;
    const recoveredUserOpenWait = recoveredUserSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    recoveredUserSocket.fireOpen();

    expect((await recoveredUserOpenWait).token).toBe("user-bearer");
    expect(sockets).toHaveLength(6);
    expect(mintSessionGrant).toHaveBeenCalledTimes(3);
    session.close();
    client.close("test-teardown");
  });

  it("keeps a membership refusal terminal through wake and retries only after invalidation", async () => {
    vi.useFakeTimers();
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    const mintSessionGrant = vi.fn(() =>
      Promise.resolve({ kind: "ok", token: "one-use-grant" } as const),
    );
    const localOpenAuth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant,
    });
    const bearer = new MutableBearerLease("user-bearer", userId);
    const client = makeClient(factory, localOpenAuth, bearer, null);
    const session = client.subscribe(method, {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));

    const userSocket = await nextSocket();
    const userOpenWait = userSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    userSocket.fireOpen();
    await userOpenWait;
    const grantSocketPromise = nextSocket();
    userSocket.fireText(sessionGrantChallenge());
    const grantSocket = await grantSocketPromise;
    const grantOpenWait = grantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    grantSocket.fireOpen();
    await grantOpenWait;
    grantSocket.fireText(membershipRequiredFatal());

    expect(statuses).toContain("closed");
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    client.reconnectAll("wake-after-denial", {
      probeFirst: false,
      wakeProbe: null,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);

    const invalidatedSocketPromise = nextSocket();
    localOpenAuth.invalidateHost(host.hostId, null);
    await vi.advanceTimersByTimeAsync(10);
    const invalidatedSocket = await invalidatedSocketPromise;
    const invalidatedOpenWait = invalidatedSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    invalidatedSocket.fireOpen();
    expect((await invalidatedOpenWait).token).toBe("user-bearer");

    const retriedGrantSocketPromise = nextSocket();
    invalidatedSocket.fireText(sessionGrantChallenge());
    const retriedGrantSocket = await retriedGrantSocketPromise;
    const retriedGrantOpenWait = retriedGrantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    retriedGrantSocket.fireOpen();
    expect((await retriedGrantOpenWait).token).toBe("one-use-grant");
    expect(sockets).toHaveLength(4);
    expect(mintSessionGrant).toHaveBeenCalledTimes(2);
    session.close();
    client.close("test-teardown");
  });

  it("does not revive a denied subscription closed by its caller before invalidation", async () => {
    vi.useFakeTimers();
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    const mintSessionGrant = vi.fn(() =>
      Promise.resolve({ kind: "ok", token: "one-use-grant" } as const),
    );
    const localOpenAuth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant,
    });
    const bearer = new MutableBearerLease("user-bearer", userId);
    const client = makeClient(factory, localOpenAuth, bearer, null);
    const session = client.subscribe(method, {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });
    const userSocket = await nextSocket();
    const userOpenWait = userSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    userSocket.fireOpen();
    await userOpenWait;
    const grantSocketPromise = nextSocket();
    userSocket.fireText(sessionGrantChallenge());
    const grantSocket = await grantSocketPromise;
    const grantOpenWait = grantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    grantSocket.fireOpen();
    await grantOpenWait;
    grantSocket.fireText(membershipRequiredFatal());

    session.close();
    localOpenAuth.invalidateHost(host.hostId, null);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets).toHaveLength(2);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    client.close("test-teardown");
  });
});
