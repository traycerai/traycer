import { afterEach, describe, expect, it, vi } from "vitest";
import {
  identityFromAuthenticatedUser,
  createRequestContext,
} from "@traycer/protocol/auth/request-context";
import {
  STREAM_CAPABILITY_CREDENTIAL_UPDATE,
  STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION,
} from "@traycer/protocol/framework/stream-ws-protocol";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { HostDirectoryEntry } from "../../host-client/host-directory";
import {
  LocalOpenAuth,
  SESSION_GRANT_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED,
  type LocalSessionGrantProvision,
} from "../local-open-auth";
import { NO_TRANSPORT_EVIDENCE } from "../../host-selection/transport-evidence";
import { WsStreamClient } from "../ws-stream-client";
import { TEST_CLIENT_IDENTITY } from "../../test-fixtures/client-identity";
import type { OpenFrameBearerSource } from "../../auth/bearer-source";
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

function makeBearer(): OpenFrameBearerSource {
  const user = createAuthenticatedUserFixture(undefined);
  return createRequestContext({
    identity: identityFromAuthenticatedUser(user),
    bearerToken: "user-bearer",
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  }).credentials;
}

function makeClient(
  factory: LocalGrantStreamSocketFactory["factory"],
  localOpenAuth: LocalOpenAuth,
  bearer: OpenFrameBearerSource,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    hostId: host.hostId,
    endpoint: () => host,
    bearer: () => bearer,
    localOpenAuth,
    auth: null,
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

function challenge(): object {
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

function openAck(
  socket: LocalGrantStreamSocket,
  additional: object | undefined,
): object {
  const open = openFrame(socket);
  return {
    kind: "openAck",
    manifest: open.manifest,
    capabilities: [
      STREAM_CAPABILITY_CREDENTIAL_UPDATE,
      STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION,
    ],
    ...(additional ?? {}),
  };
}

describe("WsStreamClient local team session grant", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetNegotiatedStreamVersions();
    resetStreamMethodSupportMemo();
  });

  it("reconnects on a team grant and suppresses user credential updates for that session", async () => {
    const { factory, nextSocket } = createLocalGrantStreamSocketFactory();
    const mintSessionGrant = vi.fn(async () => ({
      kind: "ok" as const,
      token: "one-use-session-grant",
    }));
    const client = makeClient(
      factory,
      new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
      makeBearer(),
    );
    const firstSocketPromise = nextSocket();
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));

    const firstSocket = await firstSocketPromise;
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    const firstOpen = await firstOpenWait;
    expect(firstOpen.token).toBe("user-bearer");
    const secondSocketPromise = nextSocket();
    firstSocket.fireText(challenge());
    const secondSocket = await secondSocketPromise;
    expect(statuses).not.toContain("reconnecting");
    const secondOpenWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    secondSocket.fireOpen();
    const secondOpen = await secondOpenWait;
    expect(secondOpen.token).toBe("one-use-session-grant");
    const subscribeWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    secondSocket.fireText(openAck(secondSocket, undefined));
    await subscribeWait;

    client.notifyBearerRotated();
    const frames = secondSocket.textSent.map(parseLocalGrantStreamText);
    expect(frames.some((frame) => frame.kind === "credentialUpdate")).toBe(
      false,
    );
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    session.close();
    client.close("test-teardown");
  });

  it("does not re-probe a grant after its OPEN_ACK when a later application fatal arrives", async () => {
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    const mintSessionGrant = vi.fn(async () => ({
      kind: "ok" as const,
      token: "one-use-session-grant",
    }));
    const auth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant,
    });
    const client = makeClient(factory, auth, makeBearer());
    const firstSocketPromise = nextSocket();
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });
    let notifyClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    session.onStatusChange((status) => {
      if (status === "closed") notifyClosed();
    });

    const firstSocket = await firstSocketPromise;
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    await firstOpenWait;
    const grantSocketPromise = nextSocket();
    firstSocket.fireText(challenge());

    const grantSocket = await grantSocketPromise;
    const grantOpenWait = grantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    grantSocket.fireOpen();
    const grantOpen = await grantOpenWait;
    expect(grantOpen.token).toBe("one-use-session-grant");
    const subscribeWait = grantSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    grantSocket.fireText(openAck(grantSocket, undefined));
    await subscribeWait;

    grantSocket.fireText(changedDoorFatal());
    await closed;

    expect(sockets).toHaveLength(2);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    expect(auth.requiresSessionGrant(host.hostId)).toBe(true);
    session.close();
    client.close("test-teardown");
  });

  it("terminates a grant-required session when the account is not a team member", async () => {
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    let notifyMintCalled: () => void = () => undefined;
    const mintCalled = new Promise<void>((resolve) => {
      notifyMintCalled = resolve;
    });
    const mintSessionGrant = vi.fn(async () => {
      notifyMintCalled();
      return {
        kind: "refused" as const,
        fatal: {
          code: TEAM_MEMBERSHIP_REQUIRED,
          reason: "membership required",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      };
    });
    const client = makeClient(
      factory,
      new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
      makeBearer(),
    );
    const socketPromise = nextSocket();
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });
    const statuses: string[] = [];
    let notifyClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    session.onStatusChange((status) => {
      statuses.push(status);
      if (status === "closed") notifyClosed();
    });

    const socket = await socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    await openWait;
    socket.fireText(challenge());
    await mintCalled;
    await closed;

    expect(sockets).toHaveLength(1);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    expect(statuses).toContain("closed");
    session.close();
    client.close("test-teardown");
  });

  it("retries a transient membership lookup on the stream backoff path", async () => {
    vi.useFakeTimers();
    const { factory, nextSocket } = createLocalGrantStreamSocketFactory();
    const mintSessionGrant = vi
      .fn()
      .mockResolvedValueOnce({ kind: "unavailable" as const })
      .mockResolvedValueOnce({
        kind: "ok" as const,
        token: "grant-after-retry",
      });
    const client = makeClient(
      factory,
      new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
      makeBearer(),
    );
    const firstSocketPromise = nextSocket();
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });

    const firstSocket = await firstSocketPromise;
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    await firstOpenWait;
    const secondSocketPromise = nextSocket();
    firstSocket.fireText(challenge());
    await vi.advanceTimersByTimeAsync(100);
    const secondSocket = await secondSocketPromise;
    expect(mintSessionGrant).toHaveBeenCalledTimes(2);
    const secondOpenWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    secondSocket.fireOpen();
    const secondOpen = await secondOpenWait;
    expect(secondOpen.token).toBe("grant-after-retry");
    const subscribeWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    secondSocket.fireText(openAck(secondSocket, undefined));
    await subscribeWait;
    session.close();
    client.close("test-teardown");
  });

  it("discards a late grant when the stream session closes during minting", async () => {
    vi.useFakeTimers();
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    let resolveMint: (result: LocalSessionGrantProvision) => void = () => {
      throw new Error("grant provider was not initialized");
    };
    let notifyMintCalled: () => void = () => undefined;
    const mintCalled = new Promise<void>((resolve) => {
      notifyMintCalled = resolve;
    });
    const mintSessionGrant = vi.fn(() => {
      notifyMintCalled();
      return new Promise<LocalSessionGrantProvision>((resolve) => {
        resolveMint = resolve;
      });
    });
    const client = makeClient(
      factory,
      new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
      makeBearer(),
    );
    const socketPromise = nextSocket();
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });

    const socket = await socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    await openWait;
    socket.fireText(challenge());
    await mintCalled;
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    session.close();
    resolveMint({ kind: "ok", token: "late-grant" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    client.close("test-teardown");
  });
});
