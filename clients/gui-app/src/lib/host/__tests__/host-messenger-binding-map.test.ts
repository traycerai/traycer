/**
 * `RuntimeHostMessenger` keeps one remote binding per target: the server
 * pool's, and ONE host's. A request for a different remote host replaces the
 * host's, a local request releases it, a transport-key change rebuilds only its
 * own entry, and none of these touches the pool's session.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildRuntimeHostMessenger } from "../host-messenger";

const mocks = vi.hoisted(() => ({
  createRemoteHostTransport: vi.fn(),
  createPoolHostTransport: vi.fn(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      createRemoteHostTransport: mocks.createRemoteHostTransport,
      createPoolHostTransport: mocks.createPoolHostTransport,
    };
  },
);

interface CountingSession extends IRemoteSession<
  HostRpcRegistry,
  HostStreamRpcRegistry
> {
  readonly label: string;
  readonly closeCalls: number;
}

function countingSession(label: string): CountingSession {
  let closeCalls = 0;
  return {
    label,
    get closeCalls() {
      return closeCalls;
    },
    start: vi.fn(),
    isClosed: () => false,
    isReady: () => true,
    isSilentFor: () => false,
    sendUnary: vi.fn(() => Promise.resolve({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeAtVersion: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    notifyCloudVerdictChanged: vi.fn(),
    wake: vi.fn(),
    forceReconnect: vi.fn(),
    onClosed: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
    subscribeReadinessLost: () => () => undefined,
    getMethodSupport: () => "unknown",
    getMethodSchemaVersion: () => null,
    subscribeMethodSupport: () => () => undefined,
    terminalFatal: () => null,
    close: () => {
      closeCalls += 1;
    },
  };
}

function remoteEntry(
  hostId: string,
  publicKey: string,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: "wss://relay.invalid/attach",
    version: "1.0.0",
    transportDialability: "dialable",
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    publicKey,
    relayFuseGrace: false,
    sandbox: {
      state: null,
      frozen: false,
      profile: null,
      ownerTeamName: "Team",
      ownerTeamId: "team-1",
    },
  };
}

const localEntry: HostDirectoryEntry = {
  hostId: "local-host",
  label: "This machine",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:1/",
  version: "1.0.0",
  transportDialability: "dialable",
};

const bearer = {
  getBearerToken: () => "bearer-token",
  identity: { userId: "user-1" },
};

function harness() {
  const sessions: CountingSession[] = [];
  const build = (label: string) => {
    const session = countingSession(label);
    sessions.push(session);
    return {
      session,
      messenger: {
        request: () => Promise.resolve({}),
        requestWithResponseTimeout: () => Promise.resolve({}),
      },
      streamClient: {},
    };
  };
  mocks.createRemoteHostTransport.mockImplementation(
    (params: { readonly hostId: string; readonly hostPublicKey: string }) =>
      build(`${params.hostId}/${params.hostPublicKey}`),
  );
  mocks.createPoolHostTransport.mockImplementation(() => build("pool"));
  let sandbox = remoteEntry("sandbox-a", "key-1");
  const otherHost = remoteEntry("host-b", "key-b");
  const entries = (): readonly HostDirectoryEntry[] => [
    localEntry,
    sandbox,
    otherHost,
    poolEntry,
  ];
  const binding = buildRuntimeHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    resolveTarget: (hostId) =>
      entries().find((entry) => entry.hostId === hostId) ?? null,
    auth: null,
    authnBaseUrl: "https://authn.invalid",
    requestId: () => "req-1",
    onRemoteAvailabilityRecovered: () => undefined,
    onRemoteSessionTerminal: () => undefined,
  });
  const request = async (entry: HostDirectoryEntry): Promise<void> => {
    await binding.messenger
      .request(
        "host.status",
        {},
        {
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          idempotencyKey: null,
          authority: {
            endpoint: {
              hostId: entry.hostId,
              websocketUrl: entry.websocketUrl ?? "",
            },
            bearer,
            abortSignal: new AbortController().signal,
          },
        },
      )
      .catch(() => undefined);
  };
  return {
    sessions,
    request,
    rotateSandboxKey: () => {
      sandbox = remoteEntry("sandbox-a", "key-2");
      return sandbox;
    },
    sandbox: () => sandbox,
    otherHost: () => otherHost,
    dispose: () => binding.dispose(),
  };
}

function sessionFor(
  sessions: readonly CountingSession[],
  label: string,
): CountingSession {
  const session = sessions.find((candidate) => candidate.label === label);
  if (session === undefined) {
    throw new Error(`no session built for ${label}`);
  }
  return session;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("RuntimeHostMessenger binding map", () => {
  it("holds a sandbox session and a pool session and alternating requests close neither", async () => {
    const h = harness();
    for (let round = 0; round < 3; round += 1) {
      await h.request(h.sandbox());
      await h.request(poolEntry);
    }
    expect(h.sessions.map((session) => session.label).sort()).toEqual([
      "pool",
      "sandbox-a/key-1",
    ]);
    expect(h.sessions.every((session) => session.closeCalls === 0)).toBe(true);
    h.dispose();
  });

  it("rebuilds only the sandbox's binding on a transport-key change", async () => {
    const h = harness();
    await h.request(h.sandbox());
    await h.request(poolEntry);

    const rotated = h.rotateSandboxKey();
    await h.request(rotated);

    expect(sessionFor(h.sessions, "sandbox-a/key-1").closeCalls).toBe(1);
    expect(sessionFor(h.sessions, "sandbox-a/key-2").closeCalls).toBe(0);
    expect(sessionFor(h.sessions, "pool").closeCalls).toBe(0);
    h.dispose();
  });

  it("replaces the sandbox's binding, not the pool's, when a different remote host is requested", async () => {
    const h = harness();
    await h.request(h.sandbox());
    await h.request(poolEntry);

    await h.request(h.otherHost());

    expect(sessionFor(h.sessions, "sandbox-a/key-1").closeCalls).toBe(1);
    expect(sessionFor(h.sessions, "host-b/key-b").closeCalls).toBe(0);
    expect(sessionFor(h.sessions, "pool").closeCalls).toBe(0);
    h.dispose();
  });

  it("releases the host binding, not the pool's, on a local request", async () => {
    const h = harness();
    await h.request(h.sandbox());
    await h.request(poolEntry);

    await h.request(localEntry);

    expect(sessionFor(h.sessions, "sandbox-a/key-1").closeCalls).toBe(1);
    expect(sessionFor(h.sessions, "pool").closeCalls).toBe(0);
    h.dispose();
  });
});
