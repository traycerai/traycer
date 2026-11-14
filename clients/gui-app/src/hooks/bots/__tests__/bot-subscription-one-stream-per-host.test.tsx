/**
 * ONE `bot.subscribe` STREAM PER BOT PER HOST, WHICHEVER SURFACE READS IT.
 *
 * The subscription registry keys its entry on `client.instanceId|hostId|botId`,
 * so two readers share a stream only when they hold the same stream-client
 * OBJECT. Home's row and every other bot reader must therefore reach the same
 * object for the same host; a reader that dials its own client opens a second
 * `bot.subscribe` against a host that already serves one.
 *
 * The real `useHostStreamClientFor` + `host-stream-client-cache` (the per-host
 * client every bot reader reads, Home's row included) is mounted beside the
 * real `HostStreamProvider`, whose app-wide client is the control: it is a
 * separate object for the same host, which no bot reader may subscribe
 * through. The only fake is the
 * socket class `buildHostStreamClient` constructs for a local host: each
 * construction yields a client with its own `instanceId`, as in production, and
 * every `subscribe("bot.subscribe")` and its `close` on ANY such client lands
 * in one shared ledger.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ParamsOf,
  StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamParamsProvider } from "@traycer-clients/shared/host-transport/i-stream-client";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { StubSession } from "@/hooks/bots/__tests__/bot-subscribe-stub-stream";

const bindingRef = vi.hoisted(() => ({
  value: null as {
    readonly hostClient: HostClient<HostRpcRegistry>;
  } | null,
  directory: null as {
    findById(hostId: string): HostDirectoryEntry | null;
    onChange(listener: () => void): { dispose: () => void };
  } | null,
  // Stable: `useStreamAuthRevalidator` memoizes on it, and both stream owners
  // rebuild their client when the revalidator changes.
  authService: { revalidateCurrentContext: () => Promise.resolve(null) },
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => bindingRef.value,
  useAuthService: () => bindingRef.authService,
  useHostDirectory: () => bindingRef.directory,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "http://localhost:5005",
    onSystemResumed: () => ({ dispose: () => undefined }),
    onNetworkPathChanged: () => ({ dispose: () => undefined }),
  }),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

// The one fake: `buildHostStreamClient`'s local branch does `new
// WsStreamClient(...)`. Returning a client from the constructor makes every
// build, by the app-wide provider or by the per-host cache, a distinct fake.
vi.mock(
  "@traycer-clients/shared/host-transport/ws-stream-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/ws-stream-client")
      >();
    return {
      ...actual,
      WsStreamClient: class {
        constructor() {
          return buildFakeStreamClient();
        }
      },
    };
  },
);

import { HostStreamProvider } from "@/lib/host/stream-runtime";
import { HomeBotRow } from "@/components/home/bots/home-bot-row";
import {
  __resetBotSubscriptionsForTesting,
  useBotSubscriptionForHost,
} from "@/hooks/bots/use-bot-subscription";
import { resetHostStreamClientCacheForTest } from "@/lib/host/host-stream-client-cache";
import { resetRemoteResumeSweepForTest } from "@/lib/host/stream-wake-reconnect";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

interface BotStreamRecord {
  readonly clientId: string;
  closed: boolean;
}

/** Every stream client built since the test began, and every `bot.subscribe` any of them opened. */
const ledger: {
  clientIds: string[];
  botStreams: BotStreamRecord[];
} = { clientIds: [], botStreams: [] };

function liveBotStreams(): number {
  return ledger.botStreams.filter((stream) => !stream.closed).length;
}

function closedBotStreams(): number {
  return ledger.botStreams.filter((stream) => stream.closed).length;
}

function buildFakeStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
  const instanceId = `fake-stream-client-${ledger.clientIds.length + 1}`;
  ledger.clientIds.push(instanceId);
  let closedReason: string | null = null;
  const closeListeners = new Set<() => void>();
  return {
    instanceId,
    isReady: () => true,
    subscribe<Method extends keyof HostStreamRpcRegistry & string>(
      method: Method,
      _params: ParamsOf<HostStreamRpcRegistry, Method>,
    ): IStreamSession {
      const session = new StubSession();
      if (method === "bot.subscribe") {
        const record: BotStreamRecord = { clientId: instanceId, closed: false };
        ledger.botStreams.push(record);
        session.close.mockImplementation(() => {
          record.closed = true;
        });
      }
      return session;
    },
    subscribeWithParamsProvider<
      Method extends keyof HostStreamRpcRegistry & string,
    >(
      _method: Method,
      _paramsProvider: StreamParamsProvider<HostStreamRpcRegistry, Method>,
    ): IStreamSession {
      return new StubSession();
    },
    getMethodSchemaVersion: (): SchemaVersion | null => null,
    close: (reason: string) => {
      if (closedReason !== null) return;
      closedReason = reason;
      for (const listener of [...closeListeners]) listener();
    },
    isClosed: () => closedReason !== null,
    getClosedReason: () => closedReason,
    onClosed: (listener: () => void) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: (_reason: string, _options: ReconnectAllOptions) => undefined,
    getMethodSupport: (): StreamMethodSupport => "unknown",
    subscribeMethodSupport: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
  };
}

/** The window's directory: rows are looked up by id; nothing here moves. */
class TestHostDirectory {
  constructor(private readonly rows: readonly HostDirectoryEntry[]) {}

