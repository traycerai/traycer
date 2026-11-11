import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
} from "@traycer/protocol/framework/index";
import type {
  ClientOpenFrame,
  HostFrame,
  HostOpenAckFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { MutableBearerLease } from "../../auth/bearer-source";
import {
  HostRequestAbortedError,
  RetryableTransportError,
  type HostRequestAuthority,
} from "../host-messenger";
import {
  LocalOpenAuth,
  type LocalSessionGrantProvision,
  SESSION_GRANT_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_UNAVAILABLE,
} from "../local-open-auth";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { NO_TRANSPORT_EVIDENCE } from "../../host-selection/transport-evidence";
import { WsRpcClient } from "../ws-rpc-client";
import { resetNegotiatedManifests } from "../negotiated-manifest-registry";
import { TEST_CLIENT_IDENTITY } from "../../test-fixtures/client-identity";
import {
  createLocalGrantRpcSocketFactory,
  type LocalGrantRpcSocket,
  type LocalGrantRpcSocketFactory,
} from "./local-team-grant-test-support";

const echo = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const registry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echo, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

function authorityForBearer(bearerToken: string): HostRequestAuthority {
  return authorityForBearerLease(
    new MutableBearerLease(bearerToken, "local-team-grant-test-user"),
  );
}

function authorityForBearerLease(
  bearer: MutableBearerLease,
): HostRequestAuthority {
  return {
    endpoint: {
      hostId: mockLocalHostEntry.hostId,
      websocketUrl: mockLocalHostEntry.websocketUrl,
    },
    bearer,
    abortSignal: new AbortController().signal,
  };
}

function makeClient(
  factory: LocalGrantRpcSocketFactory["factory"],
  localOpenAuth: LocalOpenAuth,
): WsRpcClient<typeof registry> {
  return new WsRpcClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry,
    requestId: () => "req-local-team-grant",
    webSocketFactory: factory,
    dialTimeoutMs: 1000,
    frameTimeoutMs: 1000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
    localOpenAuth,
  });
}

function openFrame(socket: LocalGrantRpcSocket): ClientOpenFrame {
  const frame = socket.sent.find((item) => item.kind === "open");
  if (frame?.kind !== "open") throw new Error("Expected an open frame");
  return frame;
}

function openAck(
  frame: ClientOpenFrame,
  capabilities: readonly string[] | undefined,
): HostOpenAckFrame {
  return {
    kind: "openAck",
    manifest: frame.manifest,
    ...(frame.optionalManifest === undefined
      ? {}
      : { optionalManifest: frame.optionalManifest }),
    capabilities: capabilities ?? [],
  };
}

