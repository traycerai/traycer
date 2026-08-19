import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitChangedFileV11,
  GitListChangedFilesResponseV11,
  SubmoduleChangeset,
  SubmodulePointer,
  WorktreeBindingSelectorRowV12,
} from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@/lib/host";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  useWsStreamClient,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  defaultEpicState,
  useGitPanelStore,
  type GitPanelSelectedRepo,
} from "@/stores/epics/git-panel-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitDiffPanelBodyLive } from "../git-diff-panel-body-live";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { gitDiffPanelSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { expectModuleHeaderPreview } from "./git-module-header-test-utils";

const testState = vi.hoisted(() => ({
  rows: [] as WorktreeBindingSelectorRowV12[],
  snapshots: new Map<string, GitListChangedFilesResponseV11>(),
  capabilities: new Map<
    string,
    {
      readonly available: boolean;
      readonly gitVersion: string | null;
      readonly reason: string | null;
    }
  >(),
  availableCapability: {
    available: true,
    gitVersion: "2.45.0",
    reason: null,
  },
  prefetch: vi.fn(),
  refresh: vi.fn<() => Promise<void>>(),
}));

// The panel re-provides its own `StreamRuntimeContext` for the host its pin
// resolved to. `null` is that hook's FOLLOWING answer, so the panel falls back
// to the ambient binding this suite supplies - the client every OTHER
// assertion here is about. One arm below flips this to a pinned binding to
// prove the provider sits above the subscription.
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

/**
 * The transport `useGitListChangedFilesSubscription` was handed, recorded from
 * inside the mock.
 *
 * The real hook takes its client from `useWsStreamClient()` rather than from
 * its arguments, which is exactly why the wrong-host defect was invisible: the
 * pinned `hostId` it DOES take is a subscribe param, not a route, so a
 * subscribe carrying host B's name over host A's socket looks identical to a
 * correct one at every call site. Recording the context read here is what
 * makes the routing observable in a suite that otherwise mocks the hook out.
 */
const observedSubscriptionClients: Array<IHostStreamClient<HostStreamRpcRegistry> | null> =
  [];

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => ({
    data: { rows: testState.rows },
    error: null,
    isPending: false,
  }),
  useWorktreeListBindingsForEpicForClient: () => ({
    data: { rows: testState.rows },
    error: null,
    isPending: false,
  }),
}));

interface PinTestReachability {
  status: "reachable" | "unreachable" | "checking" | "host-starting";
  hostLabel: string;
  unavailability: "offline" | "plan-restricted" | null;
}

interface PinTestState {
  activeHostId: string | null;
  lastClientHostId: string | null;
  reachability: PinTestReachability;
  directory: Array<{ readonly hostId: string }>;
}

const pinTestState = vi.hoisted((): PinTestState => ({
  activeHostId: "host-1",
  lastClientHostId: null,
  reachability: {
    status: "reachable",
    hostLabel: "Host One",
    unavailability: null,
  },
  directory: [{ hostId: "host-1" }],
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => pinTestState.activeHostId,
}));

// The surface pin (`useSurfaceHostPin` -> `useEffectiveHostId`, redesign
// P1.2) resolves and latches against the effective host, not the directory's
// active-host hook - drive it off the same fixture state.
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => pinTestState.activeHostId,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => pinTestState.reachability,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: pinTestState.directory,
    fetchStatus: "idle",
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    pinTestState.lastClientHostId = hostId;
    return null;
  },
}));

vi.mock("@/hooks/git/use-git-prefetch-worktree-status", () => ({
  useGitPrefetchWorktreeStatus: () => testState.prefetch,
}));

vi.mock("@/hooks/git/use-git-capabilities-query", () => ({
  useGitCapabilitiesQuery: (args: { readonly runningDir: string | null }) => {
    const runningDir = args.runningDir ?? "";
    return {
      data:
        testState.capabilities.get(runningDir) ?? testState.availableCapability,
      error: null,
      isPending: false,
    };
  },
}));

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: (args: {
    readonly runningDir: string | null;
  }) => {
    observedSubscriptionClients.push(useWsStreamClient());
    const data =
      args.runningDir === null
        ? null
        : (testState.snapshots.get(args.runningDir) ?? null);
    return {
      data,
      error: null,
      isPending: data === null,
      repoState: data?.repoState ?? null,
      repoMode: data?.repoMode ?? null,
      pollStartedAtMs: 1_000,
      // Unreported watcher health - what a host below `subscribeStatus@1.3`
      // yields, and the state these switcher tests are indifferent to.
      watcherStatus: null,
    };
  },
}));

