import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { TerminalSubscribeViewer } from "@traycer/protocol/host/terminal/subscribe";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { MEASURE_GRID_TIMEOUT_MS } from "@/hooks/agent/use-terminal-tile-bootstrap";
import { usePlainTerminalMutations } from "@/hooks/terminal/use-plain-terminal-mutations";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  __setTerminalStreamClientFactoryForTests,
  disposeAllTerminalSessions,
} from "@/lib/registries/terminal-session-registry";
import {
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import {
  useLandingPanelStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-panel-store";
import { LandingTerminalTile } from "../landing-terminal-tile";
import type { LandingTerminalAuthorityEntry } from "../landing-terminal-authority-fleet";

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host A",
    basis: "directory",
    unavailability: null,
  }),
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

// jsdom cannot mount xterm; everything else in the bootstrap module (the
// measure timeout in particular) stays real.
vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-terminal-tile-bootstrap")
    >();
  return { ...actual, TerminalXtermHost: () => null };
});

// jsdom cannot measure a grid, so the probe never reports one and the durable
// bootstrap takes its `MEASURE_GRID_TIMEOUT_MS` fallback.
vi.mock(
  "@/components/epic-canvas/renderers/terminal-grid-measure-probe",
  () => ({ TerminalGridMeasureProbe: () => null }),
);

// The registry hook only reads these to derive a transport identity, and the
// stream-client factory seam below replaces the transport it would open.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

const globalClientRef = vi.hoisted(
  (): { value: HostClient<HostRpcRegistry> | null } => ({ value: null }),
);
vi.mock("@/lib/host", () => ({
  // `TabHostProvider`'s draft mirror is null-safe: no binding, no mirror.
  useHostBinding: () => null,
  useHostClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test: globalClientRef not configured");
    }
    return globalClientRef.value;
  },
}));

const stableOpenTransport = vi.hoisted(() => {
  return (hostId: string): never => {
    throw new Error(`test: no transport expected for ${hostId}`);
  };
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => stableOpenTransport,
}));

const HOST_ID = "host-a";
const PLAIN_SCOPE = { kind: "independent" } as const;
const CAPABLE = {
  status: "capable",
  schemaVersion: { major: 1, minor: 0 },
} as const;

const TAB: LandingTerminalTabRef = {
  kind: "terminal",
  instanceId: "inst-landing-viewer",
  sessionId: "landing-viewer-term",
  hostId: HOST_ID,
  cwd: "/work/repo",
  name: "shell",
  titleSource: "default",
};

const RUNNING_TERMINAL: PlainTerminalProjection = {
  record: {
    terminalId: TAB.sessionId,
    hostId: HOST_ID,
    scope: PLAIN_SCOPE,
    launch: {
      cwd: TAB.cwd,
      shellCommand: "/bin/zsh",
      shellArgs: ["-l"],
    },
    manualTitle: null,
    revision: 1,
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:01:00.000Z",
  },
  runtime: {
    status: "running",
    sessionId: TAB.sessionId,
    currentCwd: TAB.cwd,
    activeProcessName: "zsh",
    cols: 100,
    rows: 30,
  },
};

const COLLECTION: PlainTerminalCollection = setPlainTerminalStreamStatus(
  settlePlainTerminalSnapshot(
    replacePlainTerminalSnapshot(undefined, [RUNNING_TERMINAL]),
  ),
  "open",
);

const resolveNoOwnerClient = (): null => null;

interface RecordedTerminalStream {
  readonly viewer: TerminalSubscribeViewer;
  closeCount: number;
}

function installRecordingStreamFactory(): {
  readonly streams: () => ReadonlyArray<RecordedTerminalStream>;
} {
  const streams: RecordedTerminalStream[] = [];
  __setTerminalStreamClientFactoryForTests((args) => {
    const record: RecordedTerminalStream = {
      viewer: args.viewer,
      closeCount: 0,
    };
    streams.push(record);
    return {
      sendAction: () => undefined,
      close: () => {
        record.closeCount += 1;
      },
    };
  });
  return { streams: () => streams };
}

function buildGlobalClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

