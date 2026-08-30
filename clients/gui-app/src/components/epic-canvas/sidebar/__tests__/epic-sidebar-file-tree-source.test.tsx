import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useSyncExternalStore, type ReactNode } from "react";
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
import {
  StreamRuntimeContext,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import {
  fileTreeExpansionScopeKey,
  useFileTreeStore,
} from "@/stores/file-tree/file-tree-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { __resetWorkspaceFileListSubscriptionsForTesting } from "@/hooks/workspace/use-workspace-file-list-subscription";
import {
  requestFileTreeReveal,
  useFileTreeRevealStore,
} from "@/stores/file-tree/file-tree-reveal-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";
const WORKSPACE_PATH = "/work/repo";

const hostClientRef: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};
/** The APP-WIDE client - deliberately not the panel's, and never recorded. */
const ambientHostClientRef: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};

const listFileTreeCalls: Array<{
  readonly hostId: string | null;
  readonly workspacePath: string | null;
  readonly enabled: boolean;
}> = [];
interface RecordedReset {
  readonly paths: ReadonlyArray<string>;
  readonly initialExpandedPaths: ReadonlyArray<string> | undefined;
}
const resetPathsCalls: RecordedReset[] = [];
const setSearchCalls: Array<string | null> = [];

// The panel re-provides its own `StreamRuntimeContext` with whatever the pin
// hook hands it: the ambient binding this suite supplies while FOLLOWING (the
// client every assertion here is about), the pin's own binding when an arm
// sets `pinnedStreamBindingRef`, and null only while PENDING. Which transport
// the pin resolves to is a different question, and it has its own suite:
// `hooks/host/__tests__/use-surface-host-stream-binding.test.tsx`.
const pinnedStreamBindingRef = vi.hoisted(() => ({
  value: null as StreamRuntimeBinding | null,
}));

// The hook returns the value to PROVIDE: the pin's own binding when this suite
// supplies one, else the ambient binding (following). `null` would now mean
// PENDING - no client at all - which is not what these arms drive.
vi.mock("@/hooks/host/use-surface-host-stream-binding", async () => {
  const { use } = await import("react");
  const { StreamRuntimeContext } =
    await import("@/lib/host/stream-runtime-context");
  return {
    useSurfaceHostStreamBinding: () =>
      pinnedStreamBindingRef.value ?? use(StreamRuntimeContext),
  };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST_ID,
}));

