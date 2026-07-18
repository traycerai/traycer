import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitChangedFileV11,
  GitListChangedFilesResponseV11,
  SubmoduleChangeset,
  SubmodulePointer,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@/lib/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  defaultEpicState,
  useGitPanelStore,
  type GitPanelSelectedRepo,
} from "@/stores/epics/git-panel-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitDiffPanelBodyLive } from "../git-diff-panel-body-live";
import { expectModuleHeaderPreview } from "./git-module-header-test-utils";

const testState = vi.hoisted(() => ({
  rows: [] as WorktreeBindingSelectorRow[],
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

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => ({
    data: { rows: testState.rows },
    error: null,
    isPending: false,
  }),
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
  useGitSubmoduleSnapshotRefresh: () => testState.refresh,
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
  overrides: Partial<WorktreeBindingSelectorRow>,
): WorktreeBindingSelectorRow {
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
  });

  afterEach(() => {
    cleanup();
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
});