vi.mock("@/hooks/git/use-git-list-changed-files-with-submodules", () => ({
  useGitListChangedFilesWithSubmodules: (args: {
    readonly runningDir: string | null;
  }) => ({
    data:
      args.runningDir === null
        ? null
        : (testState.snapshots.get(args.runningDir) ?? null),
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/git/use-git-submodule-snapshot-refresh", () => ({
  useGitSubmoduleSnapshotRefresh: () => ({
    refresh: testState.refresh,
    isRefreshing: false,
  }),
}));

vi.mock("@/components/worktree/open-in-editor-button", () => ({
  OpenInEditorButton: (props: {
    readonly openTarget: {
      readonly workspacePath: string;
      readonly hostId: string;
    } | null;
  }) => (
    <button
      type="button"
      data-testid="mock-open-in-editor"
      data-workspace-path={props.openTarget?.workspacePath ?? ""}
      data-host-id={props.openTarget?.hostId ?? ""}
    >
      Open
    </button>
  ),
}));

vi.mock("@/components/worktree/worktree-picker-host-section", () => ({
  WorktreePickerHostSection: () => (
    <div data-testid="mock-worktree-picker-host-section" />
  ),
}));

vi.mock("../capability-gate", () => ({
  CapabilityGate: (props: { readonly children: ReactNode }) => (
    <>{props.children}</>
  ),
}));

vi.mock("../file-list", () => ({
  FileList: (props: {
    readonly runningDir: string;
    readonly files: ReadonlyArray<GitChangedFileV11>;
    readonly hideEmptySections: boolean;
  }) => (
    <div
      data-testid={`file-list-${props.runningDir}`}
      data-running-dir={props.runningDir}
      data-hide-empty-sections={props.hideEmptySections ? "true" : "false"}
    >
      {props.files.map((file) => (
        <span key={file.path}>{file.path}</span>
      ))}
    </div>
  ),
}));

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";

const normalPointer: SubmodulePointer = {
  kind: "normal",
  recordedPinSha: "1111111111",
  submoduleHeadSha: "2222222222",
  diverged: true,
  commitChanged: true,
  modifiedContent: true,
  untrackedContent: false,
};

const cleanPointer: SubmodulePointer = {
  ...normalPointer,
  recordedPinSha: "2222222222",
  diverged: false,
  commitChanged: false,
  modifiedContent: false,
  untrackedContent: false,
};

function row(
  overrides: Partial<WorktreeBindingSelectorRowV12>,
): WorktreeBindingSelectorRowV12 {
  return {
    hostId: "host-1",
    runningDir: "/repo",
    workspacePath: "/repo",
    worktreePath: null,
    mode: "local",
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "traycer-internal" },
    branch: "development",
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    isGitResolvePending: false,
    ...overrides,
  };
}

function file(
  path: string,
  gitlink: SubmodulePointer | null,
): GitChangedFileV11 {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    isBinary: false,
    insertions: 1,
    deletions: 0,
    sizeBytes: 10,
    stagedOid: null,
    worktreeOid: null,
    gitlink,
  };
}

function stagedFile(
  path: string,
  gitlink: SubmodulePointer | null,
): GitChangedFileV11 {
  return {
    ...file(path, gitlink),
    stage: "staged",
  };
}

function changeset(overrides: Partial<SubmoduleChangeset>): SubmoduleChangeset {
  return {
    repoRoot: "/repo/traycer",
    parentPath: "traycer",
    branch: "main",
    repoState: { kind: "clean" },
    files: [],
    pointer: normalPointer,
    availability: { state: "ok" },
    ...overrides,
  };
}

function response(
  overrides: Partial<GitListChangedFilesResponseV11>,
): GitListChangedFilesResponseV11 {
  return {
    runningDir: "/repo",
    headSha: "deadbeefcafe",
    branch: "development",
    files: [],
    fingerprint: "fp",
    repoMode: "normal",
    repoState: { kind: "clean" },
    submodules: [],
    ...overrides,
  };
}

const rootSelected: GitPanelSelectedRepo = {
  hostId: "host-1",
  rootRunningDir: "/repo",
  repoRoot: "/repo",
};