// The real `useWorkspaceSearchPaths`, its query wiring and the echo guard all
// run against a mock TRANSPORT, so the tests exercise the actual request shape
// and stale-reply handling.
//
// THE TWO CLIENTS ARE DIFFERENT ON PURPOSE. This panel is host-pinned: it
// resolves its client from the `hostId` it was handed, and every `searchCalls`
// assertion below only records a request that reached THAT client's transport.
// The app-wide client is a distinct object with no recorder, so a build that
// reverts to reading the ambient host does not fail on a wrong value here - it
// fails as SILENCE, and the suite's existing "asked the host for ranked
// matches" cases are what catch it.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => ambientHostClientRef.current };
});

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === HOST_ID ? hostClientRef.current : ambientHostClientRef.current,
}));

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
  useWorkspaceListFileTree: (args: {
    readonly hostId: string | null;
    readonly workspacePath: string | null;
    readonly enabled: boolean;
  }) => {
    const { hostId, workspacePath, enabled } = args;
    listFileTreeCalls.push({ hostId, workspacePath, enabled });
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

// Reveal-in-sidebar mechanism state, additive to the expansion/search state
// above. `selectedInModel` mirrors Pierre's own selection set; `getItem`'s
// file handles read/write it and report every change through the SAME
// `onSelectionChange` callback a real click lands in (captured below), which
// is what lets the reveal effect's programmatic-selection guard be exercised
// here rather than assumed.
const selectedInModel = new Set<string>();
const scrollToPathCalls: Array<{
  readonly path: string;
  readonly options: { readonly offset: string };
}> = [];
const modelListeners = new Set<() => void>();
// Captured from the real `useFileTree(options)` call the panel makes - the
// mocked hook below stashes `options.onSelectionChange` here so a test can
// invoke it directly, the same way Pierre invokes it on a real row click.
let capturedOnSelectionChange: ((paths: ReadonlyArray<string>) => void) | null =
  null;
// Row geometry the panel asked Pierre for. Only observable here: `useFileTree`
// reads its options once, at construction, and the model exposes no getter the
// panel could be asked afterwards.
let capturedItemHeight: number | undefined = undefined;
let capturedDensity: string | undefined = undefined;
let capturedUnsafeCSS: string | undefined = undefined;
// How many times the model was CONSTRUCTED. The panel used to remount across
// the breakpoint to rebuild a touch-sized model; with one geometry everywhere
// there is nothing to rebuild, and this is what tells a surviving tree apart
// from a rebuilt one now that both viewports report the same geometry.
let modelConstructionCount = 0;

function notifyModel(): void {
  for (const listener of modelListeners) listener();
}

function reportSelectionChange(): void {
  capturedOnSelectionChange?.([...selectedInModel]);
}

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
      | { readonly initialExpandedPaths?: ReadonlyArray<string> }
      | undefined,
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
  subscribe: (listener: () => void) => {
    modelListeners.add(listener);
    return () => {
      modelListeners.delete(listener);
    };
  },
  // A directory handle is only returned once the host has actually LISTED
  // that path (membership in `mockListedPaths`), not merely because the
  // token ends with "/" - the real model has no notion of a directory it has
  // never been told about. This is what makes the reveal walk incremental in
  // these tests: `expand()` on an as-yet-unlisted ancestor is simply
  // unreachable, exactly as `model.getItem` returning `null` gates it in the
  // real component.
  getItem: (path: string) => {
    if (!mockListedPaths.includes(path)) return null;
    if (path.endsWith("/")) {
      return {
        isDirectory: () => true,
        isExpanded: () => expandedInModel.has(path),
        expand: () => {
          expandedInModel.add(path);
          notifyModel();
        },
        isSelected: () => false,
        select: () => undefined,
        deselect: () => undefined,
        getPath: () => path,
      };
    }
    return {
      isDirectory: () => false,
      isExpanded: () => false,
      isSelected: () => selectedInModel.has(path),
      select: () => {
        selectedInModel.add(path);
        reportSelectionChange();
      },
      deselect: () => {
        selectedInModel.delete(path);
        reportSelectionChange();
      },
      getPath: () => path,
    };
  },
  getSelectedPaths: () => [...selectedInModel],
  scrollToPath: (path: string, options: { readonly offset: string }) => {
    scrollToPathCalls.push({ path, options });
  },
};

vi.mock("@pierre/trees/react", () => ({
  FileTree: () => <div data-testid="pierre-file-tree-stub" />,
  useFileTreeSearch: () =>
    useSyncExternalStore(subscribeToSearchSnapshot, getSearchSnapshot),
  useFileTree: (options: {
    readonly onSelectionChange: (paths: ReadonlyArray<string>) => void;
    readonly itemHeight: number | undefined;
    readonly density: string;
    readonly unsafeCSS: string | undefined;
  }) => {
    capturedOnSelectionChange = options.onSelectionChange;
    capturedUnsafeCSS = options.unsafeCSS;
    // Mount-captured, exactly like the real hook's `useState(() => new
    // FileTree(options))`. Recording it per RENDER instead would make the row
    // geometry look reactive here when it is not, and the viewport-transition
    // case below would pass without the body ever having been rebuilt.
    const [geometryAtConstruction] = useState(() => {
      modelConstructionCount += 1;
      return { itemHeight: options.itemHeight, density: options.density };
    });
    capturedItemHeight = geometryAtConstruction.itemHeight;
    capturedDensity = geometryAtConstruction.density;
    return { model: mockModel };
  },
}));