  findById(hostId: string): HostDirectoryEntry | null {
    const found = this.rows.find((row) => row.hostId === hostId);
    return found === undefined ? null : { ...found };
  }

  onChange(_listener: () => void): { dispose: () => void } {
    return { dispose: () => undefined };
  }
}

const EFFECTIVE_HOST: HostDirectoryEntry = mockLocalHostEntry;
const OTHER_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-other",
  websocketUrl: "ws://127.0.0.1:4918/rpc",
};

/** The window, pointed at `EFFECTIVE_HOST` the way production's selection pointer is. */
function pointWindowAtEffectiveHost(): void {
  const directory = new TestHostDirectory([EFFECTIVE_HOST, OTHER_HOST]);
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
    findHostById: (hostId) => directory.findById(hostId),
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => directory.findById(hostId),
      onDirectoryChanged: (listener) => directory.onChange(listener),
    },
    leases: null,
  });
  bindingRef.directory = directory;
  bindingRef.value = {
    hostClient: client.createRequesterForHostId(EFFECTIVE_HOST.hostId),
  };
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: EFFECTIVE_HOST.hostId,
    targetHostId: EFFECTIVE_HOST.hostId,
    effectiveHostId: EFFECTIVE_HOST.hostId,
    leases: [],
    selectionRevision: 1,
  });
}

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-team",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: EFFECTIVE_HOST.hostId,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: null,
};

/** A reader of the kind every bot surface other than Home's row is. */
function PerHostReader(props: { readonly hostId: string }): ReactNode {
  useBotSubscriptionForHost({
    hostId: props.hostId,
    botId: BOT_ID,
    enabled: true,
  });
  return null;
}

interface Readers {
  /** Whether Home's row is mounted. */
  readonly home: boolean;
  /** The host a per-host reader reads, or `null` for none mounted. */
  readonly perHostReaderOn: string | null;
}

function tree(queryClient: QueryClient, readers: Readers): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <HostStreamProvider>
        {readers.home ? (
          <HomeBotRow
            bot={BOT}
            hostReach={{
              directoryHostIds: new Set([EFFECTIVE_HOST.hostId]),
              connectableHostIds: new Set([EFFECTIVE_HOST.hostId]),
              connectableResolved: true,
              personalHostIds: new Set(),
            }}
            environmentHostIds={new Set()}
            environmentOwnerKind="organization"
            createdBy={null}
            isMain={false}
          />
        ) : null}
        {readers.perHostReaderOn === null ? null : (
          <PerHostReader hostId={readers.perHostReaderOn} />
        )}
      </HostStreamProvider>
    </QueryClientProvider>
  );
}

/**
 * Mounts the readers and returns once every reader has had its client: the
 * provider's app-wide client plus the per-host cache's one are both built, and
 * at least one `bot.subscribe` is open. A reader that shares a client opens no
 * more; one that dials its own has opened by the flush that follows.
 */
async function mountReaders(readers: Readers): Promise<{
  readonly setReaders: (next: Readers) => void;
}> {
  const queryClient = new QueryClient();
  const view = render(tree(queryClient, readers));
  await waitFor(() => {
    expect(ledger.clientIds.length).toBeGreaterThanOrEqual(2);
    expect(ledger.botStreams.length).toBeGreaterThan(0);
  });
  await act(() => Promise.resolve());
  return {
    setReaders: (next) => view.rerender(tree(queryClient, next)),
  };
}

beforeEach(() => {
  ledger.clientIds = [];
  ledger.botStreams = [];
  pointWindowAtEffectiveHost();
});

afterEach(() => {
  cleanup();
  __resetBotSubscriptionsForTesting();
  resetHostStreamClientCacheForTest();
  resetRemoteResumeSweepForTest();
  resetHostConnectionRegistryForTest();
  useSelectionAuthorityStore.getState().reset();
  bindingRef.value = null;
  bindingRef.directory = null;
});

describe("one bot.subscribe stream per bot per host", () => {
  it("opens one stream when Home's row and a per-host reader read the same bot on the same host", async () => {
    await mountReaders({
      home: true,
      perHostReaderOn: EFFECTIVE_HOST.hostId,
    });

    expect(ledger.botStreams).toHaveLength(1);
  });

  it("keeps the shared stream open until its last reader unmounts", async () => {
    const { setReaders } = await mountReaders({
      home: true,
      perHostReaderOn: EFFECTIVE_HOST.hostId,
    });
    expect(ledger.botStreams).toHaveLength(1);

    setReaders({ home: false, perHostReaderOn: EFFECTIVE_HOST.hostId });
    await act(() => Promise.resolve());
    expect(closedBotStreams()).toBe(0);
    expect(liveBotStreams()).toBe(1);

    setReaders({ home: false, perHostReaderOn: null });
    await waitFor(() => expect(closedBotStreams()).toBe(1));
    expect(liveBotStreams()).toBe(0);
  });

  it("opens a stream per host when the readers read the bot on different hosts", async () => {
    await mountReaders({ home: true, perHostReaderOn: OTHER_HOST.hostId });

    await waitFor(() => expect(liveBotStreams()).toBe(2));
    expect(new Set(ledger.botStreams.map((s) => s.clientId)).size).toBe(2);
  });
});
