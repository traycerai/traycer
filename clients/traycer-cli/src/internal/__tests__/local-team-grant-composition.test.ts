import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  ClientOpenFrame,
  HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { STREAM_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/framework/stream-ws-protocol";
import type { OpenFrameBearerSource } from "../../../../shared/auth/bearer-source";
import { LocalOpenAuth } from "../../../../shared/host-transport/local-open-auth";
import {
  createLocalGrantRpcSocketFactory,
  createLocalGrantStreamSocketFactory,
  type LocalGrantRpcSocketFactory,
  type LocalGrantStreamSocketFactory,
  type LocalGrantRpcSocket,
  type LocalGrantStreamSocket,
  type LocalTeamGrantMint,
} from "../../../../shared/host-transport/__tests__/local-team-grant-test-support";
import { resetNegotiatedManifests } from "../../../../shared/host-transport/negotiated-manifest-registry";
import { resetNegotiatedStreamVersions } from "../../../../shared/host-transport/negotiated-stream-version-registry";
import { resetStreamMethodSupportMemo } from "../../../../shared/host-transport/stream-method-support-registry";
import { UNARY_CAPABILITY_PERSISTENT_SESSION } from "@traycer/protocol/framework/index";
import {
  BOT_ID_A,
  botRecord,
  botSnapshotFrame,
} from "../../commands/__tests__/bot-test-support";
import { openLocalStreamClient, readBotSnapshot } from "../bot-host";
import {
  callHostRpcAtResolvedEndpoint,
  type HostRpcDispatch,
} from "../host-rpc";

const mocks = vi.hoisted(() => ({
  createCliLocalOpenAuth: vi.fn(),
  resolveHostAuth: vi.fn(),
  resolveEndpoint: vi.fn(),
  createStore: vi.fn(),
  createRevalidator: vi.fn(),
  rpcFactory: { create: vi.fn() },
  streamFactory: { create: vi.fn() },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../local-open-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-open-auth")>();
  return {
    ...actual,
    createCliLocalOpenAuth: mocks.createCliLocalOpenAuth,
  };
});

vi.mock("../host-auth", () => ({
  resolveHostAuth: mocks.resolveHostAuth,
}));

vi.mock("../host-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-rpc")>();
  return { ...actual, resolveEndpoint: mocks.resolveEndpoint };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: mocks.createStore,
    createStoreBackedRevalidator: mocks.createRevalidator,
  };
});