import { FileTreePanelBodyForWorkspace } from "@/components/epic-canvas/sidebar/epic-sidebar-file-tree";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

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
  /** Never negotiates: this fake exercises no version-dependent path. */
  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
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
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
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
  const entry = {
    hostId: HOST_ID,
    label: "Test Host",
    kind: "mock" as const,
    websocketUrl: "ws://host.test",
    version: "test",
    transportDialability: "dialable" as const,
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
  });
  spine.setRequestContext(
    createRequestContext({
      identity: { userId: "user-test", username: "test", providerHandle: null },
      bearerToken: "token-test",
      origin: "test",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
    }),
  );
  hostClientRef.current = spine.createRequester(entry);
  // A SEPARATE app-wide client on the same spine, addressing a host this
  // fixture's messenger has no handlers for. Nothing routed here is recorded,
  // which is what turns "the panel read the ambient host" into a visible
  // absence rather than an indistinguishable pass.
  ambientHostClientRef.current = spine.createRequesterForHostId("host-ambient");
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
      <StreamRuntimeContext.Provider
        value={{ wsStreamClient: client, hostId: null }}
      >
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
        hostId={HOST_ID}
        onLatchHost={() => undefined}
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
    selectedInModel.clear();
    scrollToPathCalls.length = 0;
    modelListeners.clear();
    capturedOnSelectionChange = null;
    installSearchHost({});
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  afterEach(() => {
    cleanup();
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
    pinnedStreamBindingRef.value = null;
  });

  it("opens the stream on the PINNED host's transport, not the app-wide one", () => {
    // The panel re-provides `StreamRuntimeContext` for the host its pin
    // resolved to, and this is the arm that proves the provider actually sits
    // ABOVE the hooks that read it - an adjacency neither the hook's own suite
    // nor the subscription registry's can see, because each is correct in
    // isolation either way.
    //
    // Before the re-point this panel passed the pinned host's id as a
    // subscribe PARAM while riding the app-wide socket, which watches the
    // wrong machine's working tree and reports nothing wrong: the param is a
    // key, not a route. So the assertion is WHICH TRANSPORT carried the
    // subscribe, and the ambient client is here as the control - without it a
    // build that subscribed on both would pass.
    const ambient = new MockWsStreamClient("unknown");
    const pinned = new MockWsStreamClient("unknown");
    pinnedStreamBindingRef.value = {
      wsStreamClient: pinned,
      hostId: HOST_ID,
    };

    renderPanel(ambient);

    expect(pinned.subscribedMethods).toEqual(["workspace.subscribeFileList"]);
    expect(ambient.subscribedMethods).toEqual([]);
  });

  /**
   * Inside the mobile switcher sheet this tree is a vaul drawer descendant.
   * vaul's `shouldDrag` walks up from the touch target and, finding no
   * scrollable ancestor, returns true - it drags the drawer instead of letting
   * the content scroll. Pierre's scroller is inside a shadow root and a touch
   * inside one retargets to the host, so that walk starts outside the shadow
   * tree and can never see it. The attribute is what tells vaul to stay out.
   *
   * This is the WORKSPACE tree - the surface actually reported - and it needs
   * its own arm: the git-diff tree's assertion passes with this marker deleted,
   * so without this the coverage claim would be true of the wrong mount.
   *
   * It pins the marker, not the scrolling. Whether a finger scrolls is touch
   * arbitration, which jsdom cannot decide.
   */
  it("marks the tree wrapper as not a drawer-drag surface", () => {
    renderPanel(new MockWsStreamClient("unknown"));

    const tree = screen.getByTestId("pierre-file-tree-stub");
    expect(tree.closest("[data-vaul-no-drag]")).not.toBeNull();
  });

  /**
   * The tree's light-DOM wrapper carries `useShadowScrollerTouchShield`'s ref
   * (see `use-shadow-scroller-touch-shield.ts`), which stops a `touchmove`
   * bubbling out of Pierre's shadow-rooted scroller before it reaches a
   * document BUBBLE listener - the modal scroll lock a vaul drawer registers
   * while open. jsdom has no `TouchEvent`, so a plain bubbling `Event` stands
   * in; the hook only calls `stopPropagation()`, which does not care about
   * the event's concrete type. `touchstart` is the control: it is untouched
   * by this hook, so it must still reach the document. Deleting
   * `ref={touchShieldRef}` from the wrapper must fail this test.
   */
  it("shields a bubbling touchmove from the pierre tree so it never reaches the document", () => {
    renderPanel(new MockWsStreamClient("unknown"));

    const documentTouchMove = vi.fn();
    const documentTouchStart = vi.fn();
    document.addEventListener("touchmove", documentTouchMove);
    document.addEventListener("touchstart", documentTouchStart);
    try {
      const tree = screen.getByTestId("pierre-file-tree-stub");
      tree.dispatchEvent(new Event("touchmove", { bubbles: true }));
      tree.dispatchEvent(new Event("touchstart", { bubbles: true }));

      expect(documentTouchMove).not.toHaveBeenCalled();
      expect(documentTouchStart).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("touchmove", documentTouchMove);
      document.removeEventListener("touchstart", documentTouchStart);
    }
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
    selectedInModel.clear();
    scrollToPathCalls.length = 0;
    modelListeners.clear();
    capturedOnSelectionChange = null;
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

describe("reveal in sidebar", () => {
  const REVEAL_TAB_ID = "tab-1";

  /**
   * Emits the three listing frames the ancestor walk for `src/lib/a.ts`
   * needs (root, `src/`, `src/lib/`) and waits for the final one to land,
   * without asserting the intermediate steps - reused by the tests that only
   * care that the reveal SETTLED, not how it got there (the detailed,
   * step-by-step walk is covered on its own below).
   */
  async function revealSrcLibAToCompletion(
    client: MockWsStreamClient,
  ): Promise<void> {
    requestFileTreeReveal(REVEAL_TAB_ID, {
      hostId: HOST_ID,
      workspacePath: WORKSPACE_PATH,
      filePath: "src/lib/a.ts",
    });
    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [
          { path: "src/", name: "src", kind: "directory", ignored: false },
          {
            path: "readme.md",
            name: "readme.md",
            kind: "file",
            ignored: false,
          },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });
    await waitFor(() => {
      expect(expandedInModel.has("src/")).toBe(true);
    });
    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "src/",
        entries: [
          { path: "src/lib/", name: "lib", kind: "directory", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });
    await waitFor(() => {
      expect(expandedInModel.has("src/lib/")).toBe(true);
    });
    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "src/lib/",
        entries: [
          { path: "src/lib/a.ts", name: "a.ts", kind: "file", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });
    await waitFor(() => {
      expect(scrollToPathCalls.length).toBeGreaterThan(0);
    });
  }

  let openPreviewSpy: Mock<
    (tabId: string, node: EpicCanvasTileRef) => NestedFocusTarget | null
  >;

  beforeEach(() => {
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
    selectedInModel.clear();
    scrollToPathCalls.length = 0;
    modelListeners.clear();
    capturedOnSelectionChange = null;
    installSearchHost({});
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
    useFileTreeRevealStore.setState({ requestsByViewTabId: {} }, true);
    // The panel reads this action to open a row's preview on a genuine
    // selection; mocked so the "still opens on a real click" case is
    // observable without a real canvas/tab-strip mounted, and so the reveal
    // tests can assert it was NOT called for a programmatic selection.
    openPreviewSpy = vi.fn(() => null);
    useEpicCanvasStore.setState({
      prepareOpenTilePreviewInTabFocusTarget: openPreviewSpy,
    });
  });

  afterEach(() => {
    cleanup();
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
    useFileTreeRevealStore.setState({ requestsByViewTabId: {} }, true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("walks the ancestors one listing at a time and selects the row once listed, without opening a tile", async () => {
    requestFileTreeReveal(REVEAL_TAB_ID, {
      hostId: HOST_ID,
      workspacePath: WORKSPACE_PATH,
      filePath: "src/lib/a.ts",
    });
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [
          { path: "src/", name: "src", kind: "directory", ignored: false },
          {
            path: "readme.md",
            name: "readme.md",
            kind: "file",
            ignored: false,
          },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(expandedInModel.has("src/")).toBe(true);
    });
    expect(
      useFileTreeStore.getState().expandedPathsByScope[
        fileTreeExpansionScopeKey(EPIC_ID, HOST_ID, WORKSPACE_PATH)
      ],
    ).toContain("src/");
    await waitFor(() => {
      expect(client.sessions[0].clientFrameKinds).toContain("watch");
    });
    // The next ancestor is not listed yet, so the walk cannot have reached it.
    expect(expandedInModel.has("src/lib/")).toBe(false);

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "src/",
        entries: [
          { path: "src/lib/", name: "lib", kind: "directory", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(expandedInModel.has("src/lib/")).toBe(true);
    });
    expect(
      useFileTreeStore.getState().expandedPathsByScope[
        fileTreeExpansionScopeKey(EPIC_ID, HOST_ID, WORKSPACE_PATH)
      ],
    ).toContain("src/lib/");
    expect(selectedInModel.has("src/lib/a.ts")).toBe(false);

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "src/lib/",
        entries: [
          { path: "src/lib/a.ts", name: "a.ts", kind: "file", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(selectedInModel.has("src/lib/a.ts")).toBe(true);
    });
    expect(scrollToPathCalls).toEqual([
      { path: "src/lib/a.ts", options: { offset: "nearest" } },
    ]);
    expect(
      useFileTreeRevealStore.getState().requestsByViewTabId[REVEAL_TAB_ID],
    ).toBeUndefined();
    expect(openPreviewSpy).not.toHaveBeenCalled();
  });

  it("replaces a multi-row selection with the revealed row without opening a preview for the survivor", async () => {
    // With TWO rows selected, deselecting the first already reports a
    // NON-empty selection (the survivor), before the target is ever selected.
    // A one-shot path marker set just around `select()` lets that
    // notification through, opening the survivor's preview and then being
    // consumed so the target's own `select()` opens another. The suppression
    // has to span the whole rewrite.
    requestFileTreeReveal(REVEAL_TAB_ID, {
      hostId: HOST_ID,
      workspacePath: WORKSPACE_PATH,
      filePath: "src/lib/a.ts",
    });
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [
          { path: "src/", name: "src", kind: "directory", ignored: false },
          {
            path: "readme.md",
            name: "readme.md",
            kind: "file",
            ignored: false,
          },
          { path: "notes.md", name: "notes.md", kind: "file", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });
    await waitFor(() => {
      expect(expandedInModel.has("src/")).toBe(true);
    });
    // The user's prior multi-selection, seeded directly in the model (a
    // click-driven selection would open previews of its own).
    selectedInModel.add("readme.md");
    selectedInModel.add("notes.md");

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "src/",
        entries: [
          { path: "src/lib/", name: "lib", kind: "directory", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });
    await waitFor(() => {
      expect(expandedInModel.has("src/lib/")).toBe(true);
    });
    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "src/lib/",
        entries: [
          { path: "src/lib/a.ts", name: "a.ts", kind: "file", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(scrollToPathCalls).toHaveLength(1);
    });
    expect([...selectedInModel]).toEqual(["src/lib/a.ts"]);
    expect(openPreviewSpy).not.toHaveBeenCalled();
  });

  it("does not re-fire a consumed request on a later listing", async () => {
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);
    await revealSrcLibAToCompletion(client);
    expect(scrollToPathCalls).toHaveLength(1);

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "src/lib/",
        entries: [
          { path: "src/lib/a.ts", name: "a.ts", kind: "file", ignored: false },
          { path: "src/lib/b.ts", name: "b.ts", kind: "file", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toContain("src/lib/b.ts");
    });
    expect(scrollToPathCalls).toHaveLength(1);
  });

  it("still opens the preview for a genuine user selection after a reveal completes", async () => {
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);
    await revealSrcLibAToCompletion(client);
    expect(openPreviewSpy).not.toHaveBeenCalled();

    act(() => {
      capturedOnSelectionChange?.(["readme.md"]);
    });

    expect(openPreviewSpy).toHaveBeenCalledTimes(1);
    expect(openPreviewSpy).toHaveBeenCalledWith(
      REVEAL_TAB_ID,
      expect.objectContaining({ filePath: "readme.md" }),
    );
  });

  it("ignores a reveal request for another workspace", async () => {
    requestFileTreeReveal(REVEAL_TAB_ID, {
      hostId: HOST_ID,
      workspacePath: "/other",
      filePath: "a.ts",
    });
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [{ path: "a.ts", name: "a.ts", kind: "file", ignored: false }],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(resetPathsCalls.at(-1)?.paths).toEqual(["a.ts"]);
    });

    expect(selectedInModel.size).toBe(0);
    expect(scrollToPathCalls).toEqual([]);
    expect(
      useFileTreeRevealStore.getState().requestsByViewTabId[REVEAL_TAB_ID],
    ).toEqual({
      hostId: HOST_ID,
      workspacePath: "/other",
      filePath: "a.ts",
      nonce: 1,
    });
  });

  it("clears an active filter before reveal, then completes once the file is listed", async () => {
    installSearchHost({ outcome: "root_unavailable" });
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);

    typeFilter("zzz");
    await waitFor(() => {
      expect(setSearchCalls.at(-1)).toBe("zzz");
    });

    act(() => {
      requestFileTreeReveal(REVEAL_TAB_ID, {
        hostId: HOST_ID,
        workspacePath: WORKSPACE_PATH,
        filePath: "a.ts",
      });
    });
    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [{ path: "a.ts", name: "a.ts", kind: "file", ignored: false }],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLInputElement>("Filter files by name").value,
      ).toBe("");
    });
    await waitFor(() => {
      expect(scrollToPathCalls).toEqual([
        { path: "a.ts", options: { offset: "nearest" } },
      ]);
    });
  });
});

