import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSyncExternalStore, type ReactNode } from "react";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  WsStreamClient,
  type ParamsOf,
  type StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { WorkspaceSubscribeFileListServerFrame } from "@traycer/protocol/host/workspace/subscribe";
import type {
  WorkspaceSearchPathResult,
  WorkspaceSearchPathsOutcome,
  WorkspaceSearchPathsRequest,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContext } from "@traycer/protocol/auth/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import {
  fileTreeExpansionScopeKey,
  useFileTreeStore,
} from "@/stores/file-tree/file-tree-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { __resetWorkspaceFileListSubscriptionsForTesting } from "@/hooks/workspace/use-workspace-file-list-subscription";

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";
const WORKSPACE_PATH = "/work/repo";

const hostClientRef: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};

const listFileTreeCalls: Array<{
  readonly workspacePath: string | null;
  readonly enabled: boolean;
}> = [];
interface RecordedReset {
  readonly paths: ReadonlyArray<string>;
  readonly initialExpandedPaths: ReadonlyArray<string> | undefined;
}
const resetPathsCalls: RecordedReset[] = [];
const setSearchCalls: Array<string | null> = [];

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => HOST_ID,
}));

// Only `useHostClient` is replaced: the real `useWorkspaceSearchPaths`,
// its query wiring, and the echo guard all run against a mock TRANSPORT, so
// the tests exercise the actual request shape and stale-reply handling.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => hostClientRef.current };
});

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: () => ({
    data: null,
    error: null,
    isPending: false,
    repoState: null,
    repoMode: null,
    pollStartedAtMs: null,
  }),
}));

// One STABLE data object, like real TanStack Query data (referentially stable
// across renders). A per-call literal gives `treePaths` a new identity every
// render, which defeats the panel's applied-paths guard and loops the
// reset -> re-assert -> snapshot-notify cycle.
const UNARY_TREE_DATA = {
  workspacePath: WORKSPACE_PATH,
  files: [{ path: "unary.md", name: "unary.md" }],
  gitStatus: [],
  truncated: false,
};

vi.mock("@/hooks/workspace/use-list-file-tree-query", () => ({
  useWorkspaceListFileTree: (
    workspacePath: string | null,
    enabled: boolean,
  ) => {
    listFileTreeCalls.push({ workspacePath, enabled });
    return {
      data: enabled ? UNARY_TREE_DATA : undefined,
      error: null,
      isLoading: false,
    };
  },
}));

vi.mock("@/components/epic-canvas/dnd/epic-canvas-dnd-context-value", () => ({
  useEpicCanvasDnd: () => ({
    activeSource: null,
    dropPreview: null,
    interactionLocked: false,
    clearDropPreview: () => undefined,
  }),
}));

// Faithful enough for expansion round-tripping: the real model applies
// `initialExpandedPaths` on reset and reports it back through `getItem`, which
// is exactly the loop the panel's expansion sync rides.
const expandedInModel = new Set<string>();
const expandedAtLastReset = new Set<string>();

// Reactive search snapshot for the mocked `useFileTreeSearch`, recomputed on
// every setSearch/resetPaths so the panel's zero-match empty state is
// observable. Matching mirrors the real controller: case-insensitive
// substring over the listed paths.
let mockListedPaths: ReadonlyArray<string> = [];
let mockSearchValue = "";
let mockSearchSnapshot = {
  isOpen: false,
  value: "",
  matchingPaths: [] as ReadonlyArray<string>,
};
const searchSnapshotListeners = new Set<() => void>();
function refreshSearchSnapshot(): void {
  const value = mockSearchValue;
  const matchingPaths =
    value.length === 0
      ? []
      : mockListedPaths.filter((path) =>
          path.toLowerCase().includes(value.toLowerCase()),
        );
  const previous = mockSearchSnapshot;
  if (
    previous.value === value &&
    previous.matchingPaths.length === matchingPaths.length &&
    previous.matchingPaths.every((path, i) => path === matchingPaths[i])
  ) {
    return;
  }
  mockSearchSnapshot = { isOpen: value.length > 0, value, matchingPaths };
  for (const listener of searchSnapshotListeners) listener();
}
// Stable identities: an inline subscribe would make useSyncExternalStore
// resubscribe every render and loop on any snapshot change.
function subscribeToSearchSnapshot(listener: () => void): () => void {
  searchSnapshotListeners.add(listener);
  return () => {
    searchSnapshotListeners.delete(listener);
  };
}
function getSearchSnapshot(): typeof mockSearchSnapshot {
  return mockSearchSnapshot;
}

