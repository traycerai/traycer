import type {
  ProviderMcpCapabilities,
  ProviderMcpServer,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderMcpTab } from "@/components/settings/panels/provider-mcp-tab";
import { useMcpPendingAuthStore } from "@/stores/settings/mcp-pending-auth-store";
import { useProvidersWorkspaceSelectionStore } from "@/stores/settings/providers-workspace-selection-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

/**
 * Mirrors what `useProvidersMcpList` really returns — in particular `data` is
 * genuinely `undefined` before the first response, and returns there whenever a
 * scope/workspace switch swaps the query key. Inferring the shape from a loaded
 * literal instead made that window unrepresentable, which is how a bug living
 * entirely inside it stayed invisible to this suite.
 *
 * Declared as a return type rather than an `as` on the literal so `lint --fix`
 * cannot quietly narrow it back.
 */
function emptyListQueryMock(): {
  data: { servers: ProviderMcpServer[] } | undefined;
  isPending: boolean;
  isError: boolean;
  error: { message: string } | null;
  isFetching: boolean;
} {
  return {
    data: { servers: [] },
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
  };
}

const mcpMocks = vi.hoisted(() => ({
  listResult: emptyListQueryMock(),
  projectListResult: emptyListQueryMock(),
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  mutateIsPending: false,
  discoverMutate: vi.fn(),
  authMutate: vi.fn(),
  openExternalLink: vi.fn(),
  listCalls: [] as Array<{
    providerId: string;
    scope: string;
    workspaceRoot: string | null;
    enabled: boolean;
    pollWhilePending: boolean;
  }>,
}));

const worktreeMocks = vi.hoisted(() => ({
  workspaces: [] as Array<{
    workspacePath: string;
    isGitRepo: boolean;
    repoIdentifier: null;
    mainBranch: string | null;
    worktrees: Array<{
      worktreePath: string;
      branch: string | null;
      head: string | null;
      isMain: boolean;
      isLocked: boolean;
    }>;
    scripts: null;
  }>,
  // TWO independent flags, mirroring the two the real query exposes, rather
  // than one tri-state: `data` is undefined until a fetch SUCCEEDS - while
  // pending and after a failure alike - and `isPending` is what separates
  // those. Keeping them separate is what lets a case say "not loaded, NOT
  // pending", which is the failed lookup, and the one a pending-based gate
  // waves through. A mock that always handed back a `data` object could not
  // fail either way.
  loaded: true,
  pending: false,
}));

const resolvedWorkspaceMocks = vi.hoisted(() => ({
  folders: [] as Array<{
    kind: "resolved" | "local-only" | "unresolved";
    path: string;
    name: string;
  }>,
  isLoading: false,
  isFetching: false,
}));

const folderActionMocks = vi.hoisted(() => ({
  pickAndPrepareFolders: vi.fn(),
  isPreparing: false,
}));

// A rejected browse has no inline surface to land on - the popover is the only
// thing on screen - so the failure is reported as a toast. Captured here
// because the real helper reaches a sonner instance this suite does not mount.
const toastMocks = vi.hoisted(() => ({ errors: [] as string[] }));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: (message: string) => {
    toastMocks.errors.push(message);
    return 0;
  },
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => "host-1",
  }),
  useHostBinding: () => ({
    hostClient: {
      getActiveHostId: () => "host-1",
    },
  }),
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({
    folders: resolvedWorkspaceMocks.folders,
    isLoading: resolvedWorkspaceMocks.isLoading,
    isFetching: resolvedWorkspaceMocks.isFetching,
  }),
}));

// The picker can now ADD a workspace, which is what makes an empty list
// recoverable. The real hook reaches a runner host and two host mutations; only
// the pick-and-prepare seam matters here, so the rest stays mocked like every
// other host call in this file. `preparedWorkspaceFolderToWorkspaceFolderInfo`
// is re-implemented rather than re-exported so the mock cannot drift into
// depending on the module it replaces.
vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActionsForClient: () => ({
    isPreparing: folderActionMocks.isPreparing,
    isRemoving: false,
    prepareFoldersMutation: null,
    removeEpicRepoMutation: null,
    pickAndPrepareFolders: folderActionMocks.pickAndPrepareFolders,
  }),
  preparedWorkspaceFolderToWorkspaceFolderInfo: (
    folder: { workspacePath: string; workspaceName: string },
    hostId: string | null,
  ) => ({
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: null,
    hostId,
  }),
}));

// The scope picker lists a repo's worktrees as first-class destinations, so
// this suite has to be able to say what the host reports for them. Mocked (like
// every other host read here) rather than wrapped in a QueryClientProvider,
// which is the convention the rest of this file already follows.
vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: worktreeMocks.loaded
      ? { workspaces: worktreeMocks.workspaces }
      : undefined,
    isPending: worktreeMocks.pending,
  }),
}));

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({
    mutate: mcpMocks.openExternalLink,
  }),
}));

vi.mock("@/hooks/providers/use-providers-mcp-list-query", () => ({
  useProvidersMcpList: (args: {
    providerId: string;
    scope: string;
    workspaceRoot: string | null;
    enabled: boolean;
    pollWhilePending: boolean;
  }) => {
    mcpMocks.listCalls.push(args);
    if (!args.enabled) {
      return {
        data: undefined,
        isPending: false,
        isError: false,
        error: null,
        isFetching: false,
      };
    }
    // Primary or shadow project-scope reads share projectListResult.
    if (args.scope === "project") {
      return mcpMocks.projectListResult;
    }
    return mcpMocks.listResult;
  },
}));

vi.mock("@/hooks/providers/use-providers-mcp-mutate-mutation", () => ({
  useProvidersMcpMutate: () => ({
    mutate: mcpMocks.mutate,
    mutateAsync: mcpMocks.mutateAsync,
    isPending: mcpMocks.mutateIsPending,
  }),
}));