/**
 * The same panel body under the phone tab switcher, where it is the File tree
 * category rather than a sidebar column. `useIsMobileViewport` reads
 * `window.innerWidth` directly, so overriding it before render is what forces
 * the touch presentation - same pattern as the composer-menu and providers
 * panel mobile suites.
 */
describe("file tree on a touch viewport", () => {
  const TAB_ID = "tab-1";
  const MOBILE_WIDTH = 390;
  const DESKTOP_WIDTH = 1024;

  // The shared setup's `matchMedia` never notifies, which is right for suites
  // that only need one width. Crossing the breakpoint mid-test needs a real
  // one: `useIsMobileViewport` is a `useSyncExternalStore` over this event, so
  // without it a width change reaches no render at all.
  const breakpointListeners = new Set<() => void>();
  function installLiveMatchMedia(): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: window.innerWidth < 768,
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => {
          breakpointListeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          breakpointListeners.delete(listener);
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
  function restoreInertMatchMedia(): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
  function setViewportWidth(width: number): void {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
    for (const listener of [...breakpointListeners]) listener();
  }

  let openPermanentSpy: Mock<
    (tabId: string, node: EpicCanvasTileRef) => NestedFocusTarget | null
  >;
  let openPreviewSpy: Mock<
    (tabId: string, node: EpicCanvasTileRef) => NestedFocusTarget | null
  >;

  beforeEach(() => {
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
    selectedInModel.clear();
    scrollToPathCalls.length = 0;
    modelListeners.clear();
    capturedOnSelectionChange = null;
    capturedItemHeight = undefined;
    capturedDensity = undefined;
    capturedUnsafeCSS = undefined;
    modelConstructionCount = 0;
    installSearchHost({});
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
    openPermanentSpy = vi.fn(() => null);
    openPreviewSpy = vi.fn(() => null);
    useEpicCanvasStore.setState({
      prepareOpenTileInTabFocusTarget: openPermanentSpy,
      prepareOpenTilePreviewInTabFocusTarget: openPreviewSpy,
    });
    breakpointListeners.clear();
    installLiveMatchMedia();
    setViewportWidth(MOBILE_WIDTH);
  });

  afterEach(() => {
    cleanup();
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    pinnedStreamBindingRef.value = null;
    breakpointListeners.clear();
    restoreInertMatchMedia();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: DESKTOP_WIDTH,
    });
  });

  /**
   * The phone shows the desktop's tree, pitch included. Touch used to inflate
   * rows to a 44px hit target because pierre's rows sit in a shadow root the
   * mobile hit-area stylesheet cannot reach; the compact pitch is deliberately
   * kept instead, so the two viewports render one geometry.
   *
   * Both options are asserted because either alone leaves the pitch forked:
   * `density` scales pierre's padding and radius, `itemHeight` overrides the
   * row box.
   */
  it("builds the phone tree with the desktop's row geometry", () => {
    renderPanel(new MockWsStreamClient("unknown"));

    expect(capturedItemHeight).toBeUndefined();
    expect(capturedDensity).toBe("compact");
  });

  it("gives Pierre a fractional-zoom tolerance for truncation measurement", () => {
    renderPanel(new MockWsStreamClient("unknown"));

    expect(capturedUnsafeCSS).toContain("height > calc(1lh + 1px)");
  });

  it("recycles the single preview tile for a tapped row rather than accumulating one per file", () => {
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);
    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [
          {
            path: "readme.md",
            name: "readme.md",
            kind: "file",
            ignored: false,
          },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    act(() => {
      capturedOnSelectionChange?.(["readme.md"]);
    });

    expect(openPermanentSpy).not.toHaveBeenCalled();
    expect(openPreviewSpy).toHaveBeenCalledTimes(1);
    expect(openPreviewSpy).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({ filePath: "readme.md" }),
    );
  });

  /**
   * The inverse of what this used to assert. The body was keyed on the
   * viewport class so it would REBUILD across the breakpoint, because pierre
   * bakes geometry at construction and a touch model differed from a pointer
   * one. With one geometry everywhere there is nothing to rebuild, and the
   * remount was not free - it drops the filter query.
   *
   * The construction count is what makes this discriminating: now that both
   * viewports report the same `itemHeight` and `density`, comparing geometry
   * across the crossing would pass whether the tree survived or was rebuilt.
   */
  it("keeps the same tree across a breakpoint crossing instead of rebuilding it", () => {
    setViewportWidth(DESKTOP_WIDTH);
    renderPanel(new MockWsStreamClient("unknown"));
    expect(modelConstructionCount).toBe(1);
    expect(capturedItemHeight).toBeUndefined();
    expect(capturedDensity).toBe("compact");

    act(() => {
      setViewportWidth(MOBILE_WIDTH);
    });

    expect(modelConstructionCount).toBe(1);
    expect(capturedItemHeight).toBeUndefined();
    expect(capturedDensity).toBe("compact");
  });
});