// ONE stable model object, like the real `useFileTree` (its model identity
// never changes for a mounted tree). A per-render model would re-run every
// model-dependent effect on each render - with the reactive search snapshot
// above, that is an infinite loop jsdom would otherwise hide.
const mockModel = {
  setSearch: (value: string | null) => {
    setSearchCalls.push(value);
    // The real model takes over expansion while a filter is applied (it
    // reveals its own matches) and restores the pre-filter set when the
    // filter clears. Mirroring that is what makes "filtering must not churn
    // coverage" observable here at all.
    expandedInModel.clear();
    if (value === null) {
      for (const path of expandedAtLastReset) expandedInModel.add(path);
    }
    mockSearchValue = value ?? "";
    refreshSearchSnapshot();
  },
  setGitStatus: () => undefined,
  resetPaths: (
    paths: ReadonlyArray<string>,
    options:
      { readonly initialExpandedPaths?: ReadonlyArray<string> } | undefined,
  ) => {
    resetPathsCalls.push({
      paths,
      initialExpandedPaths: options?.initialExpandedPaths,
    });
    expandedInModel.clear();
    expandedAtLastReset.clear();
    for (const path of options?.initialExpandedPaths ?? []) {
      expandedInModel.add(path);
      expandedAtLastReset.add(path);
    }
    mockListedPaths = paths;
    refreshSearchSnapshot();
  },
  subscribe: () => () => undefined,
  getItem: (path: string) =>
    path.endsWith("/")
      ? {
          isDirectory: () => true,
          isExpanded: () => expandedInModel.has(path),
        }
      : null,
};

vi.mock("@pierre/trees/react", () => ({
  FileTree: () => <div data-testid="pierre-file-tree-stub" />,
  useFileTreeSearch: () =>
    useSyncExternalStore(subscribeToSearchSnapshot, getSearchSnapshot),
  useFileTree: () => ({ model: mockModel }),
}));

import { FileTreePanelBodyForWorkspace } from "@/components/epic-canvas/sidebar/epic-sidebar-file-tree";

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  readonly clientFrameKinds: string[] = [];

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }
  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }
  sendClientFrame(envelope: { readonly kind: string }): void {
    this.clientFrameKinds.push(envelope.kind);
  }
  requestReconnect(): void {}
  close(): void {
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }
  emitFrame(frame: WorkspaceSubscribeFileListServerFrame): void {
    this.serverFrameHandler?.(frame, null);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly subscribedMethods: string[] = [];
  readonly sessions: MockStreamSession[] = [];

  constructor(private readonly support: StreamMethodSupport) {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override getMethodSupport<
    Method extends keyof HostStreamRpcRegistry & string,
  >(_method: Method): StreamMethodSupport {
    return this.support;
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribedMethods.push(method);
    const session = new MockStreamSession();
    this.sessions.push(session);
    return session;
  }
}

interface SearchScript {
  readonly results: ReadonlyArray<WorkspaceSearchPathResult>;
  readonly truncated: boolean;
  readonly outcome: WorkspaceSearchPathsOutcome;
  /** Echoed back verbatim, so a test can simulate a reply for another root. */
  readonly echoRoot: string;
  readonly echoEpicId: string;
  /** Throws instead of answering - e.g. a host without the method. */
  readonly reject: HostRpcError | null;
}

const searchCalls: WorkspaceSearchPathsRequest[] = [];

function installSearchHost(script: Partial<SearchScript>): void {
  const resolved: SearchScript = {
    results: [],
    truncated: false,
    outcome: "ready",
    echoRoot: WORKSPACE_PATH,
    echoEpicId: EPIC_ID,
    reject: null,
    ...script,
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    handlers: {
      "workspace.searchPaths": (params) => {
        searchCalls.push(params);
        if (resolved.reject !== null) throw resolved.reject;
        return {
          epicId: resolved.echoEpicId,
          root: resolved.echoRoot,
          outcome: resolved.outcome,
          results: [...resolved.results],
          truncated: resolved.truncated,
        };
      },
    },
    requestId: () => "request-test",
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => {} },
  });
  client.bind({
    hostId: HOST_ID,
    label: "Test Host",
    kind: "mock",
    websocketUrl: "ws://host.test",
    version: "test",
    status: "available",
  });
  client.setRequestContext(
    createRequestContext({
      identity: { userId: "user-test", username: "test", providerHandle: null },
      bearerToken: "token-test",
      origin: "test",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
    }),
  );
  hostClientRef.current = client;
}