vi.mock("../../logger", () => ({
  createCliLogger: () => mocks.logger,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

vi.mock(
  "../../../../shared/host-transport/whatwg-ws-factory",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/host-transport/whatwg-ws-factory")
      >();
    return {
      ...actual,
      createWhatwgWebSocketFactory: () => mocks.rpcFactory,
    };
  },
);

vi.mock(
  "../../../../shared/host-transport/whatwg-stream-ws-factory",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/host-transport/whatwg-stream-ws-factory")
      >();
    return {
      ...actual,
      createWhatwgStreamWebSocketFactory: () => mocks.streamFactory,
    };
  },
);

const AUTH = {
  token: "cli-user-bearer",
  authnBaseUrl: "https://authn.cli-local.invalid",
  userId: "cli-team-member",
};
const ENDPOINT = {
  hostId: "cli-local-team-host",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
};

type LocalTeamGrantMintMock = Mock<LocalTeamGrantMint>;

let localOpenAuth: LocalOpenAuth;
let mintSessionGrant: LocalTeamGrantMintMock;
let mintedBearers: OpenFrameBearerSource[];

function makeLocalOpenAuth(): {
  readonly auth: LocalOpenAuth;
  readonly mintSessionGrant: LocalTeamGrantMintMock;
  readonly mintedBearers: OpenFrameBearerSource[];
} {
  const mintedBearers: OpenFrameBearerSource[] = [];
  const grant = vi.fn<LocalTeamGrantMint>((_hostId, bearer, _signal) => {
    mintedBearers.push(bearer);
    return Promise.resolve({
      kind: "ok" as const,
      token: "cli-one-use-session-grant",
    });
  });
  return {
    auth: new LocalOpenAuth({ provisionMember: null, mintSessionGrant: grant }),
    mintSessionGrant: grant,
    mintedBearers,
  };
}

function openFrame(socket: LocalGrantRpcSocket): ClientOpenFrame {
  const frame = socket.sent.find((item) => item.kind === "open");
  if (frame?.kind !== "open") throw new Error("Expected an OPEN frame");
  return frame;
}

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

function rpcOpenAck(socket: LocalGrantRpcSocket): HostFrame {
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

beforeEach(() => {
  const created = makeLocalOpenAuth();
  localOpenAuth = created.auth;
  mintSessionGrant = created.mintSessionGrant;
  mintedBearers = created.mintedBearers;
  mocks.createCliLocalOpenAuth.mockReturnValue(localOpenAuth);
  mocks.resolveHostAuth.mockResolvedValue(AUTH);
  mocks.resolveEndpoint.mockResolvedValue(ENDPOINT);
  mocks.createStore.mockReturnValue({ dispose: vi.fn() });
  mocks.createRevalidator.mockReturnValue({
    revalidateExpectedBearer: async () => "network-error",
    revalidateCurrentContext: async () => "network-error",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  resetNegotiatedManifests();
  resetNegotiatedStreamVersions();
  resetStreamMethodSupportMemo();
});

describe("CLI local team grant composition", () => {
  it("routes host-rpc through the grant-aware unary transport", async () => {
    const { factory, sockets, nextSocket } = createLocalGrantRpcSocketFactory();
    mocks.rpcFactory.create.mockImplementation(
      (...args: Parameters<LocalGrantRpcSocketFactory["factory"]["create"]>) =>
        factory.create(...args),
    );
    const dispatch: HostRpcDispatch = {
      responseTimeoutMs: null,
      requiredHostMethodVersion: null,
      signal: null,
      failFast: false,
      reauthenticate: "always",
      idempotencyKey: null,
    };
    const pending = callHostRpcAtResolvedEndpoint(
      "environment.list",
      {},
      ENDPOINT,
      AUTH,
      dispatch,
    );

    const firstSocket = await nextSocket();
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    const firstOpen = await firstOpenWait;
    expect(firstOpen.kind === "open" ? firstOpen.token : null).toBe(AUTH.token);

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
      "cli-one-use-session-grant",
    );

    const requestWait = grantSocket.waitForFrame(
      (frame) => frame.kind === "request",
      undefined,
    );
    grantSocket.fireMessage(rpcOpenAck(grantSocket));
    const request = await requestWait;
    expect(request).not.toHaveProperty("token");
    if (request.kind !== "request") throw new Error("Expected a request frame");
    grantSocket.fireMessage({
      kind: "response",
      requestId: request.requestId,
      method: "environment.list",
      schemaVersion: request.schemaVersion,
      result: { environments: [] },
      error: null,
    });

    await expect(pending).resolves.toEqual({ environments: [] });
    expect(mocks.createCliLocalOpenAuth).toHaveBeenCalledExactlyOnceWith(
      AUTH.authnBaseUrl,
    );
    expect(mintSessionGrant).toHaveBeenCalledExactlyOnceWith(
      ENDPOINT.hostId,
      expect.objectContaining({ identity: { userId: AUTH.userId } }),
      expect.any(AbortSignal),
    );
    expect(mintedBearers[0]?.getBearerToken()).toBe(AUTH.token);
    expect(sockets).toHaveLength(2);
  });

  it("keeps the one-shot bot read alive through challenge negotiation", async () => {
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    mocks.streamFactory.create.mockImplementation(
      (
        ...args: Parameters<LocalGrantStreamSocketFactory["factory"]["create"]>
      ) => factory.create(...args),
    );
    const { client } = await openLocalStreamClient();
    const firstSocketPromise = nextSocket();
    const pending = readBotSnapshot(client, BOT_ID_A);

    const firstSocket = await firstSocketPromise;
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    const firstOpen = await firstOpenWait;
    expect(firstOpen.token).toBe(AUTH.token);

    const grantSocketPromise = nextSocket();
    firstSocket.fireText(grantRequired());
    const grantSocket = await grantSocketPromise;
    const grantOpenWait = grantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    grantSocket.fireOpen();
    const grantOpen = await grantOpenWait;
    expect(grantOpen.token).toBe("cli-one-use-session-grant");
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
    grantSocket.fireText(
      botSnapshotFrame(botRecord({ botId: BOT_ID_A }), [], 0),
    );

    await expect(pending).resolves.toMatchObject({
      bot: { botId: BOT_ID_A },
      tasks: [],
      openRequestCount: 0,
    });
    expect(sockets).toHaveLength(2);
    expect(mocks.createCliLocalOpenAuth).toHaveBeenCalledExactlyOnceWith(
      AUTH.authnBaseUrl,
    );
    expect(mintSessionGrant).toHaveBeenCalledExactlyOnceWith(
      ENDPOINT.hostId,
      expect.objectContaining({ identity: { userId: AUTH.userId } }),
      expect.any(AbortSignal),
    );
    expect(mintedBearers[0]?.getBearerToken()).toBe(AUTH.token);
    client.close("test-teardown");
  });
});