function grantRequired(): HostFrame {
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

function changedDoorFatal(): HostFrame {
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

function response(): HostFrame {
  return {
    kind: "response",
    requestId: "req-local-team-grant",
    method: "host.echo",
    schemaVersion: { major: 1, minor: 0 },
    result: { echoed: "ok" },
    error: null,
  };
}

describe("WsRpcClient local team session grant", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetNegotiatedManifests();
  });

  it("retries a challenged local OPEN with a grant and never puts that one-use grant on requests", async () => {
    const { factory, sockets, nextSocket } = createLocalGrantRpcSocketFactory();
    const mintSessionGrant = vi.fn(async () => ({
      kind: "ok" as const,
      token: "one-use-session-grant",
    }));
    const auth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant,
    });
    const client = makeClient(factory, auth);
    const bearer = new MutableBearerLease(
      "user-bearer",
      "local-team-grant-test-user",
    );
    const authority = authorityForBearerLease(bearer);

    const options = {
      replayMustBeKeyed: false,
      requiredHostMethodVersion: null,
      idempotencyKey: null,
      authority,
    } as const;
    const firstSocketPromise = nextSocket();
    const pending = client.requestWithResponseTimeout(
      "host.echo",
      { message: "first" },
      1000,
      options,
    );
    const firstSocket = await firstSocketPromise;
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    const firstOpen = await firstOpenWait;
    expect(firstOpen.kind === "open" ? firstOpen.token : null).toBe(
      "user-bearer",
    );
    const secondSocketPromise = nextSocket();
    firstSocket.fireMessage(grantRequired());

    const secondSocket = await secondSocketPromise;
    const secondOpenWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    bearer.rotate("rotated-user-bearer");
    secondSocket.fireOpen();
    const secondOpen = await secondOpenWait;
    expect(secondOpen.kind === "open" ? secondOpen.token : null).toBe(
      "one-use-session-grant",
    );
    const firstRequestWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "request",
      undefined,
    );
    secondSocket.fireMessage(
      openAck(
        secondOpen.kind === "open" ? secondOpen : openFrame(secondSocket),
        [UNARY_CAPABILITY_PERSISTENT_SESSION],
      ),
    );
    const firstRequest = await firstRequestWait;
    expect(firstRequest).not.toHaveProperty("token");
    secondSocket.fireMessage(response());
    await expect(pending).resolves.toEqual({ echoed: "ok" });

    const nextRequestWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "request",
      secondSocket.sent.length,
    );
    const next = client.request(
      "host.echo",
      { message: "second" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority,
      },
    );
    const nextRequest = await nextRequestWait;
    expect(sockets).toHaveLength(2);
    expect(nextRequest).not.toHaveProperty("token");
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    secondSocket.fireMessage(response());
    await expect(next).resolves.toEqual({ echoed: "ok" });
    client.releaseIdleLocalSessions();
  });

  it("keeps an unchallenged user session on the user bearer", async () => {
    const { factory, nextSocket } = createLocalGrantRpcSocketFactory();
    const mintSessionGrant = vi.fn(async () => ({
      kind: "ok" as const,
      token: "unused-grant",
    }));
    const client = makeClient(
      factory,
      new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
    );
    const socketPromise = nextSocket();
    const pending = client.request(
      "host.echo",
      { message: "user" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authorityForBearer("user-bearer"),
      },
    );
    const socket = await socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    const sentOpen = await openWait;
    expect(sentOpen.kind === "open" ? sentOpen.token : null).toBe(
      "user-bearer",
    );
    const requestWait = socket.waitForFrame(
      (frame) => frame.kind === "request",
      undefined,
    );
    socket.fireMessage(
      openAck(
        sentOpen.kind === "open" ? sentOpen : openFrame(socket),
        undefined,
      ),
    );
    await requestWait;
    socket.fireMessage(response());
    await expect(pending).resolves.toEqual({ echoed: "ok" });
    expect(mintSessionGrant).not.toHaveBeenCalled();
  });

  it("refuses a grant OPEN when the authority bearer is cleared while dialing", async () => {
    const { factory, nextSocket } = createLocalGrantRpcSocketFactory();
    const mintSessionGrant = vi.fn(async () => ({
      kind: "ok" as const,
      token: "one-use-session-grant",
    }));
    const client = makeClient(
      factory,
      new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
    );
    const bearer = new MutableBearerLease(
      "user-bearer",
      "local-team-grant-test-user",
    );
    const authority = authorityForBearerLease(bearer);
    const firstSocketPromise = nextSocket();
    const pending = client.request(
      "host.echo",
      { message: "cleared-bearer" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority,
      },
    );
    const firstSocket = await firstSocketPromise;
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    const firstOpen = await firstOpenWait;
    expect(firstOpen.kind === "open" ? firstOpen.token : null).toBe(
      "user-bearer",
    );

    const grantSocketPromise = nextSocket();
    firstSocket.fireMessage(grantRequired());
    const grantSocket = await grantSocketPromise;
    bearer.rotate("");
    grantSocket.fireOpen();

    await expect(pending).rejects.toMatchObject({
      code: "RPC_ERROR",
      message: expect.stringContaining("Cannot open host WebSocket"),
    });
    expect(grantSocket.sent.some((frame) => frame.kind === "open")).toBe(false);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
  });

  it("reprobes once with the user bearer when the challenged grant OPEN belongs to a changed door", async () => {
    const { factory, sockets, nextSocket } = createLocalGrantRpcSocketFactory();
    const mintSessionGrant = vi.fn(async () => ({
      kind: "ok" as const,
      token: "one-use-session-grant",
    }));
    const auth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant,
    });
    const client = makeClient(factory, auth);
    const authority = authorityForBearer("user-bearer");
    const options = {
      replayMustBeKeyed: false,
      requiredHostMethodVersion: null,
      idempotencyKey: null,
      authority,
    } as const;

    const firstSocketPromise = nextSocket();
    const pending = client.requestWithResponseTimeout(
      "host.echo",
      { message: "changed-door" },
      1000,
      options,
    );
    const firstSocket = await firstSocketPromise;
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    const firstOpen = await firstOpenWait;
    expect(firstOpen.kind === "open" ? firstOpen.token : null).toBe(
      "user-bearer",
    );

    const grantSocketPromise = nextSocket();
    firstSocket.fireMessage(grantRequired());
    const grantSocket = await grantSocketPromise;
    const grantOpenWait = grantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    grantSocket.fireOpen();
    const grantOpen = await grantOpenWait;
    expect(grantOpen.kind === "open" ? grantOpen.token : null).toBe(
      "one-use-session-grant",
    );

    const reprobeSocketPromise = nextSocket();
    grantSocket.fireMessage(changedDoorFatal());
    const reprobeSocket = await reprobeSocketPromise;
    const reprobeOpenWait = reprobeSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    reprobeSocket.fireOpen();
    const reprobeOpen = await reprobeOpenWait;
    expect(reprobeOpen.kind === "open" ? reprobeOpen.token : null).toBe(
      "user-bearer",
    );
    const requestWait = reprobeSocket.waitForFrame(
      (frame) => frame.kind === "request",
      undefined,
    );
    reprobeSocket.fireMessage(
      openAck(
        reprobeOpen.kind === "open" ? reprobeOpen : openFrame(reprobeSocket),
        [UNARY_CAPABILITY_PERSISTENT_SESSION],
      ),
    );
    const request = await requestWait;
    expect(request).toHaveProperty("token", "user-bearer");
    reprobeSocket.fireMessage(response());

    await expect(pending).resolves.toEqual({ echoed: "ok" });
    expect(sockets).toHaveLength(3);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    expect(auth.requiresSessionGrant(authority.endpoint.hostId)).toBe(false);
    client.releaseIdleLocalSessions();
  });

  it("does not open again after the grant provider refuses team membership", async () => {
    const { factory, sockets, nextSocket } = createLocalGrantRpcSocketFactory();
    const mintSessionGrant = vi.fn(async () => ({
      kind: "refused" as const,
      fatal: {
        code: TEAM_MEMBERSHIP_REQUIRED,
        reason: "membership required",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    }));
    const client = makeClient(
      factory,
      new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
    );
    const authority = authorityForBearer("user-bearer");

    const socketPromise = nextSocket();
    const pending = client.request(
      "host.echo",
      { message: "member" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority,
      },
    );
    const socket = await socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    await openWait;
    socket.fireMessage(grantRequired());
    await expect(pending).rejects.toMatchObject({
      fatalDetails: { code: TEAM_MEMBERSHIP_REQUIRED },
    });
    expect(sockets).toHaveLength(1);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);

    await expect(
      client.request(
        "host.echo",
        { message: "member-again" },
        {
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          idempotencyKey: null,
          authority,
        },
      ),
    ).rejects.toMatchObject({
      fatalDetails: { code: TEAM_MEMBERSHIP_REQUIRED },
    });
    expect(sockets).toHaveLength(1);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
  });

  it("surfaces membership lookup outages as retryable without opening on the user bearer again", async () => {
    const { factory, sockets, nextSocket } = createLocalGrantRpcSocketFactory();
    const mintSessionGrant = vi.fn(async () => ({
      kind: "unavailable" as const,
    }));
    const client = makeClient(
      factory,
      new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
    );
    const socketPromise = nextSocket();
    const pending = client.request(
      "host.echo",
      { message: "outage" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authorityForBearer("user-bearer"),
      },
    );
    const socket = await socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    await openWait;
    socket.fireMessage(grantRequired());
    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetryableTransportError &&
        error.fatalDetails?.code === TEAM_MEMBERSHIP_UNAVAILABLE &&
        error.fatalDetails.retryable === true,
    );
    expect(sockets).toHaveLength(1);
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
  });

  it("does not open with a late grant after the unary request is aborted", async () => {
    vi.useFakeTimers();
    const { factory, sockets, nextSocket } = createLocalGrantRpcSocketFactory();
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
    );
    const abortController = new AbortController();
    const authority = {
      ...authorityForBearer("user-bearer"),
      abortSignal: abortController.signal,
    };
    const socketPromise = nextSocket();
    const pending = client.request(
      "host.echo",
      { message: "abort" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority,
      },
    );

    const socket = await socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    await openWait;
    socket.fireMessage(grantRequired());
    await mintCalled;
    expect(mintSessionGrant).toHaveBeenCalledTimes(1);
    abortController.abort();
    await expect(pending).rejects.toBeInstanceOf(HostRequestAbortedError);
    resolveMint({ kind: "ok", token: "late-grant" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
  });
});