function fileResult(relPath: string): WorkspaceSearchPathResult {
  return {
    kind: "file",
    relPath,
    name: relPath.split("/").at(-1) ?? relPath,
  };
}

function folderResult(relPath: string): WorkspaceSearchPathResult {
  return {
    kind: "folder",
    relPath,
    name: relPath.split("/").at(-1) ?? relPath,
  };
}

function typeFilter(value: string): void {
  fireEvent.change(screen.getByLabelText("Filter files by name"), {
    target: { value },
  });
}

function renderPanel(client: MockWsStreamClient): void {
  // `retry: false`: an unsupported-method rejection is a verdict, not a blip -
  // retrying it only delays the fallback the panel is being tested for.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <StreamRuntimeContext.Provider value={{ wsStreamClient: client }}>
        {children}
      </StreamRuntimeContext.Provider>
    </QueryClientProvider>
  );
  render(
    wrap(
      <FileTreePanelBodyForWorkspace
        epicId={EPIC_ID}
        tabId="tab-1"
        workspacePath={WORKSPACE_PATH}
      />,
    ),
  );
}

describe("sidebar file tree source selection", () => {
  beforeEach(() => {
    // Real store, seeded: the git-status subscription params are derived from
    // this preference, so the value has to be deterministic without faking an
    // internal Zustand store.
    useSettingsStore.setState({
      diffViewerPreferences: {
        ...DEFAULT_DIFF_VIEWER_PREFERENCES,
        ignoreWhitespace: false,
      },
    });
    mockListedPaths = [];
    mockSearchValue = "";
    mockSearchSnapshot = { isOpen: false, value: "", matchingPaths: [] };
    searchSnapshotListeners.clear();
    listFileTreeCalls.length = 0;
    resetPathsCalls.length = 0;
    setSearchCalls.length = 0;
    searchCalls.length = 0;
    expandedInModel.clear();
    expandedAtLastReset.clear();
    installSearchHost({});
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  afterEach(() => {
    cleanup();
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  it("builds the tree from the live stream and leaves the unary path disabled", async () => {
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);

    expect(client.subscribedMethods).toEqual(["workspace.subscribeFileList"]);
    expect(listFileTreeCalls.at(-1)?.enabled).toBe(false);

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [
          { path: "live.md", name: "live.md", kind: "file", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual(["live.md"]);
    });
  });

  it("falls back to the unary snapshot when the host rejects the method", async () => {
    // What an older host produces: the client-side compatibility mirror marks
    // the method unsupported at handshake and closes that session.
    const client = new MockWsStreamClient("unsupported");
    renderPanel(client);

    expect(client.subscribedMethods).toEqual([]);
    expect(listFileTreeCalls.at(-1)?.enabled).toBe(true);
    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual(["unary.md"]);
    });
  });
});

describe("sidebar file tree filter source", () => {
  function renderLiveTree(): MockWsStreamClient {
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);
    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [
          { path: "src/", name: "src", kind: "directory", ignored: false },
          { path: "live.md", name: "live.md", kind: "file", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });
    return client;
  }

  beforeEach(() => {
    // Real store, seeded: the git-status subscription params are derived from
    // this preference, so the value has to be deterministic without faking an
    // internal Zustand store.
    useSettingsStore.setState({
      diffViewerPreferences: {
        ...DEFAULT_DIFF_VIEWER_PREFERENCES,
        ignoreWhitespace: false,
      },
    });
    mockListedPaths = [];
    mockSearchValue = "";
    mockSearchSnapshot = { isOpen: false, value: "", matchingPaths: [] };
    searchSnapshotListeners.clear();
    listFileTreeCalls.length = 0;
    resetPathsCalls.length = 0;
    setSearchCalls.length = 0;
    searchCalls.length = 0;
    expandedInModel.clear();
    expandedAtLastReset.clear();
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  afterEach(() => {
    cleanup();
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  it("asks the host for ranked matches and rebuilds the tree from them", async () => {
    installSearchHost({
      results: [fileResult("src/lib/main.ts"), folderResult("src/mainlib")],
    });
    renderLiveTree();

    typeFilter("main");

    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual([
        "src/lib/main.ts",
        // A folder result arrives without a trailing slash; the tree needs the
        // canonical directory token to render it as a folder row.
        "src/mainlib/",
      ]);
    });
    expect(searchCalls.at(-1)).toMatchObject({
      epicId: EPIC_ID,
      reference: { root: WORKSPACE_PATH },
      query: "main",
      kinds: "both",
    });
    // Matches are only visible if their ancestors are open, and the local row
    // filter must not run on top of a host-ranked result set.
    expect(resetPathsCalls.at(-1)?.initialExpandedPaths).toEqual([
      "src/",
      "src/lib/",
    ]);
    expect(setSearchCalls.at(-1)).toBeNull();
  });

  it("says so when the host truncated the match set", async () => {
    installSearchHost({
      results: [fileResult("src/lib/main.ts")],
      truncated: true,
    });
    renderLiveTree();

    typeFilter("main");

    await screen.findByText(/narrow the filter to see more/);
  });

  it("drops a reply echoing another root and keeps filtering locally", async () => {
    installSearchHost({
      results: [fileResult("elsewhere/main.ts")],
      echoRoot: "/some/other/worktree",
    });
    renderLiveTree();

    typeFilter("main");

    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("main");
    });
    // The request DID go out - this is the guard dropping its answer, not a
    // search that never happened.
    expect(searchCalls).toHaveLength(1);
    expect(resetPathsCalls.at(-1)?.paths).toEqual(["src/", "live.md"]);
  });

  it("keeps the tree searchable when the root is not authorized", async () => {
    installSearchHost({ outcome: "root_unavailable" });
    renderLiveTree();

    typeFilter("main");

    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("main");
    });
    expect(searchCalls).toHaveLength(1);
    expect(resetPathsCalls.at(-1)?.paths).toEqual(["src/", "live.md"]);
  });

  it("filters locally on a host without the method, and stops asking it", async () => {
    installSearchHost({
      reject: new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "This host does not support 'workspace.searchPaths'.",
        requestId: "request-test",
        method: "workspace.searchPaths",
        fatalDetails: null,
      }),
    });
    renderLiveTree();

    typeFilter("main");
    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("main");
    });
    expect(searchCalls).toHaveLength(1);

    // The latched verdict backs the filter with the whole-workspace snapshot:
    // a live tree's loaded rows are only the expanded directories, so a local
    // filter over them would silently match nothing.
    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual(["unary.md"]);
    });
    expect(listFileTreeCalls.at(-1)?.enabled).toBe(true);
    // Pierre keeps the search VALUE across resetPaths but not its match set,
    // and setSearch no-ops on an unchanged value - the component must force a
    // recomputation with a null->value cycle or the snapshot renders
    // unfiltered (observed live).
    expect(setSearchCalls.slice(-2)).toEqual([null, "main"]);

    // The verdict is latched per (host, workspace): a further keystroke filters
    // the snapshot without re-asking a host that already said no.
    typeFilter("main.ts");
    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("main.ts");
    });
    expect(searchCalls).toHaveLength(1);

    // Clearing the query returns to the live stream tree and releases the
    // snapshot query.
    typeFilter("");
    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual(["src/", "live.md"]);
    });
    expect(listFileTreeCalls.at(-1)?.enabled).toBe(false);
  });

  it("latches onto local filtering when the host advertises the method but has no resolver", async () => {
    // A host built between the OSS contract landing and its internal resolver
    // landing negotiates `workspace.searchPaths` (the registry-derived
    // manifest carried the contract) and then 404s the request. That verdict
    // must latch exactly like E_HOST_UNSUPPORTED - without it the panel
    // re-asks on every keystroke and never settles into the local filter.
    installSearchHost({
      reject: new HostRpcError({
        code: "RPC_ERROR",
        message: "No resolver registered for method 'workspace.searchPaths'",
        requestId: "request-test",
        method: "workspace.searchPaths",
        fatalDetails: null,
      }),
    });
    renderLiveTree();

    typeFilter("main");
    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("main");
    });
    expect(searchCalls).toHaveLength(1);
    // Same latch, same degrade: the snapshot backs the filter.
    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual(["unary.md"]);
    });

    typeFilter("main.ts");
    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("main.ts");
    });
    expect(searchCalls).toHaveLength(1);
  });

  it("shows an explicit empty state when the local filter matches nothing", async () => {
    // Pierre renders the FULL tree on zero matches; the panel must replace
    // that with an honest "no matches" state instead of a misleading root
    // listing.
    installSearchHost({
      reject: new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "This host does not support 'workspace.searchPaths'.",
        requestId: "request-test",
        method: "workspace.searchPaths",
        fatalDetails: null,
      }),
    });
    renderLiveTree();

    typeFilter("zzz-no-such-file");
    await waitFor(() => {
      expect(screen.getByLabelText("No matching files")).toBeTruthy();
    });

    // A query that does match clears the empty state again.
    typeFilter("unary");
    await waitFor(() => {
      expect(screen.queryByLabelText("No matching files")).toBeNull();
    });
  });

  it("shows the empty state when host search returns zero results", async () => {
    installSearchHost({ results: [] });
    renderLiveTree();

    typeFilter("zzz-no-such-file");
    await waitFor(() => {
      expect(screen.getByLabelText("No matching files")).toBeTruthy();
    });
  });

  it("never asks the host to search while on the unary snapshot", async () => {
    installSearchHost({ results: [fileResult("src/lib/main.ts")] });
    const client = new MockWsStreamClient("unsupported");
    renderPanel(client);

    typeFilter("main");

    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("main");
    });
    expect(searchCalls).toEqual([]);
    expect(resetPathsCalls.at(-1)?.paths).toEqual(["unary.md"]);
  });

  it("leaves stream coverage alone while filtering", async () => {
    // Coverage is derived from the durable expansion set, and BOTH filter modes
    // move the tree's expansion on their own (host matches expand their
    // ancestors; the row filter expands its matches). If those transients were
    // synced back, filtering would silently unwatch what the user was browsing.
    useFileTreeStore
      .getState()
      .setExpandedPaths(EPIC_ID, HOST_ID, WORKSPACE_PATH, ["src/"]);
    installSearchHost({ outcome: "root_unavailable" });
    const client = renderLiveTree();
    await waitFor(() => {
      expect(client.sessions[0].clientFrameKinds).toEqual(["watch"]);
    });

    typeFilter("main");
    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("main");
    });

    expect(client.sessions[0].clientFrameKinds).toEqual(["watch"]);
    expect(
      useFileTreeStore.getState().expandedPathsByScope[
        fileTreeExpansionScopeKey(EPIC_ID, HOST_ID, WORKSPACE_PATH)
      ],
    ).toEqual(["src/"]);
  });

  it("returns to the live tree when the filter is cleared", async () => {
    installSearchHost({ results: [fileResult("src/lib/main.ts")] });
    renderLiveTree();

    typeFilter("main");
    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual(["src/lib/main.ts"]);
    });

    typeFilter("");

    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual(["src/", "live.md"]);
    });
    expect(setSearchCalls.at(-1)).toBeNull();
  });
});
