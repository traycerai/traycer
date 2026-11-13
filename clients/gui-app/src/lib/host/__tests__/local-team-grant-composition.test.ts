import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
} from "@traycer/protocol/framework/index";
import { z } from "zod";
import type {
  ClientFrame,
  ClientOpenFrame,
  HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { LocalOpenAuth } from "@traycer-clients/shared/host-transport/local-open-auth";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { resetNegotiatedStreamVersions } from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";
import { resetStreamMethodSupportMemo } from "@traycer-clients/shared/host-transport/stream-method-support-registry";
import { STREAM_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  createLocalGrantRpcSocketFactory,
  createLocalGrantStreamSocketFactory,
  parseLocalGrantStreamText,
  type LocalGrantRpcSocket,
  type LocalGrantRpcSocketFactory,
  type LocalGrantStreamSocket,
  type LocalGrantStreamSocketFactory,
  type LocalTeamGrantMint,
} from "@traycer-clients/shared/host-transport/__tests__/local-team-grant-test-support";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import {
  buildRawHostMessengerForTarget,
  buildRuntimeHostMessenger,
} from "../host-messenger";

const mocks = vi.hoisted(() => ({
  appLocalOpenAuthFor: vi.fn(),
  rpcFactory: { create: vi.fn() },
  streamFactory: { create: vi.fn() },
}));

vi.mock("@/lib/host/app-local-open-auth", () => ({
  appLocalOpenAuthFor: mocks.appLocalOpenAuthFor,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/whatwg-ws-factory",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/whatwg-ws-factory")
      >();
    return {
      ...actual,
      createWhatwgWebSocketFactory: () => mocks.rpcFactory,
    };
  },
);

vi.mock(
  "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/whatwg-stream-ws-factory")
      >();
    return {
      ...actual,
      createWhatwgStreamWebSocketFactory: () => mocks.streamFactory,
    };
  },
);

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
      versions: { 0: { contract: echo, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

const localTarget: HostDirectoryEntry = {
  hostId: "gui-local-team-host",
  label: "Local team computer",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "test",
  transportDialability: "dialable",
};

type LocalTeamGrantMintMock = Mock<LocalTeamGrantMint>;

function createAuth(): {
  readonly auth: LocalOpenAuth;
  readonly mintSessionGrant: LocalTeamGrantMintMock;
} {
  const mintSessionGrant = vi.fn<LocalTeamGrantMint>(() =>
    Promise.resolve({
      kind: "ok" as const,
      token: "gui-one-use-session-grant",
    }),
  );
  return {
    auth: new LocalOpenAuth({ provisionMember: null, mintSessionGrant }),
    mintSessionGrant,
  };
}

let currentAuth: LocalOpenAuth;
let currentMintSessionGrant: LocalTeamGrantMintMock;

function grantRequired(): HostFrame {
  return {
    kind: "fatalError",
    details: {
      code: "SESSION_GRANT_REQUIRED",
      reason: "session grant required",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function openFrame(socket: LocalGrantRpcSocket): ClientOpenFrame {
  const frame = socket.sent.find((item) => item.kind === "open");
  if (frame?.kind !== "open") throw new Error("Expected an OPEN frame");
  return frame;
}

function openAck(socket: LocalGrantRpcSocket): HostFrame {
  const open = openFrame(socket);
  return {
    kind: "openAck",
    manifest: open.manifest,
    ...(open.optionalManifest === undefined
      ? {}
      : { optionalManifest: open.optionalManifest }),
    capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
  };
}

function hostResponse(request: ClientFrame): HostFrame {
  if (request.kind !== "request")
    throw new Error("Expected a unary request frame");
  return {
    kind: "response",
    requestId: request.requestId,
    method: "host.echo",
    schemaVersion: { major: 1, minor: 0 },
    result: { echoed: "gui-ok" },
    error: null,
  };
}

const bearer = new MutableBearerLease("gui-user-bearer", "gui-team-member");
const requestOptions = {
  replayMustBeKeyed: false,
  requiredHostMethodVersion: null,
  idempotencyKey: null,
  authority: {
    endpoint: {
      hostId: localTarget.hostId,
      websocketUrl: localTarget.websocketUrl ?? "",
    },
    bearer,
    abortSignal: new AbortController().signal,
  },
} as const;

async function driveUnaryGrantFlow(
  firstSocketPromise: Promise<LocalGrantRpcSocket>,
  nextSocket: () => Promise<LocalGrantRpcSocket>,
  pending: Promise<{ readonly echoed: string }>,
): Promise<void> {
  const firstSocket = await firstSocketPromise;
  const firstOpenWait = firstSocket.waitForFrame(
    (frame) => frame.kind === "open",
    undefined,
  );
  firstSocket.fireOpen();
  const firstOpen = await firstOpenWait;
  expect(firstOpen.kind === "open" ? firstOpen.token : null).toBe(
    "gui-user-bearer",
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
    "gui-one-use-session-grant",
  );
  const requestWait = grantSocket.waitForFrame(
    (frame) => frame.kind === "request",
    undefined,
  );
  grantSocket.fireMessage(openAck(grantSocket));
  const request = await requestWait;
  expect(request).not.toHaveProperty("token");
  grantSocket.fireMessage(hostResponse(request));
  await expect(pending).resolves.toEqual({ echoed: "gui-ok" });
}

async function driveStreamGrantFlow(
  firstSocketPromise: Promise<LocalGrantStreamSocket>,
  nextSocket: () => Promise<LocalGrantStreamSocket>,
): Promise<LocalGrantStreamSocket> {
  const firstSocket = await firstSocketPromise;
  const firstOpenWait = firstSocket.waitForFrame(
    (frame) => frame.kind === "open",
    undefined,
  );
  firstSocket.fireOpen();
  const firstOpen = await firstOpenWait;
  expect(firstOpen.token).toBe("gui-user-bearer");

  const grantSocketPromise = nextSocket();
  firstSocket.fireText(grantRequired());
  const grantSocket = await grantSocketPromise;
  const grantOpenWait = grantSocket.waitForFrame(
    (frame) => frame.kind === "open",
    undefined,
  );
  grantSocket.fireOpen();
  const grantOpen = await grantOpenWait;
  expect(grantOpen.token).toBe("gui-one-use-session-grant");
  const subscribeWait = grantSocket.waitForFrame(
    (frame) => frame.kind === "subscribe",
    undefined,
  );
  grantSocket.fireText({
    kind: "openAck",
    manifest: grantOpen.manifest,
    capabilities: [STREAM_CAPABILITY_CREDENTIAL_UPDATE],
  });
  await subscribeWait;
  return grantSocket;
}

beforeEach(() => {
  const created = createAuth();
  currentAuth = created.auth;
  currentMintSessionGrant = created.mintSessionGrant;
  mocks.appLocalOpenAuthFor.mockReturnValue(currentAuth);
});

afterEach(() => {
  vi.clearAllMocks();
  resetNegotiatedManifests();
  resetNegotiatedStreamVersions();
  resetStreamMethodSupportMemo();
});

describe("GUI local team grant composition", () => {
  it("routes a raw local unary request through the challenged OPEN grant", async () => {
    const { factory, sockets, nextSocket } = createLocalGrantRpcSocketFactory();
    mocks.rpcFactory.create.mockImplementation(
      (...args: Parameters<LocalGrantRpcSocketFactory["factory"]["create"]>) =>
        factory.create(...args),
    );
    const built = buildRawHostMessengerForTarget({
      target: localTarget,
      registry,
      bearer: () => bearer,
      cloudAuthorized: () => true,
      auth: null,
      authnBaseUrl: "https://authn.gui-local.invalid",
      requestId: () => "gui-raw-request",
      userId: bearer.identity.userId,
    });
    if (built === null) throw new Error("Expected a local messenger");

    const socketPromise = nextSocket();
    const pending = built.messenger.request(
      "host.echo",
      { message: "raw" },
      requestOptions,
    );
    await driveUnaryGrantFlow(socketPromise, nextSocket, pending);

    expect(sockets).toHaveLength(2);
    expect(mocks.appLocalOpenAuthFor).toHaveBeenCalledExactlyOnceWith(
      "https://authn.gui-local.invalid",
    );
    expect(currentMintSessionGrant).toHaveBeenCalledExactlyOnceWith(
      localTarget.hostId,
      bearer,
      expect.any(AbortSignal),
    );
    await expect(socketPromise).resolves.toBe(sockets[0]);
  });

  it("routes runtime request and requestWithResponseTimeout through local grant negotiation", async () => {
    const { factory, sockets, nextSocket } = createLocalGrantRpcSocketFactory();
    mocks.rpcFactory.create.mockImplementation(
      (...args: Parameters<LocalGrantRpcSocketFactory["factory"]["create"]>) =>
        factory.create(...args),
    );
    let requestSequence = 0;
    const binding = buildRuntimeHostMessenger({
      registry,
      resolveTarget: (hostId) =>
        hostId === localTarget.hostId ? localTarget : null,
      auth: null,
      authnBaseUrl: "https://authn.gui-runtime.invalid",
      requestId: () => `gui-runtime-${++requestSequence}`,
      onRemoteAvailabilityRecovered: () => undefined,
      onRemoteSessionTerminal: () => undefined,
    });

    const rawSocketPromise = nextSocket();
    const ordinary = binding.messenger.request(
      "host.echo",
      { message: "runtime" },
      requestOptions,
    );
    await driveUnaryGrantFlow(rawSocketPromise, nextSocket, ordinary);
    await expect(rawSocketPromise).resolves.toBe(sockets[0]);
    binding.dispose();

    const timeoutAuth = createAuth();
    mocks.appLocalOpenAuthFor.mockReturnValueOnce(timeoutAuth.auth);
    const timeoutBinding = buildRuntimeHostMessenger({
      registry,
      resolveTarget: (hostId) =>
        hostId === localTarget.hostId ? localTarget : null,
      auth: null,
      authnBaseUrl: "https://authn.gui-runtime.invalid",
      requestId: () => `gui-runtime-${++requestSequence}`,
      onRemoteAvailabilityRecovered: () => undefined,
      onRemoteSessionTerminal: () => undefined,
    });
    const timeoutSocketPromise = nextSocket();
    const timed = timeoutBinding.messenger.requestWithResponseTimeout(
      "host.echo",
      { message: "runtime-timeout" },
      2_000,
      requestOptions,
    );
    await driveUnaryGrantFlow(timeoutSocketPromise, nextSocket, timed);
    await expect(timeoutSocketPromise).resolves.toBe(sockets[2]);

    expect(sockets).toHaveLength(4);
    expect(mocks.appLocalOpenAuthFor).toHaveBeenCalledTimes(2);
    expect(mocks.appLocalOpenAuthFor).toHaveBeenNthCalledWith(
      1,
      "https://authn.gui-runtime.invalid",
    );
    expect(mocks.appLocalOpenAuthFor).toHaveBeenNthCalledWith(
      2,
      "https://authn.gui-runtime.invalid",
    );
    expect(currentMintSessionGrant).toHaveBeenCalledTimes(1);
    expect(timeoutAuth.mintSessionGrant).toHaveBeenCalledTimes(1);
    timeoutBinding.dispose();
  });

  it("routes local GUI stream subscriptions through grant OPEN and filters credential rotation", async () => {
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    mocks.streamFactory.create.mockImplementation(
      (
        ...args: Parameters<LocalGrantStreamSocketFactory["factory"]["create"]>
      ) => factory.create(...args),
    );
    const client = buildHostStreamClient({
      target: localTarget,
      endpoint: () => ({
        hostId: localTarget.hostId,
        websocketUrl: localTarget.websocketUrl ?? "",
      }),
      bearer: () => bearer,
      cloudAuthorized: () => true,
      authnBaseUrl: "https://authn.gui-stream.invalid",
      auth: null,
      userId: bearer.identity.userId,
      proactiveWakeEligible: false,
      autoStart: false,
    });
    if (client === null) throw new Error("Expected a local stream client");
    const socketPromise = nextSocket();
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });
    const grantSocket = await driveStreamGrantFlow(socketPromise, nextSocket);

    client.notifyBearerRotated();
    expect(
      grantSocket.textSent
        .map(parseLocalGrantStreamText)
        .some((frame) => frame.kind === "credentialUpdate"),
    ).toBe(false);
    expect(mocks.appLocalOpenAuthFor).toHaveBeenCalledExactlyOnceWith(
      "https://authn.gui-stream.invalid",
    );
    expect(currentMintSessionGrant).toHaveBeenCalledExactlyOnceWith(
      localTarget.hostId,
      bearer,
      expect.any(AbortSignal),
    );
    expect(sockets).toHaveLength(2);
    await expect(socketPromise).resolves.toBe(sockets[0]);
    session.close();
    client.close("test-teardown");
  });
});