/**
 * Mounts the tile on its durable path: a capable host whose collection lists
 * this terminal as running. The authority entry is built by the real query and
 * mutation hooks, so it is the shape the panel's fleet would hand the tile.
 */
const collectionQueryOptions = queryOptions<
  PlainTerminalCollection,
  HostRpcError,
  PlainTerminalCollection
>({
  queryKey: hostQueryKeys.plainTerminals(HOST_ID, PLAIN_SCOPE),
  queryFn: () => Promise.resolve(COLLECTION),
  initialData: COLLECTION,
  staleTime: Infinity,
});

function TileHarness(props: { readonly panelOpen: boolean }): ReactNode {
  const query = useQuery(collectionQueryOptions);
  const mutations = usePlainTerminalMutations({
    authority: {
      hostId: HOST_ID,
      scope: PLAIN_SCOPE,
      canMutate: true,
      collection: COLLECTION,
    },
    client: null,
    resolveOwnerClient: resolveNoOwnerClient,
  });
  const authorityEntry: LandingTerminalAuthorityEntry = {
    authority: {
      hostId: HOST_ID,
      scope: PLAIN_SCOPE,
      capability: CAPABLE,
      collection: COLLECTION,
      terminals: [RUNNING_TERMINAL],
      coverage: COLLECTION.coverage,
      servingHostId: COLLECTION.servingHostId,
      canMutate: true,
      query,
    },
    mutations,
  };
  return (
    <LandingTerminalTile
      landingPageId="landing-1"
      tab={TAB}
      active
      panelOpen={props.panelOpen}
      createEnabled
      authorityEntry={authorityEntry}
    />
  );
}

describe("<LandingTerminalTile /> viewer intent", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    globalClientRef.value = buildGlobalClient();
    useLandingPanelStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    disposeAllTerminalSessions();
    __setTerminalStreamClientFactoryForTests(null);
    globalClientRef.value = null;
    queryClient.clear();
    useLandingPanelStore.getState().resetForTests();
    vi.useRealTimers();
  });

  function tileTree(args: {
    readonly panelOpen: boolean;
    readonly paneVisible: boolean;
  }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <PaneVisibilityContext.Provider value={args.paneVisible}>
          <TileHarness panelOpen={args.panelOpen} />
        </PaneVisibilityContext.Provider>
      </QueryClientProvider>
    );
  }

  /** The durable bootstrap enables its handle only after a grid or the timeout. */
  async function settleGridMeasure(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEASURE_GRID_TIMEOUT_MS);
    });
  }

  function openStreams(
    streams: ReadonlyArray<RecordedTerminalStream>,
  ): ReadonlyArray<RecordedTerminalStream> {
    return streams.filter((stream) => stream.closeCount === 0);
  }

  it("a collapsed panel's terminal attaches as cache", async () => {
    const recorded = installRecordingStreamFactory();

    render(tileTree({ panelOpen: false, paneVisible: true }));
    await settleGridMeasure();

    const open = openStreams(recorded.streams());
    expect(open).toHaveLength(1);
    expect(open[0].viewer).toBe("cache");
  });

  it("opening the panel makes it a presentation viewer", async () => {
    const recorded = installRecordingStreamFactory();

    const rendered = render(tileTree({ panelOpen: false, paneVisible: true }));
    await settleGridMeasure();
    const cacheStream = openStreams(recorded.streams())[0];
    expect(cacheStream.viewer).toBe("cache");

    rendered.rerender(tileTree({ panelOpen: true, paneVisible: true }));

    const open = openStreams(recorded.streams());
    expect(open).toHaveLength(1);
    expect(open[0].viewer).toBe("presentation");
    expect(cacheStream.closeCount).toBe(1);
  });

  it("a hidden Start Page's terminal attaches as cache even with the panel open", async () => {
    const recorded = installRecordingStreamFactory();

    render(tileTree({ panelOpen: true, paneVisible: false }));
    await settleGridMeasure();

    const open = openStreams(recorded.streams());
    expect(open).toHaveLength(1);
    expect(open[0].viewer).toBe("cache");
  });
});