/** A real, never-dialed transport - identity is all these arms compare. */
function streamClientFixture(): WsStreamClient<HostStreamRpcRegistry> {
  return new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    endpoint: () => null,
    bearer: () => null,
    auth: null,
    hostCredentialMint: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: {
      create: () => {
        throw new Error("stream client fixture should not open a websocket");
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

function renderPanel(selected: GitPanelSelectedRepo): QueryClient {
  useGitPanelStore.setState({
    stateByEpicId: {
      [EPIC_ID]: {
        ...defaultEpicState,
        selectedRepo: selected,
      },
    },
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  testState.rows.forEach((binding) => {
    const snapshot =
      testState.snapshots.get(binding.runningDir) ??
      response({ runningDir: binding.runningDir });
    queryClient.setQueryData(
      gitQueryKeys.listChangedFiles(binding.hostId, binding.runningDir, false),
      snapshot,
    );
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <GitDiffPanelBodyLive epicId={EPIC_ID} tabId={TAB_ID} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function openSwitcher(): void {
  fireEvent.click(screen.getByTestId("git-diff-repo-switcher-trigger"));
}

describe("<GitDiffPanelBodyLive /> workspace switcher integration", () => {
  beforeEach(() => {
    cleanup();
    testState.prefetch.mockClear();
    testState.refresh.mockReset();
    testState.refresh.mockResolvedValue(undefined);
    testState.rows = [
      row({}),
      row({
        runningDir: "/other",
        workspacePath: "/other",
        repoIdentifier: { owner: "acme", repo: "other-repo" },
        branch: "main",
        isPrimary: false,
      }),
    ];
    testState.snapshots = new Map([
      ["/repo", response({})],
      [
        "/other",
        response({
          runningDir: "/other",
          branch: "main",
          files: [file("src/other.ts", null)],
        }),
      ],
    ]);
    testState.capabilities = new Map();
    window.localStorage.clear();
    useGitPanelStore.setState({ stateByEpicId: {} });
    useSurfaceHostSelectionStore.getState().resetForTests();
    useSelectionAuthorityStore.getState().reset();
    pinTestState.activeHostId = "host-1";
    pinTestState.lastClientHostId = null;
    pinTestState.reachability = {
      status: "reachable",
      hostLabel: "Host One",
      unavailability: null,
    };
    pinTestState.directory = [{ hostId: "host-1" }];
  });

  afterEach(() => {
    cleanup();
    useSelectionAuthorityStore.getState().reset();
    pinnedStreamBindingRef.value = null;
    observedSubscriptionClients.length = 0;
  });

  it("subscribes on the PINNED host's transport, not the app-wide one", () => {
    // Proves the re-provider sits ABOVE the subscription rather than beside
    // it. That adjacency is the whole fix and nothing else can see it: the
    // hook resolving the transport is correct either way, and the subscription
    // registry is correct either way - only their arrangement decides which
    // machine gets watched. `renderPanel` supplies no ambient binding, so a
    // panel that failed to re-provide would subscribe on `null`.
    const pinned = streamClientFixture();
    pinnedStreamBindingRef.value = {
      wsStreamClient: pinned,
      hostId: "host-1",
    };

    renderPanel(rootSelected);

    expect(observedSubscriptionClients.length).toBeGreaterThan(0);
    expect([...new Set(observedSubscriptionClients)]).toEqual([pinned]);
  });

  it("renders the compact selector and removes the persistent repo tree", () => {
    renderPanel(rootSelected);

    expect(screen.getByTestId("git-diff-repo-switcher-trigger")).toBeDefined();
    expect(screen.queryByTestId("git-repo-tree")).toBeNull();
    expect(
      screen
        .getByTestId("mock-open-in-editor")
        .getAttribute("data-workspace-path"),
    ).toBe("/repo");
  });

  it("splits the active workspace picker badges into module and file counts", () => {
    testState.snapshots.set(
      "/repo",
      response({
        files: [file("traycer", normalPointer)],
        submodules: [
          changeset({
            files: Array.from({ length: 133 }, (_value, index) =>
              file(`src/submodule-${index}.ts`, null),
            ),
          }),
        ],
      }),
    );

    renderPanel(rootSelected);

    const trigger = screen.getByTestId("git-diff-repo-switcher-trigger");
    expect(trigger.getAttribute("aria-label")).toContain("1 changed submodule");
    expect(trigger.getAttribute("aria-label")).toContain("133 changed files");
    expect(screen.getByLabelText("1 changed submodule")).toBeDefined();
    expect(screen.getByLabelText("133 changed files")).toBeDefined();
    expect(screen.queryByLabelText("1 changed")).toBeNull();
    expect(screen.queryByLabelText("134 changed files")).toBeNull();
  });

  it("deduplicates dual-stage gitlink rows in the module badge", () => {
    testState.snapshots.set(
      "/repo",
      response({
        files: [
          stagedFile("traycer", normalPointer),
          file("traycer", normalPointer),
        ],
        submodules: [changeset({ files: [] })],
      }),
    );

    renderPanel(rootSelected);

    const trigger = screen.getByTestId("git-diff-repo-switcher-trigger");
    expect(trigger.getAttribute("aria-label")).toContain("1 changed submodule");
    expect(screen.getByLabelText("1 changed submodule")).toBeDefined();
    expect(screen.queryByLabelText("2 changed submodules")).toBeNull();
    expect(screen.queryByLabelText("1 changed file")).toBeNull();
  });

  it("selecting a workspace row updates the selected workspace and opener target", () => {
    renderPanel(rootSelected);
    openSwitcher();

    fireEvent.click(
      screen.getByTestId("git-diff-repo-switcher-root-other-repo"),
    );

    expect(
      useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
    ).toEqual({
      hostId: "host-1",
      rootRunningDir: "/other",
      repoRoot: "/other",
    });
    expect(
      screen.getByTestId("file-list-/other").getAttribute("data-running-dir"),
    ).toBe("/other");
    expect(
      screen
        .getByTestId("mock-open-in-editor")
        .getAttribute("data-workspace-path"),
    ).toBe("/other");
  });

  it("omits nested submodule rows while submodule search keeps the parent workspace", () => {
    testState.snapshots.set(
      "/repo",
      response({
        submodules: [changeset({ files: [file("src/submodule.ts", null)] })],
      }),
    );
    renderPanel(rootSelected);
    openSwitcher();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search workspaces" }),
      { target: { value: "/repo/traycer" } },
    );

    expect(
      screen.getByTestId("git-diff-repo-switcher-root-traycer-internal"),
    ).toBeDefined();
    expect(
      screen.queryByTestId("git-diff-repo-switcher-submodule-traycer"),
    ).toBeNull();
    expect(
      useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
    ).toEqual(rootSelected);
    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
    expect(
      screen
        .getByTestId("mock-open-in-editor")
        .getAttribute("data-workspace-path"),
    ).toBe("/repo");
  });

  it("normalizes a persisted submodule selection back to the workspace root", async () => {
    testState.snapshots.set(
      "/repo",
      response({
        submodules: [changeset({ files: [] })],
      }),
    );

    renderPanel({
      hostId: "host-1",
      rootRunningDir: "/repo",
      repoRoot: "/repo/traycer",
    });

    expect(
      screen.getByTestId("git-diff-repo-switcher-trigger").textContent,
    ).toContain("traycer-internal");
    expect(
      screen
        .getByTestId("mock-open-in-editor")
        .getAttribute("data-workspace-path"),
    ).toBe("/repo");
    await waitFor(() =>
      expect(
        useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
      ).toEqual(rootSelected),
    );
    expect(screen.getByTestId("git-module-group-root")).toBeDefined();
    expect(screen.getByTestId("git-module-no-changes-root")).toBeDefined();
  });

  it("renders a parent-reference-only submodule as a module group", async () => {
    testState.snapshots.set(
      "/repo",
      response({
        files: [file("traycer", normalPointer)],
        submodules: [changeset({ files: [] })],
      }),
    );

    renderPanel(rootSelected);

    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
    await expectModuleHeaderPreview(
      screen.getByTestId("git-module-header-traycer"),
      "pinned commit out of date",
    );
    expect(screen.queryByText("pinned commit out of date")).toBeNull();
    expect(screen.getByTestId("git-module-no-changes-traycer")).toBeDefined();
    expect(
      screen
        .getByTestId("git-diff-repo-switcher-trigger")
        .getAttribute("aria-label"),
    ).toContain("1 changed submodule");
    expect(screen.getByLabelText("1 changed submodule")).toBeDefined();
    expect(screen.queryByLabelText("1 changed file")).toBeNull();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
  });

  it("renders the panel empty state when all modules are clean", () => {
    testState.snapshots.set(
      "/repo",
      response({
        submodules: [changeset({ pointer: cleanPointer })],
      }),
    );

    renderPanel(rootSelected);

    expect(screen.getByTestId("git-diff-empty-refresh")).toBeDefined();
    expect(screen.queryByTestId("git-module-no-changes-root")).toBeNull();
    expect(screen.queryByTestId("git-clean-modules-affordance")).toBeNull();
    expect(
      screen.queryByTestId("git-module-group-submodule-traycer"),
    ).toBeNull();
    expect(screen.queryByLabelText("1 changed submodule")).toBeNull();
  });

  it("surfaces old-host submodule-detail degradation in the integrated panel", () => {
    testState.snapshots.set(
      "/repo",
      response({
        files: [file("traycer", normalPointer)],
        submodules: [],
      }),
    );

    renderPanel(rootSelected);

    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
    expect(screen.getByTestId("git-submodule-unavailable")).toBeDefined();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
  });

  it("keeps unavailable submodule state on the parent workspace view", async () => {
    testState.snapshots.set(
      "/repo",
      response({
        files: [file("traycer", normalPointer)],
        submodules: [
          changeset({
            availability: { state: "unavailable", reason: "git-error" },
          }),
        ],
      }),
    );

    renderPanel({
      hostId: "host-1",
      rootRunningDir: "/repo",
      repoRoot: "/repo/traycer",
    });

    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
    expect(screen.getByTestId("git-submodule-unavailable")).toBeDefined();
    expect(
      screen
        .getByTestId("git-diff-repo-switcher-trigger")
        .getAttribute("data-unavailable"),
    ).toBeNull();
    expect(
      screen
        .getByTestId("git-diff-repo-switcher-trigger")
        .getAttribute("aria-invalid"),
    ).toBeNull();
    await waitFor(() =>
      expect(
        useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
      ).toEqual(rootSelected),
    );
  });

  it("does not let module headers change the selected workspace", () => {
    testState.snapshots.set(
      "/repo",
      response({
        files: [file("traycer", normalPointer)],
        submodules: [changeset({ files: [file("src/submodule.ts", null)] })],
      }),
    );
    renderPanel(rootSelected);

    fireEvent.click(screen.getByTestId("git-module-header-traycer"));

    expect(
      useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
    ).toEqual(rootSelected);
    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
  });

  it("falls back to the best available root when the selected root disappears", async () => {
    testState.rows = [
      row({
        runningDir: "/other",
        workspacePath: "/other",
        repoIdentifier: { owner: "acme", repo: "other-repo" },
        branch: "main",
        isPrimary: false,
      }),
    ];
    testState.snapshots = new Map([
      [
        "/other",
        response({
          runningDir: "/other",
          branch: "main",
          files: [file("src/other.ts", null)],
        }),
      ],
    ]);

    renderPanel(rootSelected);

    await waitFor(() =>
      expect(
        useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
      ).toEqual({
        hostId: "host-1",
        rootRunningDir: "/other",
        repoRoot: "/other",
      }),
    );
    expect(
      screen.getByTestId("file-list-/other").getAttribute("data-running-dir"),
    ).toBe("/other");
  });

  it("falls back when the selected root becomes unavailable", async () => {
    testState.capabilities.set("/repo", {
      available: false,
      gitVersion: null,
      reason: "git unavailable",
    });

    renderPanel(rootSelected);

    await waitFor(() =>
      expect(
        useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
      ).toEqual({
        hostId: "host-1",
        rootRunningDir: "/other",
        repoRoot: "/other",
      }),
    );
    expect(
      screen.getByTestId("file-list-/other").getAttribute("data-running-dir"),
    ).toBe("/other");
  });

  it("renders the degraded state when the only Git root becomes unavailable", async () => {
    testState.rows = [row({})];
    testState.snapshots = new Map([["/repo", response({})]]);
    testState.capabilities.set("/repo", {
      available: false,
      gitVersion: null,
      reason: "git unavailable",
    });

    renderPanel(rootSelected);

    await waitFor(() =>
      expect(
        useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
      ).toBeNull(),
    );
    // A broken worktree is a degrade, not "no workspaces" - the panel must not
    // reuse the empty "add workspaces" nudge, and must not hang on the skeleton.
    expect(screen.getByTestId("git-roots-unavailable")).toBeDefined();
    expect(screen.queryByText("No git workspaces available")).toBeNull();
    expect(screen.queryByTestId("diff-loading-skeleton")).toBeNull();
    expect(screen.queryByTestId("git-diff-repo-switcher-trigger")).toBeNull();
    expect(screen.queryByText("No changes")).toBeNull();
  });

  it("renders the degraded empty state when EVERY Git root probes unavailable", async () => {
    testState.capabilities.set("/repo", {
      available: false,
      gitVersion: null,
      reason: "git unavailable",
    });
    testState.capabilities.set("/other", {
      available: false,
      gitVersion: null,
      reason: "git unavailable",
    });

    renderPanel(rootSelected);

    await waitFor(() =>
      expect(
        useGitPanelStore.getState().stateByEpicId[EPIC_ID].selectedRepo,
      ).toBeNull(),
    );
    // Degraded, never an indefinite skeleton: with zero available roots the
    // default-pick settles to null and the panel must surface an explicit state.
    expect(screen.getByTestId("git-roots-unavailable")).toBeDefined();
    expect(screen.queryByTestId("diff-loading-skeleton")).toBeNull();
    expect(screen.queryByTestId("git-diff-repo-switcher-trigger")).toBeNull();
  });

  it("recovers via retry once a previously unavailable root is readable again", async () => {
    testState.rows = [row({})];
    testState.snapshots = new Map([["/repo", response({})]]);
    testState.capabilities.set("/repo", {
      available: false,
      gitVersion: null,
      reason: "git unavailable",
    });

    renderPanel(rootSelected);

    await waitFor(() =>
      expect(screen.getByTestId("git-roots-unavailable")).toBeDefined(),
    );

    // The worktree is restored; retry clears the probed-unavailable set so the
    // root is re-picked, re-probed against the fresh capability, and loads.
    testState.capabilities.set("/repo", testState.availableCapability);
    fireEvent.click(screen.getByTestId("git-roots-unavailable-retry"));

    await waitFor(() =>
      expect(
        screen.getByTestId("git-diff-repo-switcher-trigger"),
      ).toBeDefined(),
    );
    expect(screen.queryByTestId("git-roots-unavailable")).toBeNull();
  });

  it("retry invalidates host-scoped git capability queries", async () => {
    testState.rows = [row({})];
    testState.snapshots = new Map([["/repo", response({})]]);
    testState.capabilities.set("/repo", {
      available: false,
      gitVersion: null,
      reason: "git unavailable",
    });

    const queryClient = renderPanel(rootSelected);

    await waitFor(() =>
      expect(screen.getByTestId("git-roots-unavailable")).toBeDefined(),
    );

    const capabilityKey = hostQueryKeys.method<
      HostRpcRegistry,
      "git.getCapabilities"
    >("host-1", "git.getCapabilities", {
      hostId: "host-1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    queryClient.setQueryData(capabilityKey, {
      available: false,
      gitVersion: null,
      reason: "git unavailable",
    });
    const fileDiffKey = gitQueryKeys.fileDiff(
      "host-1",
      "/repo",
      "src/app.ts",
      null,
      "unstaged",
      "HEAD123",
      null,
      "abc123",
      false,
      null,
    );
    queryClient.setQueryData(fileDiffKey, { diff: "cached" });

    testState.capabilities.set("/repo", testState.availableCapability);
    fireEvent.click(screen.getByTestId("git-roots-unavailable-retry"));

    await waitFor(() =>
      expect(queryClient.getQueryState(capabilityKey)?.isInvalidated).toBe(
        true,
      ),
    );
    expect(queryClient.getQueryState(fileDiffKey)?.isInvalidated).toBe(false);
  });

  it("renders the no-changes state after the selector with no leftover tree row", () => {
    renderPanel(rootSelected);

    const trigger = screen.getByTestId("git-diff-repo-switcher-trigger");
    const noChanges = screen.getByText("No changes");
    expect(screen.queryByTestId("git-repo-tree")).toBeNull();
    expect(screen.getByTestId("git-diff-empty-refresh")).toBeDefined();
    expect(screen.queryByTestId("git-module-no-changes-root")).toBeNull();
    expect(
      Boolean(
        trigger.compareDocumentPosition(noChanges) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  // Rows the host marks `isGitResolvePending` (its cold view still resolving)
  // are pending, not dead: the panel keeps its loading skeleton - the host
  // sweep's `worktree.changed` push settles it - instead of the "No git
  // workspaces available" dead end.
  it("keeps the loading skeleton while every row's git facts are unverified", () => {
    testState.rows = [
      row({
        runningDir: "/wt/cold",
        workspacePath: "/repo",
        worktreePath: "/wt/cold",
        mode: "worktree",
        isGitRepo: false,
        disabledReason: "missing_worktree_path",
        isGitResolvePending: true,
      }),
    ];
    renderPanel(rootSelected);

    expect(screen.getByTestId("diff-loading-skeleton")).toBeDefined();
    expect(screen.queryByText("No git workspaces available")).toBeNull();
  });

  it("keeps the dead empty state when every non-git row is a resolved fact", () => {
    testState.rows = [
      row({
        isGitRepo: false,
        repoIdentifier: null,
        branch: null,
        isGitResolvePending: false,
      }),
    ];
    renderPanel(rootSelected);

    expect(screen.getByText("No git workspaces available")).toBeDefined();
    expect(screen.queryByTestId("diff-loading-skeleton")).toBeNull();
  });

  it("renders an unverified row as a muted checking badge in the switcher", () => {
    testState.rows = [
      row({}),
      row({
        runningDir: "/cold",
        workspacePath: "/cold",
        repoIdentifier: null,
        branch: null,
        isGitRepo: false,
        isPrimary: false,
        isGitResolvePending: true,
      }),
      row({
        runningDir: "/notes",
        workspacePath: "/notes",
        repoIdentifier: null,
        branch: null,
        isGitRepo: false,
        isPrimary: false,
        isGitResolvePending: false,
      }),
    ];
    renderPanel(rootSelected);
    openSwitcher();

    const pendingOption = screen.getByTestId(
      "git-diff-repo-switcher-root-cold",
    );
    expect(within(pendingOption).getByText("checking")).toBeDefined();
    expect(pendingOption.getAttribute("aria-disabled")).toBe("true");
    const resolvedOption = screen.getByTestId(
      "git-diff-repo-switcher-root-notes",
    );
    expect(within(resolvedOption).getByText("not git")).toBeDefined();
  });

  it("latches the resolved host when the default root is already selected", () => {
    renderPanel(rootSelected);

    expect(
      useSurfaceHostSelectionStore.getState().selections[
        gitDiffPanelSurfaceKey(TAB_ID)
      ],
    ).toBe("host-1");
    expect(pinTestState.lastClientHostId).toBe("host-1");
  });

  it("writes the pin when a repo is picked in the switcher", () => {
    renderPanel(rootSelected);
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(gitDiffPanelSurfaceKey(TAB_ID), null);

    openSwitcher();
    fireEvent.click(
      screen.getByTestId("git-diff-repo-switcher-root-other-repo"),
    );

    expect(
      useSurfaceHostSelectionStore.getState().selections[
        gitDiffPanelSurfaceKey(TAB_ID)
      ],
    ).toBe("host-1");
  });

  it("auto-follows to the effective host and renders normal content when the pinned host is dead (D6 sticky return, no dead-state screen)", async () => {
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(gitDiffPanelSurfaceKey(TAB_ID), "host-1");
    // host-1 (the pin) is dead; host-2 is the effective host and can serve.
    pinTestState.activeHostId = "host-2";
    testState.rows = [row({ hostId: "host-2" })];
    testState.snapshots = new Map([["/repo", response({})]]);
    useSelectionAuthorityStore.setState({
      attached: true,
      effectiveHostId: "host-2",
      leases: [
        { hostId: "host-1", status: "dead", dead: { reason: "offline" } },
        { hostId: "host-2", status: "ready", dead: null },
      ],
    });

    renderPanel(rootSelected);

    // The pin is deposed, so the surface resolves to the effective host and the
    // requester it asks for is host-2, never the dead host-1 - there is no
    // separate dead-state screen to fall back to (D6 deleted it).
    await waitFor(() => {
      expect(pinTestState.lastClientHostId).toBe("host-2");
    });
    expect(screen.queryByTestId("git-diff-panel-pinned-host-dead")).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByTestId("git-diff-repo-switcher-trigger"),
      ).toBeDefined();
    });
    // The pin ITSELF survives the death - only the resolution moved. This is
    // what makes the return sticky once host-1 is usable again.
    expect(
      useSurfaceHostSelectionStore.getState().selections[
        gitDiffPanelSurfaceKey(TAB_ID)
      ],
    ).toBe("host-1");
  });
});