vi.mock("@/hooks/providers/use-providers-mcp-discover-mutation", () => ({
  useProvidersMcpDiscover: () => ({
    mutate: mcpMocks.discoverMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-mcp-auth-mutation", () => ({
  useProvidersMcpAuth: () => ({
    mutate: mcpMocks.authMutate,
    isPending: false,
  }),
}));

const BOTH_SCOPES = ["global", "project"] as const;
const GLOBAL_ONLY = ["global"] as const;
const PROJECT_ONLY = ["project"] as const;

const FULL_CAPS: ProviderMcpCapabilities = {
  transports: ["stdio", "http"],
  authTypes: ["none", "header", "oauth"],
  authActions: ["login", "logout"],
  actionScopes: {
    list: [...BOTH_SCOPES],
    add: [...BOTH_SCOPES],
    update: [...BOTH_SCOPES],
    remove: [...BOTH_SCOPES],
    toggleServer: [...BOTH_SCOPES],
    toggleTool: [...BOTH_SCOPES],
    discover: [...BOTH_SCOPES],
    auth: [...BOTH_SCOPES],
  },
  addServer: "cli",
  removeServer: "cli",
  updateServer: "patch",
  perToolBacking: "native",
  statusSource: "probe",
  toolsSource: "probe",
  schemasSource: "probe",
  instructionsSource: "probe",
  traycerSessionsOnlyEnforcement: false,
  stdioDegradeNotice: false,
  oauthDegradesToConfigOnly: true,
};

const CURSOR_CAPS: ProviderMcpCapabilities = {
  ...FULL_CAPS,
  perToolBacking: "degraded-server-level",
  actionScopes: {
    ...FULL_CAPS.actionScopes,
    toggleTool: [],
  },
  authActions: ["login"],
  instructionsSource: "none",
};

const KIMI_CAPS: ProviderMcpCapabilities = {
  ...FULL_CAPS,
  actionScopes: {
    list: [...GLOBAL_ONLY],
    add: [...GLOBAL_ONLY],
    update: [...GLOBAL_ONLY],
    remove: [...GLOBAL_ONLY],
    toggleServer: [...GLOBAL_ONLY],
    toggleTool: [...GLOBAL_ONLY],
    discover: [...GLOBAL_ONLY],
    auth: [...GLOBAL_ONLY],
  },
};

/**
 * A provider that can ONLY list project-scoped configs - no Global to fall
 * back to. Codex-like providers all advertise both, which is why this case
 * went unnoticed: it is the one shape where the picker is the sole route to a
 * usable state, so it is also the one where disabling the picker is fatal.
 */
const PROJECT_ONLY_CAPS: ProviderMcpCapabilities = {
  ...FULL_CAPS,
  actionScopes: {
    list: [...PROJECT_ONLY],
    add: [...PROJECT_ONLY],
    update: [...PROJECT_ONLY],
    remove: [...PROJECT_ONLY],
    toggleServer: [...PROJECT_ONLY],
    toggleTool: [...PROJECT_ONLY],
    discover: [...PROJECT_ONLY],
    auth: [...PROJECT_ONLY],
  },
};

function connectedServer(
  overrides: Partial<ProviderMcpServer>,
): ProviderMcpServer {
  return {
    name: "context7",
    enabled: true,
    transport: {
      type: "http",
      url: "https://mcp.context7.com",
      auth: null,
    },
    status: "connected",
    statusSource: "probe",
    statusDetail: null,
    tools: [
      {
        name: "search_docs",
        description: "Search documentation",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
        enabled: true,
        readOnly: false,
      },
      {
        name: "list_projects",
        description: null,
        inputSchema: null,
        enabled: false,
        readOnly: false,
      },
    ],
    discoveryPending: false,
    instructions: "Use these tools carefully.",
    configOnly: false,
    stdioDegraded: false,
    ...overrides,
  };
}

function renderTabWithCliBinary(
  caps: ProviderMcpCapabilities,
  providerId: "codex" | "cursor" | "kimi",
  cliBinaryResolved: boolean,
) {
  return render(
    <ProviderMcpTab
      providerId={providerId}
      capabilities={caps}
      providerLabel={providerId}
      cliBinaryResolved={cliBinaryResolved}
    />,
  );
}

/**
 * The ordinary case: the host resolved a CLI binary, so nothing is gated away
 * and the tab renders its full affordances. Cases about the binary-absent gate
 * call {@link renderTabWithCliBinary} directly.
 */
function renderTab(
  caps: ProviderMcpCapabilities,
  providerId: "codex" | "cursor" | "kimi",
) {
  return renderTabWithCliBinary(caps, providerId, true);
}

/**
 * The scope control is ONE picker over Global plus every workspace/worktree,
 * not a chip pair beside a separate folder select - so a test drives it by
 * naming the destination it wants, exactly as a user does.
 */
/**
 * Matched by PREFIX, not exact string: the trigger's accessible name carries
 * the current destination after the static label ("MCP config location:
 * Global"), so a screen-reader user hears which config the control points at.
 * An exact match would break every time the selection changes.
 */
function scopeTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /^MCP config location/ });
}

function scopeTriggerText(): string {
  return scopeTrigger().textContent;
}

function openScopePicker(): void {
  fireEvent.click(scopeTrigger());
}

function chooseScopeOption(name: RegExp): void {
  openScopePicker();
  fireEvent.click(screen.getByRole("option", { name }));
}

