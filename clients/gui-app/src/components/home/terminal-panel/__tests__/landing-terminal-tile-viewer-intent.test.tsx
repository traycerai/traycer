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
import type {
  TerminalSubscribeClientFrameV17,
  TerminalSubscribeViewer,
} from "@traycer/protocol/host/terminal/subscribe";
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
  type PlainTerminalCapability,
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

// The legacy and the provider sign-in tiles bootstrap through `terminal.list` /
// `terminal.create`, not the plain-terminal authority. Both sessions are listed
// as running, so neither tile ever dispatches a create and each goes straight
// to opening its stream through the real session registry (the recording
// factory below). Only these three seams are faked; the bootstrap hook itself,
// the registry and the tiles are all real.
const listedTerminals = vi.hoisted(() => {
  const legacySessionId = "landing-viewer-legacy-term";
  const signInSessionId = "landing-viewer-signin-term";
  return {
    legacySessionId,
    signInSessionId,
    list: {
      data: {
        sessions: [
          {
            sessionId: legacySessionId,
            sessionKind: "terminal",
            status: "running",
          },
          {
            sessionId: signInSessionId,
            sessionKind: "terminal",
            status: "running",
          },
        ],
      },
      isFetching: false,
      refetch: () => Promise.resolve({}),
    },
    create: {
      isIdle: true,
      isError: false,
      isPending: false,
      isSuccess: false,
      error: null,
      reset: () => undefined,
      mutate: () => undefined,
    },
  };
});
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => globalClientRef.value,
}));
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => listedTerminals.list,
}));
vi.mock("@/hooks/terminal/use-terminal-create-mutation", () => ({
  useTerminalCreate: () => listedTerminals.create,
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

/** Rendered by `LandingTerminalLegacyBootstrap` when the host is `legacy`. */
const LEGACY_TAB: LandingTerminalTabRef = {
  ...TAB,
  instanceId: "inst-landing-viewer-legacy",
  sessionId: listedTerminals.legacySessionId,
};

/** A host-created provider sign-in session: `LandingSignInTerminalTile`. */
const SIGN_IN_TAB: LandingTerminalTabRef = {
  ...TAB,
  instanceId: "inst-landing-viewer-signin",
  sessionId: listedTerminals.signInSessionId,
  origin: "provider-login",
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
  /** Every client frame the store handed this stream, in order. */
  readonly frames: TerminalSubscribeClientFrameV17[];
  closeCount: number;
}

/**
 * Every stream the store opens is kept (with the viewer it was opened for),
 * records the client frames it was given, and counts its own `close()`.
 */
function installRecordingStreamFactory(): {
  readonly streams: () => ReadonlyArray<RecordedTerminalStream>;
} {
  const streams: RecordedTerminalStream[] = [];
  __setTerminalStreamClientFactoryForTests((args) => {
    const record: RecordedTerminalStream = {
      viewer: args.viewer,
      frames: [],
      closeCount: 0,
    };
    streams.push(record);
    return {
      sendAction: (frame) => {
        record.frames.push(frame);
      },
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

function TileHarness(props: {
  readonly tab: LandingTerminalTabRef;
  readonly capability: PlainTerminalCapability;
  readonly panelOpen: boolean;
  readonly active: boolean;
}): ReactNode {
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
      capability: props.capability,
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
      tab={props.tab}
      active={props.active}
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

  function tileTreeFor(args: {
    readonly tab: LandingTerminalTabRef;
    readonly capability: PlainTerminalCapability;
    readonly panelOpen: boolean;
    readonly paneVisible: boolean;
    readonly active: boolean;
  }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <PaneVisibilityContext.Provider value={args.paneVisible}>
          <TileHarness
            tab={args.tab}
            capability={args.capability}
            panelOpen={args.panelOpen}
            active={args.active}
          />
        </PaneVisibilityContext.Provider>
      </QueryClientProvider>
    );
  }

  function tileTree(args: {
    readonly panelOpen: boolean;
    readonly paneVisible: boolean;
    readonly active: boolean;
  }): ReactNode {
    return tileTreeFor({ ...args, tab: TAB, capability: CAPABLE });
  }

  /** The durable bootstrap enables its handle only after a grid or the timeout. */
  async function settleGridMeasure(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEASURE_GRID_TIMEOUT_MS);
    });
  }

  it("a collapsed panel's terminal opens one stream, as cache", async () => {
    const recorded = installRecordingStreamFactory();

    render(tileTree({ panelOpen: false, paneVisible: true, active: true }));
    await settleGridMeasure();

    const streams = recorded.streams();
    expect(streams).toHaveLength(1);
    expect(streams[0].viewer).toBe("cache");
    expect(streams[0].closeCount).toBe(0);
    expect(streams[0].frames).toEqual([]);
  });

  it("opening the panel restates presentation on the same stream, without reopening it", async () => {
    const recorded = installRecordingStreamFactory();

    const rendered = render(
      tileTree({ panelOpen: false, paneVisible: true, active: true }),
    );
    await settleGridMeasure();
    expect(recorded.streams()).toHaveLength(1);
    const stream = recorded.streams()[0];
    expect(stream.viewer).toBe("cache");
    expect(stream.frames).toEqual([]);

    rendered.rerender(
      tileTree({ panelOpen: true, paneVisible: true, active: true }),
    );

    // The same stream: never closed, no second one opened, and the intent
    // went out as a `viewer` frame on it.
    expect(recorded.streams()).toHaveLength(1);
    expect(recorded.streams()[0]).toBe(stream);
    expect(stream.closeCount).toBe(0);
    expect(stream.frames).toEqual([
      {
        kind: "viewer",
        hasBinaryPayload: false,
        sessionId: TAB.sessionId,
        viewer: "presentation",
      },
    ]);
  });

  it("a hidden Start Page's terminal opens one stream, as cache, even with the panel open", async () => {
    const recorded = installRecordingStreamFactory();

    render(tileTree({ panelOpen: true, paneVisible: false, active: true }));
    await settleGridMeasure();

    const streams = recorded.streams();
    expect(streams).toHaveLength(1);
    expect(streams[0].viewer).toBe("cache");
    expect(streams[0].closeCount).toBe(0);
    expect(streams[0].frames).toEqual([]);
  });

  it("an inactive tab of an open panel attaches as cache", async () => {
    const recorded = installRecordingStreamFactory();

    render(tileTree({ panelOpen: true, paneVisible: true, active: false }));
    await settleGridMeasure();

    const streams = recorded.streams();
    expect(streams).toHaveLength(1);
    expect(streams[0].viewer).toBe("cache");
    expect(streams[0].closeCount).toBe(0);
    expect(streams[0].frames).toEqual([]);
  });

  it("activating the tab restates presentation on the same stream", async () => {
    const recorded = installRecordingStreamFactory();

    const rendered = render(
      tileTree({ panelOpen: true, paneVisible: true, active: false }),
    );
    await settleGridMeasure();
    expect(recorded.streams()).toHaveLength(1);
    const stream = recorded.streams()[0];
    expect(stream.viewer).toBe("cache");
    expect(stream.frames).toEqual([]);

    rendered.rerender(
      tileTree({ panelOpen: true, paneVisible: true, active: true }),
    );

    expect(recorded.streams()).toHaveLength(1);
    expect(recorded.streams()[0]).toBe(stream);
    expect(stream.closeCount).toBe(0);
    expect(stream.frames).toEqual([
      {
        kind: "viewer",
        hasBinaryPayload: false,
        sessionId: TAB.sessionId,
        viewer: "presentation",
      },
    ]);
  });

  it("deactivating the tab restates cache on the same stream", async () => {
    const recorded = installRecordingStreamFactory();

    const rendered = render(
      tileTree({ panelOpen: true, paneVisible: true, active: true }),
    );
    await settleGridMeasure();
    expect(recorded.streams()).toHaveLength(1);
    const stream = recorded.streams()[0];
    expect(stream.viewer).toBe("presentation");
    expect(stream.frames).toEqual([]);

    rendered.rerender(
      tileTree({ panelOpen: true, paneVisible: true, active: false }),
    );

    expect(recorded.streams()).toHaveLength(1);
    expect(recorded.streams()[0]).toBe(stream);
    expect(stream.closeCount).toBe(0);
    expect(stream.frames).toEqual([
      {
        kind: "viewer",
        hasBinaryPayload: false,
        sessionId: TAB.sessionId,
        viewer: "cache",
      },
    ]);
  });

  // The legacy bootstrap (`terminal.list` / `terminal.create`) and the provider
  // sign-in tile used to pin every stream they opened as `presentation`, so a
  // mounted-but-hidden one counted as a GUI viewer and sized the shared grid.
  describe("a tile that bootstraps without the plain-terminal authority", () => {
    const LEGACY: PlainTerminalCapability = { status: "legacy" };

    function legacyTree(args: {
      readonly panelOpen: boolean;
      readonly paneVisible: boolean;
      readonly active: boolean;
    }): ReactNode {
      return tileTreeFor({ ...args, tab: LEGACY_TAB, capability: LEGACY });
    }

    function signInTree(args: {
      readonly panelOpen: boolean;
      readonly paneVisible: boolean;
      readonly active: boolean;
    }): ReactNode {
      return tileTreeFor({ ...args, tab: SIGN_IN_TAB, capability: CAPABLE });
    }

    it("a legacy terminal on screen opens one stream, as presentation", async () => {
      const recorded = installRecordingStreamFactory();

      render(legacyTree({ panelOpen: true, paneVisible: true, active: true }));
      await settleGridMeasure();

      const streams = recorded.streams();
      expect(streams).toHaveLength(1);
      expect(streams[0].viewer).toBe("presentation");
      expect(streams[0].closeCount).toBe(0);
      expect(streams[0].frames).toEqual([]);
    });

    it("an inactive legacy terminal opens one stream, as cache", async () => {
      const recorded = installRecordingStreamFactory();

      render(legacyTree({ panelOpen: true, paneVisible: true, active: false }));
      await settleGridMeasure();

      const streams = recorded.streams();
      expect(streams).toHaveLength(1);
      expect(streams[0].viewer).toBe("cache");
      expect(streams[0].closeCount).toBe(0);
      expect(streams[0].frames).toEqual([]);
    });

    it("a legacy terminal in a collapsed panel opens one stream, as cache", async () => {
      const recorded = installRecordingStreamFactory();

      render(legacyTree({ panelOpen: false, paneVisible: true, active: true }));
      await settleGridMeasure();

      const streams = recorded.streams();
      expect(streams).toHaveLength(1);
      expect(streams[0].viewer).toBe("cache");
      expect(streams[0].frames).toEqual([]);
    });

    it("a legacy terminal on a hidden Start Page opens one stream, as cache", async () => {
      const recorded = installRecordingStreamFactory();

      render(legacyTree({ panelOpen: true, paneVisible: false, active: true }));
      await settleGridMeasure();

      const streams = recorded.streams();
      expect(streams).toHaveLength(1);
      expect(streams[0].viewer).toBe("cache");
      expect(streams[0].frames).toEqual([]);
    });

    it("bringing a legacy terminal on screen restates presentation on the same stream", async () => {
      const recorded = installRecordingStreamFactory();

      const rendered = render(
        legacyTree({ panelOpen: true, paneVisible: true, active: false }),
      );
      await settleGridMeasure();
      expect(recorded.streams()).toHaveLength(1);
      const stream = recorded.streams()[0];
      expect(stream.viewer).toBe("cache");

      rendered.rerender(
        legacyTree({ panelOpen: true, paneVisible: true, active: true }),
      );

      expect(recorded.streams()).toHaveLength(1);
      expect(recorded.streams()[0]).toBe(stream);
      expect(stream.closeCount).toBe(0);
      expect(stream.frames).toEqual([
        {
          kind: "viewer",
          hasBinaryPayload: false,
          sessionId: LEGACY_TAB.sessionId,
          viewer: "presentation",
        },
      ]);
    });

    it("a provider sign-in terminal on screen opens one stream, as presentation", async () => {
      const recorded = installRecordingStreamFactory();

      render(signInTree({ panelOpen: true, paneVisible: true, active: true }));
      await settleGridMeasure();

      const streams = recorded.streams();
      expect(streams).toHaveLength(1);
      expect(streams[0].viewer).toBe("presentation");
      expect(streams[0].closeCount).toBe(0);
      expect(streams[0].frames).toEqual([]);
    });

    it("an inactive provider sign-in terminal opens one stream, as cache", async () => {
      const recorded = installRecordingStreamFactory();

      render(signInTree({ panelOpen: true, paneVisible: true, active: false }));
      await settleGridMeasure();

      const streams = recorded.streams();
      expect(streams).toHaveLength(1);
      expect(streams[0].viewer).toBe("cache");
      expect(streams[0].closeCount).toBe(0);
      expect(streams[0].frames).toEqual([]);
    });

    it("a provider sign-in terminal on a hidden Start Page opens as cache, then restates presentation when shown", async () => {
      const recorded = installRecordingStreamFactory();

      const rendered = render(
        signInTree({ panelOpen: true, paneVisible: false, active: true }),
      );
      await settleGridMeasure();
      expect(recorded.streams()).toHaveLength(1);
      const stream = recorded.streams()[0];
      expect(stream.viewer).toBe("cache");
      expect(stream.frames).toEqual([]);

      rendered.rerender(
        signInTree({ panelOpen: true, paneVisible: true, active: true }),
      );

      expect(recorded.streams()).toHaveLength(1);
      expect(recorded.streams()[0]).toBe(stream);
      expect(stream.closeCount).toBe(0);
      expect(stream.frames).toEqual([
        {
          kind: "viewer",
          hasBinaryPayload: false,
          sessionId: SIGN_IN_TAB.sessionId,
          viewer: "presentation",
        },
      ]);
    });
  });
});