describe("<ProviderMcpTab />", () => {
  beforeEach(() => {
    // Same factory as the initial value, so a reset can never re-narrow what
    // the mock is able to represent.
    mcpMocks.listResult = emptyListQueryMock();
    mcpMocks.projectListResult = emptyListQueryMock();
    mcpMocks.mutate.mockReset();
    mcpMocks.mutateAsync.mockReset();
    mcpMocks.discoverMutate.mockReset();
    mcpMocks.authMutate.mockReset();
    mcpMocks.openExternalLink.mockReset();
    mcpMocks.mutateIsPending = false;
    mcpMocks.listCalls = [];
    worktreeMocks.workspaces = [];
    worktreeMocks.loaded = true;
    worktreeMocks.pending = false;
    toastMocks.errors = [];
    folderActionMocks.pickAndPrepareFolders.mockReset();
    folderActionMocks.pickAndPrepareFolders.mockResolvedValue(null);
    folderActionMocks.isPreparing = false;
    useWorkspaceFoldersStore.setState({
      folders: ["/Users/dev/app"],
      folderInfoByPath: {
        "/Users/dev/app": {
          path: "/Users/dev/app",
          name: "app",
          repoIdentifier: null,
          hostId: "host-1",
        },
      },
    });
    resolvedWorkspaceMocks.folders = [
      { kind: "local-only", path: "/Users/dev/app", name: "app" },
    ];
    resolvedWorkspaceMocks.isLoading = false;
    resolvedWorkspaceMocks.isFetching = false;
    useProvidersWorkspaceSelectionStore.setState({
      selectedByHostId: {},
    });
    useMcpPendingAuthStore.setState({ entries: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it("lists servers with probe connectivity label and tool count", () => {
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    renderTab(FULL_CAPS, "codex");

    expect(screen.getByText("context7")).toBeDefined();
    expect(screen.getByText("connectivity check")).toBeDefined();
    expect(screen.getByText("2 tools")).toBeDefined();
    expect(screen.getByText("Reachable")).toBeDefined();
  });

  it("switches Global | Project scope and stamps workspaceRoot", () => {
    renderTab(FULL_CAPS, "codex");

    const globalCall = mcpMocks.listCalls.find(
      (c) => c.scope === "global" && c.enabled,
    );
    expect(globalCall?.workspaceRoot).toBeNull();

    chooseScopeOption(/app/);
    const projectCall = mcpMocks.listCalls.find(
      (c) =>
        c.scope === "project" &&
        c.enabled &&
        c.workspaceRoot === "/Users/dev/app",
    );
    expect(projectCall).toBeDefined();
    // The trigger NAMES the destination once chosen - the whole point of
    // folding the scope chips and the folder select into one control.
    expect(scopeTriggerText()).toContain("app");

    // And it still opens. Only the project trigger is wrapped in a
    // `TooltipWrapper` (Global's path tooltip would just repeat its inline
    // subtitle), so this is the composition the Global-scope cases never
    // exercise: Radix's tooltip trigger cloning onto the popover trigger.
    openScopePicker();
    expect(screen.getByRole("option", { name: /Global/ })).toBeDefined();
  });

  it("names the destination in the trigger before anything is chosen", () => {
    renderTab(FULL_CAPS, "codex");

    // Global is a destination too, and used to be the one state that named
    // nothing at all.
    expect(scopeTriggerText()).toContain("Global");
    expect(scopeTriggerText()).toContain("Every workspace on this host");
  });

  it("offers each worktree of a workspace as its own destination", () => {
    worktreeMocks.workspaces = [
      {
        workspacePath: "/Users/dev/app",
        isGitRepo: true,
        repoIdentifier: null,
        mainBranch: "main",
        worktrees: [
          {
            worktreePath: "/Users/dev/app",
            branch: "main",
            head: null,
            isMain: true,
            isLocked: false,
          },
          {
            worktreePath: "/Users/dev/worktrees/app-feature",
            branch: "traycer/feature",
            head: null,
            isMain: false,
            isLocked: false,
          },
        ],
        scripts: null,
      },
    ];
    renderTab(FULL_CAPS, "codex");

    openScopePicker();
    // Emission ORDER is the grouping, and it is the reason the list ships with
    // no group headers: a workspace is immediately followed by its own
    // worktrees, which is the only thing saying which repo a worktree belongs
    // to. Reordering the `targets` loop would otherwise pass every other
    // assertion here while making two repos' worktrees indistinguishable.
    const optionNames = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    const appIndex = optionNames.findIndex((name) => name.includes("app"));
    const featureIndex = optionNames.findIndex((name) =>
      name.includes("app-feature"),
    );
    expect(appIndex).toBeGreaterThanOrEqual(0);
    expect(featureIndex).toBe(appIndex + 1);

    // The branch is what distinguishes two near-identical basenames, so it has
    // to be on the row - not only in the path.
    const row = screen.getByRole("option", { name: /traycer\/feature/ });
    fireEvent.click(row);

    const projectCall = mcpMocks.listCalls.find(
      (c) =>
        c.scope === "project" &&
        c.enabled &&
        c.workspaceRoot === "/Users/dev/worktrees/app-feature",
    );
    expect(projectCall).toBeDefined();
    expect(scopeTriggerText()).toContain("app-feature");
  });

  it("shows multi-workspace picker and selects second folder", () => {
    useWorkspaceFoldersStore.setState({
      folders: ["/Users/dev/app", "/Users/dev/other"],
      folderInfoByPath: {
        "/Users/dev/app": {
          path: "/Users/dev/app",
          name: "app",
          repoIdentifier: null,
          hostId: "host-1",
        },
        "/Users/dev/other": {
          path: "/Users/dev/other",
          name: "other",
          repoIdentifier: null,
          hostId: "host-1",
        },
      },
    });
    resolvedWorkspaceMocks.folders = [
      { kind: "local-only", path: "/Users/dev/app", name: "app" },
      { kind: "local-only", path: "/Users/dev/other", name: "other" },
    ];
    useProvidersWorkspaceSelectionStore.setState({
      selectedByHostId: { "host-1": "/Users/dev/app" },
    });
    renderTab(FULL_CAPS, "codex");

    chooseScopeOption(/other/);

    const projectCall = mcpMocks.listCalls.find(
      (c) =>
        c.scope === "project" &&
        c.enabled &&
        c.workspaceRoot === "/Users/dev/other",
    );
    expect(projectCall).toBeDefined();
  });

  it("offers no project destination when this host has zero workspaces", () => {
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
    });
    resolvedWorkspaceMocks.folders = [];
    renderTab(FULL_CAPS, "codex");

    // The picker stays reachable because Global still is; there is simply
    // nothing under it to point a project config at.
    openScopePicker();
    expect(screen.getByRole("option", { name: /Global/ })).toBeDefined();
    expect(screen.queryByText("This host's workspaces")).toBeNull();
    // ...and it SAYS so, rather than silently omitting the group and leaving
    // "Global is the only thing here" looking like the provider's own limit.
    expect(
      screen.getByText("No workspaces added on this host yet."),
    ).toBeDefined();
    // `enabled` matters: the shadow-badge read is MOUNTED in Global scope and
    // only gated off by that flag, so it lands in `listCalls` either way.
    expect(
      mcpMocks.listCalls.some((c) => c.scope === "project" && c.enabled),
    ).toBe(false);
  });

  it("adds a workspace from the picker and selects it, with zero workspaces to start", async () => {
    useWorkspaceFoldersStore.setState({ folders: [], folderInfoByPath: {} });
    resolvedWorkspaceMocks.folders = [];
    folderActionMocks.pickAndPrepareFolders.mockResolvedValue({
      folders: [
        { workspacePath: "/Users/dev/picked", workspaceName: "picked" },
      ],
      repoIdentifiers: [],
      hostId: "host-1",
    });
    renderTab(FULL_CAPS, "codex");

    // The state the old control had no answer for: no folders opened on this
    // host, so Global was the only reachable destination and a project config
    // could not be managed from here at all.
    openScopePicker();
    fireEvent.click(
      screen.getByRole("option", { name: /Add a workspace folder/ }),
    );
    expect(folderActionMocks.pickAndPrepareFolders).toHaveBeenCalledTimes(1);

    // The added folder becomes the selection - resolution feeds the picker
    // from the folders store, so `addResolvedFolders` is what makes it a row.
    resolvedWorkspaceMocks.folders = [
      { kind: "local-only", path: "/Users/dev/picked", name: "picked" },
    ];
    await screen.findByText("picked");
    expect(scopeTriggerText()).toContain("picked");
    expect(
      mcpMocks.listCalls.some(
        (c) =>
          c.scope === "project" &&
          c.enabled &&
          c.workspaceRoot === "/Users/dev/picked",
      ),
    ).toBe(true);
  });

  it("keeps the picker reachable for a PROJECT-ONLY provider with no workspaces", () => {
    // The dead end this guards: project-only provider, no folders opened on
    // this host. There is no Global to fall back to, and the only way out -
    // "Add a workspace folder…" - lives INSIDE the popover. Disabling the
    // trigger in that state sealed the user in with no route to a usable
    // config, which is the exact hole the add action was introduced to close.
    useWorkspaceFoldersStore.setState({ folders: [], folderInfoByPath: {} });
    resolvedWorkspaceMocks.folders = [];
    renderTab(PROJECT_ONLY_CAPS, "codex");

    const trigger = scopeTrigger();
    expect(trigger instanceof HTMLButtonElement && trigger.disabled).toBe(
      false,
    );

    openScopePicker();
    expect(
      screen.getByRole("option", { name: /Add a workspace folder/ }),
    ).toBeDefined();
  });

  it("names the current destination in the trigger's accessible name", () => {
    // `aria-label` REPLACES the visible text in the accessible name, so a bare
    // static label would tell a screen-reader user what the control is for
    // while withholding the only thing it displays - where the config goes.
    renderTab(FULL_CAPS, "codex");

    expect(scopeTrigger().getAttribute("aria-label")).toBe(
      "MCP config location: Global",
    );
  });

  // Parameterised over the two ways worktree metadata can be missing, because
  // they are indistinguishable to the tab and only one of them is intuitive.
  // A gate written against `isPending` passes the first row and fails the
  // second: a failed lookup ALSO leaves `targets` worktree-less, but leaves
  // `isPending` false, so the stored worktree reads as invalid and the
  // single-workspace default silently takes over.
  it.each([
    ["is still in flight", true],
    ["has FAILED", false],
  ])(
    "does not fall back to the workspace root while the worktree lookup %s",
    (_label, stillPending) => {
      // Falling back to the single workspace in that window points the list -
      // and any add or remove - at the PARENT repo's `.mcp.json`, a different
      // file in a different repo.
      useWorkspaceFoldersStore.setState({
        folders: ["/Users/dev/app"],
        folderInfoByPath: {
          "/Users/dev/app": {
            path: "/Users/dev/app",
            name: "app",
            repoIdentifier: null,
            hostId: "host-1",
          },
        },
      });
      resolvedWorkspaceMocks.folders = [
        { kind: "local-only", path: "/Users/dev/app", name: "app" },
      ];
      useProvidersWorkspaceSelectionStore.setState({
        selectedByHostId: { "host-1": "/Users/dev/worktrees/app-feature" },
      });
      // No data either way, so the worktree has not entered `targets`. Only
      // `isPending` differs, which is precisely what must NOT decide this.
      worktreeMocks.workspaces = [];
      worktreeMocks.loaded = false;
      worktreeMocks.pending = stillPending;
      renderTab(FULL_CAPS, "codex");

      expect(
        mcpMocks.listCalls.some(
          (c) => c.enabled && c.workspaceRoot === "/Users/dev/app",
        ),
      ).toBe(false);
    },
  );

  it("reports a browse that REJECTS instead of failing silently", async () => {
    // `pickAndPrepareFolders` guards only its prepare step; the pickers ahead
    // of it are awaited bare, so a failure rejects out of `browseForWorkspace`.
    // Unhandled, that is a silent no-op the user reads as a missed click.
    folderActionMocks.pickAndPrepareFolders.mockRejectedValue(
      new Error("picker exploded"),
    );
    renderTab(FULL_CAPS, "codex");

    openScopePicker();
    fireEvent.click(
      screen.getByRole("option", { name: /Add a workspace folder/ }),
    );

    await vi.waitFor(() => {
      expect(toastMocks.errors).toContain("Couldn't open the folder picker.");
    });
    // And the selection is untouched - a failed add is not a choice.
    expect(scopeTriggerText()).toContain("Global");
  });

  it("files an added folder under the DISPATCH host, not the active one", async () => {
    // The race this guards: `pickAndPrepareFolders` captures the host at
    // dispatch and re-validates it across every await, and `browseForWorkspace`
    // must stamp the folder with THAT id rather than re-reading the client
    // after the picker returns. Discriminating only because the mocked result
    // names a different host than the active one ("host-1" everywhere in this
    // file) - with both the same, a re-read would produce an identical store
    // and the assertion would hold for the wrong reason.
    useWorkspaceFoldersStore.setState({ folders: [], folderInfoByPath: {} });
    resolvedWorkspaceMocks.folders = [];
    folderActionMocks.pickAndPrepareFolders.mockResolvedValue({
      folders: [
        { workspacePath: "/Users/dev/on-host-2", workspaceName: "on-host-2" },
      ],
      repoIdentifiers: [],
      hostId: "host-2",
    });
    renderTab(FULL_CAPS, "codex");

    openScopePicker();
    fireEvent.click(
      screen.getByRole("option", { name: /Add a workspace folder/ }),
    );

    await vi.waitFor(() => {
      expect(
        useWorkspaceFoldersStore.getState().folderInfoByPath[
          "/Users/dev/on-host-2"
        ],
      ).toBeDefined();
    });
    expect(
      useWorkspaceFoldersStore.getState().folderInfoByPath[
        "/Users/dev/on-host-2"
      ].hostId,
    ).toBe("host-2");
  });

  it("leaves the selection alone when the folder pick is cancelled", async () => {
    folderActionMocks.pickAndPrepareFolders.mockResolvedValue(null);
    renderTab(FULL_CAPS, "codex");

    openScopePicker();
    fireEvent.click(
      screen.getByRole("option", { name: /Add a workspace folder/ }),
    );
    await vi.waitFor(() => {
      expect(folderActionMocks.pickAndPrepareFolders).toHaveBeenCalledTimes(1);
    });
    // A dismissed OS picker must not switch scope: cancelling is not choosing.
    expect(scopeTriggerText()).toContain("Global");
  });

  it("shows multi-workspace picker on first use with no prior selection", () => {
    useWorkspaceFoldersStore.setState({
      folders: ["/Users/dev/app", "/Users/dev/other"],
      folderInfoByPath: {
        "/Users/dev/app": {
          path: "/Users/dev/app",
          name: "app",
          repoIdentifier: null,
          hostId: "host-1",
        },
        "/Users/dev/other": {
          path: "/Users/dev/other",
          name: "other",
          repoIdentifier: null,
          hostId: "host-1",
        },
      },
    });
    resolvedWorkspaceMocks.folders = [
      { kind: "local-only", path: "/Users/dev/app", name: "app" },
      { kind: "local-only", path: "/Users/dev/other", name: "other" },
    ];
    useProvidersWorkspaceSelectionStore.setState({
      selectedByHostId: {},
    });
    renderTab(FULL_CAPS, "codex");

    // No silent auto-pick with more than one candidate: the pane stays on
    // Global rather than quietly adopting `folders[0]`, and BOTH workspaces
    // are offered by name.
    expect(scopeTriggerText()).toContain("Global");
    openScopePicker();
    expect(screen.getByRole("option", { name: /app/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /other/ })).toBeDefined();
    // `enabled` matters: the shadow-badge read is MOUNTED in Global scope and
    // only gated off by that flag, so it lands in `listCalls` either way.
    expect(
      mcpMocks.listCalls.some((c) => c.scope === "project" && c.enabled),
    ).toBe(false);
  });

  it("excludes non-git local-only folders stamped for another host", () => {
    // Host A scratch path must never appear as Host B's Project workspaceRoot.
    resolvedWorkspaceMocks.folders = [
      {
        kind: "unresolved",
        path: "/Users/a/scratch",
        name: "scratch",
      },
    ];
    useWorkspaceFoldersStore.setState({
      folders: ["/Users/a/scratch"],
      folderInfoByPath: {
        "/Users/a/scratch": {
          path: "/Users/a/scratch",
          name: "scratch",
          repoIdentifier: null,
          hostId: "host-A",
        },
      },
    });
    useProvidersWorkspaceSelectionStore.setState({
      selectedByHostId: { "host-1": "/Users/a/scratch" },
    });
    renderTab(FULL_CAPS, "codex");

    // Zero host-local workspaces → nothing offered under Project, and the
    // foreign path is never stamped onto a call.
    openScopePicker();
    expect(screen.queryByRole("option", { name: /scratch/ })).toBeNull();
    expect(
      mcpMocks.listCalls.some((c) => c.workspaceRoot === "/Users/a/scratch"),
    ).toBe(false);
  });

  it("excludes unresolved paths belonging to another host", () => {
    useWorkspaceFoldersStore.setState({
      folders: ["/Users/dev/app", "/Users/dev/other-host"],
      folderInfoByPath: {
        "/Users/dev/app": {
          path: "/Users/dev/app",
          name: "app",
          repoIdentifier: null,
          hostId: "host-1",
        },
        "/Users/dev/other-host": {
          path: "/Users/dev/other-host",
          name: "other-host",
          repoIdentifier: {
            owner: "acme",
            repo: "other",
          },
          hostId: "host-B",
        },
      },
    });
    // Only /Users/dev/app resolves on the bound host; other-host is unresolved.
    resolvedWorkspaceMocks.folders = [
      { kind: "local-only", path: "/Users/dev/app", name: "app" },
      {
        kind: "unresolved",
        path: "/Users/dev/other-host",
        name: "other-host",
      },
    ];
    useProvidersWorkspaceSelectionStore.setState({
      selectedByHostId: { "host-1": "/Users/dev/other-host" },
    });
    renderTab(FULL_CAPS, "codex");

    // Single host-resolved workspace is the default target; the foreign path
    // is neither offered nor stamped.
    openScopePicker();
    expect(screen.queryByRole("option", { name: /other-host/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /app/ }));
    expect(scopeTriggerText()).toContain("app");
    const projectCall = mcpMocks.listCalls.find(
      (c) =>
        c.scope === "project" &&
        c.enabled &&
        c.workspaceRoot === "/Users/dev/app",
    );
    expect(projectCall).toBeDefined();
    expect(
      mcpMocks.listCalls.some(
        (c) => c.workspaceRoot === "/Users/dev/other-host",
      ),
    ).toBe(false);
  });

  it("locks kimi to Global (no scope switch)", () => {
    renderTab(KIMI_CAPS, "kimi");
    // A single-scope provider gets a statement, not a picker holding one dead
    // option - and the statement matches the Global row's own wording.
    // The PREFIX regex matters on this negative assertion: the trigger's name
    // now ends with the selected destination, so an exact-string query would
    // match nothing whether or not the picker rendered.
    expect(
      screen.queryByRole("button", { name: /^MCP config location/ }),
    ).toBeNull();
    expect(
      screen.getByText("Applies to every workspace on this host."),
    ).toBeDefined();
  });

  // F4: every production contract sets updateServer: "none" and update: [].
  // The pencil/edit path was maintained dead code; it is removed rather than
  // wired. When a provider implements update, restore the affordance and this
  // assertion (see provider-mcp-tab canUpdate comment).
  it("does not render Edit even when a test double advertises update scopes", () => {
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    renderTab(FULL_CAPS, "codex");
    expect(screen.queryByRole("button", { name: /Edit context7/ })).toBeNull();
  });

  // F4: realistic multi-row list — Edit must stay gone on every server name,
  // not only the single-server double above. Delete/Add remain the live
  // affordances.
  it("does not render Edit on any realistic server row while Add and Delete stay", () => {
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({ name: "context7" }),
        connectedServer({
          name: "github",
          transport: {
            type: "http",
            url: "https://mcp.github.com",
            auth: null,
          },
          status: "needs_auth",
          tools: [],
        }),
        connectedServer({
          name: "local-stdio",
          transport: {
            type: "stdio",
            command: "npx",
            env: null,
          },
          status: "connected",
          tools: [],
        }),
      ],
    };
    renderTab(FULL_CAPS, "codex");

    for (const name of ["context7", "github", "local-stdio"] as const) {
      expect(
        screen.queryByRole("button", { name: new RegExp(`Edit ${name}`) }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: new RegExp(`Delete ${name}`) }),
      ).toBeDefined();
    }

    // Add still mounts a dialog fixed in mode="add" (no editTarget restore).
    fireEvent.click(screen.getByRole("button", { name: /Add MCP server/ }));
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    expect(dialog).toBeDefined();
    expect(
      within(dialog).getByRole("button", { name: /Add server/ }),
    ).toBeDefined();
    // Edit-mode copy would say "Save" / "Update server"; add mode does not.
    expect(within(dialog).queryByRole("button", { name: /Save/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Update/ })).toBeNull();
  });

  it("hides Add/Delete/auth/discover on Project when actionScopes only allow them for Global", () => {
    // Codex/Droid/Copilot-style: list both scopes, but CRUD/auth/discover
    // only global. Populate project list so Project scope has a real row
    // (including needs_auth) — empty project list would make row-level
    // assertions pass vacuously.
    const codexCaps: ProviderMcpCapabilities = {
      ...FULL_CAPS,
      actionScopes: {
        list: [...BOTH_SCOPES],
        add: [...GLOBAL_ONLY],
        update: [...GLOBAL_ONLY],
        remove: [...GLOBAL_ONLY],
        toggleServer: [...BOTH_SCOPES],
        toggleTool: [...BOTH_SCOPES],
        discover: [...GLOBAL_ONLY],
        auth: [...GLOBAL_ONLY],
      },
    };
    const needsAuthServer = connectedServer({
      name: "project-oauth",
      status: "needs_auth",
      tools: [],
    });
    const errorServer = connectedServer({
      name: "project-err",
      status: "error",
      statusDetail: "probe failed",
      tools: [],
    });
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({
          status: "needs_auth",
          tools: [],
        }),
      ],
    };
    mcpMocks.projectListResult.data = {
      servers: [needsAuthServer, errorServer],
    };
    renderTab(codexCaps, "codex");

    // Global: Add + Delete + Refresh + Sign in available.
    expect(
      screen.getByRole("button", { name: /Add MCP server/ }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Delete context7/ }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Refresh context7/ }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /Sign in/ })).toBeDefined();

    chooseScopeOption(/app/);

    // Project list is now the primary list (mock returns projectListResult
    // for project-scope reads). Header Add still scope-gated off.
    expect(screen.queryByRole("button", { name: /Add MCP server/ })).toBeNull();
    // Row-level controls on real project servers must be absent.
    expect(
      screen.queryByRole("button", { name: /Delete project-oauth/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Refresh project-oauth/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Delete project-err/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Refresh project-err/ }),
    ).toBeNull();

    // Expanded-row fallback (ToolsUnavailableState) must also honor gates.
    fireEvent.click(
      screen.getByRole("button", { name: /Expand project-oauth/ }),
    );
    expect(screen.queryByRole("button", { name: /^Sign in$/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse project-oauth/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Expand project-err/ }));
    expect(screen.queryByRole("button", { name: /^Retry$/ })).toBeNull();
  });

  it("shows shadowed by project badge on global rows", () => {
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    mcpMocks.projectListResult.data = {
      servers: [connectedServer({ name: "context7", statusSource: "native" })],
    };
    renderTab(FULL_CAPS, "codex");

    expect(screen.getByText("shadowed by project")).toBeDefined();
  });

  it("expands tools grid and toggles a tool optimistically", () => {
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    renderTab(FULL_CAPS, "codex");

    fireEvent.click(screen.getByRole("button", { name: /Expand context7/ }));
    expect(screen.getByText("Tools (2)")).toBeDefined();
    expect(screen.getByText("search_docs")).toBeDefined();
    expect(screen.getByText("list_projects")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Disable tool search_docs" }),
    );
    expect(mcpMocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: {
          action: "toggleTool",
          serverName: "context7",
          toolName: "search_docs",
          enabled: false,
        },
        suppressToast: true,
      }),
      expect.anything(),
    );
  });

  it("renders read-only tools grid for degraded-server-level backing", () => {
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({
          tools: [
            {
              name: "search_docs",
              description: "Search",
              inputSchema: null,
              enabled: true,
              readOnly: true,
            },
          ],
        }),
      ],
    };
    renderTab(CURSOR_CAPS, "cursor");

    fireEvent.click(screen.getByRole("button", { name: /Expand context7/ }));
    expect(screen.queryByText("Enable all")).toBeNull();
    const chip = screen.getByRole("button", { name: "search_docs" });
    fireEvent.click(chip);
    expect(mcpMocks.mutate).not.toHaveBeenCalled();
  });

  it("rejects duplicate names in the add modal", () => {
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    renderTab(FULL_CAPS, "codex");

    fireEvent.click(screen.getByRole("button", { name: /Add MCP server/ }));
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    const nameInput = within(dialog).getByPlaceholderText("context7");
    fireEvent.change(nameInput, { target: { value: "context7" } });
    const urlInput = within(dialog).getByPlaceholderText(
      "https://mcp.example.com",
    );
    fireEvent.change(urlInput, {
      target: { value: "https://example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Add server/ }));

    expect(
      screen.getByText(/A server named “context7” already exists/),
    ).toBeDefined();
    expect(mcpMocks.mutate).not.toHaveBeenCalled();
  });

  it("validates remote URL on add", () => {
    renderTab(FULL_CAPS, "codex");
    fireEvent.click(screen.getByRole("button", { name: /Add MCP server/ }));
    const dialog = screen.getByTestId("provider-mcp-add-dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("context7"), {
      target: { value: "new-server" },
    });
    fireEvent.change(
      within(dialog).getByPlaceholderText("https://mcp.example.com"),
      { target: { value: "not-a-url" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /Add server/ }));
    expect(screen.getByText(/valid http\(s\) URL/)).toBeDefined();
    expect(mcpMocks.mutate).not.toHaveBeenCalled();
  });

  it("starts auth login and opens authorizationUrl via runner mutation", () => {
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({
          status: "needs_auth",
          tools: [],
        }),
      ],
    };
    mcpMocks.authMutate.mockImplementation(
      (
        _vars: unknown,
        opts: {
          onSuccess: (data: {
            result: { kind: "authorizationUrl"; authorizationUrl: string };
          }) => void;
          onSettled: () => void;
        },
      ) => {
        opts.onSuccess({
          result: {
            kind: "authorizationUrl",
            authorizationUrl: "https://auth.example.com/oauth",
          },
        });
        opts.onSettled();
      },
    );
    renderTab(FULL_CAPS, "codex");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mcpMocks.authMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { action: "login", serverName: "context7", code: undefined },
      }),
      expect.anything(),
    );
    expect(mcpMocks.openExternalLink).toHaveBeenCalledWith(
      "https://auth.example.com/oauth",
    );
    const entry = useMcpPendingAuthStore.getState().get({
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
      serverName: "context7",
    });
    expect(entry).not.toBeNull();
    expect(entry?.authorizationUrl).toBe("https://auth.example.com/oauth");
  });

  it("resumes pending auth polling from store on remount", () => {
    useMcpPendingAuthStore.getState().upsert({
      key: {
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        serverName: "context7",
      },
      hostId: "host-1",
      startedAt: Date.now(),
      authorizationUrl: "https://auth.example.com/oauth",
      instruction: null,
    });
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({
          status: "needs_auth",
          tools: [],
        }),
      ],
    };
    renderTab(FULL_CAPS, "codex");

    const pollingCall = mcpMocks.listCalls.find(
      (c) => c.scope === "global" && c.enabled && c.pollWhilePending,
    );
    expect(pollingCall).toBeDefined();
  });

  it("keeps resumed auth polling alive before the first list response", () => {
    // The sibling resume test hands the component list data synchronously, so
    // it never sees the window a real mount goes through: the query starts with
    // `data === undefined`, and `servers` falls back to empty there.
    //
    // That window is reachable, not hypothetical. `useResumeOauthPolling` runs
    // during render, so the resumed name is in `authAwaitingNames` by the end of
    // the first pass — and the second pass prunes it against the empty
    // fallback, reading "no such server" as "settled". Polling would then be
    // switched off before the list that decides it ever arrives, and it is the
    // only thing that would notice the OAuth completing: `needs_auth` on its
    // own does not drive the poll cadence.
    useMcpPendingAuthStore.getState().upsert({
      key: {
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        serverName: "context7",
      },
      hostId: "host-1",
      startedAt: Date.now(),
      authorizationUrl: "https://auth.example.com/oauth",
      instruction: null,
    });
    // The list request is in flight: no data yet, exactly as on a cold mount.
    mcpMocks.listResult = {
      data: undefined,
      isPending: true,
      isError: false,
      error: null,
      isFetching: true,
    };
    renderTab(FULL_CAPS, "codex");

    // Asserted on the LAST call, not on any call: the point is that the prune
    // never retired the resumed name, so the newest render still asks to poll.
    const globalCalls = mcpMocks.listCalls.filter(
      (c) => c.scope === "global" && c.enabled,
    );
    expect(globalCalls.length).toBeGreaterThan(0);
    expect(globalCalls[globalCalls.length - 1]?.pollWhilePending).toBe(true);
  });

  it("drops the pending-auth store entry once the server settles", () => {
    // The prune that retires a settled name happens during render, but the
    // store write it triggers is deferred to an effect. That split is easy to
    // get wrong in a way nothing else here would catch: the render-phase
    // `setAuthAwaitingNames` re-renders immediately with an empty diff, so an
    // implementation that recomputes the settled names for the effect instead
    // of carrying them in state flushes an empty list and leaks the entry
    // forever. This asserts the entry is actually gone.
    const key = {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
      serverName: "context7",
    } as const;
    useMcpPendingAuthStore.getState().upsert({
      key,
      hostId: "host-1",
      startedAt: Date.now(),
      authorizationUrl: "https://auth.example.com/oauth",
      instruction: null,
    });
    // Settled: neither "connecting" nor "needs_auth", so the prune retires it.
    mcpMocks.listResult.data = {
      servers: [connectedServer({ status: "connected" })],
    };

    renderTab(FULL_CAPS, "codex");

    expect(useMcpPendingAuthStore.getState().get(key)).toBeNull();
  });

  it("redacts secrets in pendingInstruction auth text", () => {
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({
          status: "needs_auth",
          tools: [],
        }),
      ],
    };
    mcpMocks.authMutate.mockImplementation(
      (
        _vars: unknown,
        opts: {
          onSuccess: (data: {
            result: { kind: "pendingInstruction"; instruction: string };
          }) => void;
          onSettled: () => void;
        },
      ) => {
        opts.onSuccess({
          result: {
            kind: "pendingInstruction",
            instruction:
              "Visit https://tok@example.com/oauth with OPENAI_API_KEY=sk-secret",
          },
        });
        opts.onSettled();
      },
    );
    renderTab(FULL_CAPS, "codex");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.queryByText(/sk-secret/)).toBeNull();
    expect(screen.queryByText(/tok@/)).toBeNull();
    expect(screen.getByText(/<redacted>/)).toBeDefined();
  });

  /*
   * The caveat rides the bulk-toggle controls now, not a banner over the whole
   * tab - so it only exists once a server is expanded, and its text lives in a
   * tooltip. Asserting the trigger's accessible name rather than opening the
   * tooltip keeps this a placement test; Radix renders the content into a
   * portal only while open.
   */
  it("offers the Traycer-sessions-only caveat beside the bulk tool toggles", () => {
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    renderTab(
      {
        ...FULL_CAPS,
        traycerSessionsOnlyEnforcement: true,
      },
      "codex",
    );

    expect(screen.queryByText(/Traycer sessions only/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Expand context7/ }));

    expect(screen.getByRole("button", { name: "Enable all" })).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: "Where tool enable/disable applies",
      }),
    ).toBeDefined();
  });

  it("omits the caveat when the provider does not scope tool toggles", () => {
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    renderTab(FULL_CAPS, "codex");

    fireEvent.click(screen.getByRole("button", { name: /Expand context7/ }));

    expect(
      screen.queryByRole("button", {
        name: "Where tool enable/disable applies",
      }),
    ).toBeNull();
  });

  it("shows the empty list copy when no servers are configured", () => {
    mcpMocks.listResult.data = { servers: [] };
    renderTab(FULL_CAPS, "codex");

    expect(screen.getByText("No MCP servers")).toBeDefined();
    expect(
      screen.getByText(
        "Add an MCP server so codex can use external tools and context.",
      ),
    ).toBeDefined();
    // Search is still offered so an empty host does not hide the affordance,
    // but the empty-list copy must not be replaced by a "no match" state.
    expect(
      screen.getByRole("textbox", { name: "Search servers" }),
    ).toBeDefined();
    expect(screen.queryByText(/No servers match/)).toBeNull();
  });

  it("distinguishes an unmatched query from a truly empty server list", () => {
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({ name: "context7" }),
        connectedServer({ name: "github" }),
      ],
    };
    renderTab(FULL_CAPS, "codex");

    expect(screen.getByText("context7")).toBeDefined();
    expect(screen.getByText("github")).toBeDefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Search servers" }), {
      target: { value: "zzzz-nope" },
    });

    expect(screen.queryByText("context7")).toBeNull();
    expect(screen.queryByText("github")).toBeNull();
    expect(screen.queryByText("No MCP servers")).toBeNull();
    expect(screen.getByText("No servers match “zzzz-nope”.")).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("No servers match.");
  });

  it("filters the server list and announces how many remain", () => {
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({ name: "context7" }),
        connectedServer({ name: "github" }),
      ],
    };
    renderTab(FULL_CAPS, "codex");

    fireEvent.change(screen.getByRole("textbox", { name: "Search servers" }), {
      target: { value: "contxt7" },
    });

    expect(screen.getByText("context7")).toBeDefined();
    expect(screen.queryByText("github")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 server shown.");
  });

  /**
   * The shape `applyBinaryAbsentGate` hands the client when it could not
   * resolve a CLI: the write verbs' scope lists are emptied while the ROUTING
   * fields (`addServer`/`removeServer`) keep saying "cli" - which is the only
   * evidence the client has that something was subtracted rather than never
   * offered.
   */
  const BINARY_ABSENT_CAPS: ProviderMcpCapabilities = {
    ...FULL_CAPS,
    authActions: [],
    actionScopes: {
      ...FULL_CAPS.actionScopes,
      add: [],
      remove: [],
      auth: [],
    },
  };

  describe("binary-absent gate", () => {
    it("explains the missing write actions instead of silently dropping them", () => {
      mcpMocks.listResult.data = { servers: [connectedServer({})] };
      renderTabWithCliBinary(BINARY_ABSENT_CAPS, "codex", false);

      // The regression this guards: servers listed, Add gone, and nothing
      // anywhere saying why or what to do about it.
      expect(
        screen.queryByRole("button", { name: "Add MCP server" }),
      ).toBeNull();
      const notice = screen.getByTestId("mcp-binary-absent-notice");
      expect(notice.textContent).toContain("couldn't find the codex CLI");
      expect(notice.textContent).toContain("adding and removing");
      expect(notice.textContent).toContain("CLI & Args");
    });

    it("stays silent when the host resolved a binary", () => {
      mcpMocks.listResult.data = { servers: [connectedServer({})] };
      renderTabWithCliBinary(FULL_CAPS, "codex", true);

      expect(screen.queryByTestId("mcp-binary-absent-notice")).toBeNull();
    });

    it("does not accuse a provider whose write verbs were never CLI-routed", () => {
      // Cursor patches its config file, so an absent binary takes nothing this
      // notice can prove. Claiming otherwise would be a guess, and the empty
      // `authActions` it DOES leave behind is indistinguishable from a contract
      // that never had auth actions at all.
      mcpMocks.listResult.data = { servers: [connectedServer({})] };
      renderTabWithCliBinary(
        { ...CURSOR_CAPS, addServer: "patch", removeServer: "patch" },
        "cursor",
        false,
      );

      expect(screen.queryByTestId("mcp-binary-absent-notice")).toBeNull();
    });
  });
});
