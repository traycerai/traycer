import type {
  ProviderMcpCapabilities,
  ProviderMcpCoverage,
  ProviderMcpNotice,
  ProviderMcpOrigin,
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
 * KiloCode native MCP panel (design: kilocode-native-mcp-support, settings
 * delivery U1-U3 and U5, mutation delivery A39). Origin, coverage and
 * decidedBy are additive, so every case also pins the old-host rendering.
 *
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
  data:
    | {
        servers: ProviderMcpServer[];
        notices: ProviderMcpNotice[];
        coverage: ProviderMcpCoverage | null;
      }
    | undefined;
  isPending: boolean;
  isError: boolean;
  error: { message: string } | null;
  isFetching: boolean;
  refetch: () => Promise<void>;
} {
  return {
    data: { servers: [], notices: [], coverage: null },
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(() => Promise.resolve()),
  };
}

const mcpMocks = vi.hoisted(() => ({
  listResult: emptyListQueryMock(),
  projectListResult: emptyListQueryMock(),
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  mutateIsPending: false,
  confirmationIsPending: false,
  discoverMutate: vi.fn(),
  authMutate: vi.fn(),
  openLink: vi.fn(),
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

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

// No host directory in this harness; the credential gate is the add and edit
// dialogs' concern, not the origin and coverage rows'.
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
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

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mcpMocks.openLink,
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
  useProvidersMcpApplyRemedy: () => ({
    mutateAsync: mcpMocks.mutateAsync,
    isPending: mcpMocks.confirmationIsPending,
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

const KILO_CAPS: ProviderMcpCapabilities = {
  ...FULL_CAPS,
  stdioDegradeNotice: false,
};

function renderKilo() {
  return render(
    <ProviderMcpTab
      providerId="kilocode"
      capabilities={KILO_CAPS}
      providerLabel="Kilo"
      cliBinaryResolved
    />,
  );
}

function origin(overrides: Partial<ProviderMcpOrigin>): ProviderMcpOrigin {
  return {
    scope: "global",
    label: "Global settings",
    path: null,
    inherited: false,
    editable: true,
    ...overrides,
  };
}

function setLists(args: {
  global: ProviderMcpServer[];
  project?: ProviderMcpServer[];
  coverage?: ProviderMcpCoverage | null;
}): void {
  mcpMocks.listResult.data = {
    servers: args.global,
    notices: [],
    coverage: args.coverage ?? null,
  };
  if (args.project !== undefined) {
    mcpMocks.projectListResult.data = {
      servers: args.project,
      notices: [],
      coverage: null,
    };
  }
}

describe("<ProviderMcpTab /> KiloCode origin, coverage and notices", () => {
  beforeEach(() => {
    // Same factory as the initial value, so a reset can never re-narrow what
    // the mock is able to represent.
    mcpMocks.listResult = emptyListQueryMock();
    mcpMocks.projectListResult = emptyListQueryMock();
    mcpMocks.mutate.mockReset();
    mcpMocks.mutateAsync.mockReset();
    mcpMocks.mutateAsync.mockResolvedValue(undefined);
    mcpMocks.discoverMutate.mockReset();
    mcpMocks.authMutate.mockReset();
    mcpMocks.openLink.mockReset();
    mcpMocks.mutateIsPending = false;
    mcpMocks.confirmationIsPending = false;
    mcpMocks.listCalls = [];
    worktreeMocks.workspaces = [];
    worktreeMocks.loaded = true;
    worktreeMocks.pending = false;
    toastMocks.errors = [];
    folderActionMocks.pickAndPrepareFolders.mockReset();
    folderActionMocks.pickAndPrepareFolders.mockResolvedValue(null);
    folderActionMocks.isPreparing = false;
    useWorkspaceFoldersStore.setState({
      byHost: {
        "host-1": {
          folders: ["/Users/dev/app"],
          folderInfoByPath: {
            "/Users/dev/app": {
              path: "/Users/dev/app",
              name: "app",
              repoIdentifier: null,
              hostId: "host-1",
            },
          },
          primaryPath: null,
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

  it("U1: no stdio banner or degraded badge, and a connected probe row lists tools", () => {
    setLists({
      global: [
        connectedServer({
          name: "local-tool",
          transport: { type: "stdio", command: "node", env: null },
          origin: origin({}),
        }),
      ],
    });
    renderKilo();

    expect(screen.queryByText(/config-only under this provider/)).toBeNull();
    expect(screen.queryByText("stdio degraded")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Expand local-tool/ }));
    expect(screen.getByText("search_docs")).toBeDefined();
  });

  it("U2: inherited project rows do not shadow the global row", () => {
    setLists({
      global: [connectedServer({ origin: origin({}) })],
      project: [
        connectedServer({
          origin: origin({ scope: "global", inherited: true, editable: false }),
        }),
      ],
    });
    renderKilo();

    expect(screen.queryByText("shadowed by project")).toBeNull();
  });

  it("U2: a project-decided row shadows the global row", () => {
    setLists({
      global: [connectedServer({ origin: origin({}) })],
      project: [
        connectedServer({
          origin: origin({ scope: "project", label: "Project settings" }),
        }),
      ],
    });
    renderKilo();

    expect(screen.getByText("shadowed by project")).toBeDefined();
  });

  it("U2/A39: an old host (no origin) keeps today's shadow rule and shows no origin chrome", () => {
    setLists({
      global: [connectedServer({})],
      project: [connectedServer({})],
    });
    renderKilo();

    expect(screen.getByText("shadowed by project")).toBeDefined();
    expect(screen.queryByText("From global")).toBeNull();
    expect(screen.queryByText("read-only")).toBeNull();
    expect(screen.queryByTestId("mcp-coverage-line")).toBeNull();
  });

  it("U3: renders the origin label, From global and read-only badges", () => {
    setLists({
      global: [
        connectedServer({
          name: "managed-docs",
          origin: origin({
            scope: "managed",
            label: "Managed settings",
            editable: false,
          }),
        }),
        connectedServer({
          name: "inherited-docs",
          origin: origin({ inherited: true }),
        }),
      ],
    });
    renderKilo();

    expect(screen.getByText("Managed settings")).toBeDefined();
    expect(screen.getByText("read-only")).toBeDefined();
    expect(screen.getByText("From global")).toBeDefined();
  });

  it("U3: a read-only or inherited row offers no delete, an editable one does", () => {
    setLists({
      global: [
        connectedServer({
          name: "managed-docs",
          origin: origin({ scope: "managed", editable: false }),
        }),
        connectedServer({
          name: "inherited-docs",
          origin: origin({ inherited: true }),
        }),
        connectedServer({ name: "mine", origin: origin({}) }),
      ],
    });
    renderKilo();

    expect(screen.queryByLabelText("Delete managed-docs")).toBeNull();
    expect(screen.queryByLabelText("Delete inherited-docs")).toBeNull();
    expect(screen.getByLabelText("Delete mine")).toBeDefined();
  });

  it("A39: an old host row (no origin) still offers delete", () => {
    setLists({ global: [connectedServer({ name: "plain" })] });
    renderKilo();

    expect(screen.getByLabelText("Delete plain")).toBeDefined();
  });

  it("U3: an incomplete coverage line names what was not read; complete or absent shows none", () => {
    setLists({
      global: [connectedServer({})],
      coverage: {
        complete: false,
        sources: [
          {
            label: "Managed settings",
            path: null,
            scope: "managed",
            outcome: "unsupported",
            reason: "Not readable here",
          },
          {
            label: "Global settings",
            path: null,
            scope: "global",
            outcome: "read",
            reason: null,
          },
        ],
      },
    });
    const view = renderKilo();

    const line = screen.getByTestId("mcp-coverage-line");
    expect(line.textContent).toBe(
      "Showing servers from the Kilo config files Traycer can read. Not read: Managed settings (Not readable here).",
    );
    expect(line.textContent).not.toContain("Global settings");

    setLists({
      global: [connectedServer({})],
      coverage: { complete: true, sources: [] },
    });
    view.rerender(
      <ProviderMcpTab
        providerId="kilocode"
        capabilities={KILO_CAPS}
        providerLabel="Kilo"
        cliBinaryResolved
      />,
    );
    expect(screen.queryByTestId("mcp-coverage-line")).toBeNull();
  });

  it("U3: an inherited non-global row names its real source; inherited global stays From global", () => {
    setLists({
      global: [
        connectedServer({
          name: "managed-docs",
          origin: origin({
            scope: "managed",
            label: "Managed settings",
            inherited: true,
            editable: false,
          }),
        }),
        connectedServer({
          name: "env-docs",
          origin: origin({
            scope: "env",
            label: "Environment config",
            inherited: true,
            editable: false,
          }),
        }),
        connectedServer({
          name: "cloud-docs",
          origin: origin({
            scope: "cloud",
            label: "Cloud settings",
            inherited: true,
            editable: false,
          }),
        }),
        connectedServer({
          name: "legacy-docs",
          origin: origin({
            scope: "legacy",
            label: "Legacy settings",
            inherited: true,
            editable: false,
          }),
        }),
        connectedServer({
          name: "global-docs",
          origin: origin({ scope: "global", inherited: true }),
        }),
      ],
    });
    renderKilo();

    expect(screen.getByText("Managed settings")).toBeDefined();
    expect(screen.getByText("Environment config")).toBeDefined();
    expect(screen.getByText("Cloud settings")).toBeDefined();
    expect(screen.getByText("Legacy settings")).toBeDefined();
    expect(screen.getAllByText("From global")).toHaveLength(1);
    expect(
      screen.queryByText(/From (Managed|Environment|Cloud|Legacy)/),
    ).toBeNull();
  });

  describe("Project Add rejects any name already in the effective view", () => {
    function tryProjectAdd(name: string): void {
      fireEvent.click(
        screen.getByRole("button", { name: /^MCP config location/ }),
      );
      fireEvent.click(screen.getByRole("option", { name: /app/ }));
      fireEvent.click(screen.getByRole("button", { name: /Add MCP server/ }));
      const dialog = screen.getByTestId("provider-mcp-add-dialog");
      fireEvent.change(within(dialog).getByPlaceholderText("context7"), {
        target: { value: name },
      });
      fireEvent.change(
        within(dialog).getByPlaceholderText("https://mcp.example.com"),
        { target: { value: "https://example.com/mcp" } },
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: /Add server/ }),
      );
    }

    function setProject(rows: ProviderMcpServer[]): void {
      mcpMocks.projectListResult.data = {
        servers: rows,
        notices: [],
        coverage: null,
      };
    }

    // An inherited override is made with toggleServer, never by re-adding the
    // name, so all three shapes are refused and nothing is written.
    it.each([
      [
        "an inherited global row",
        connectedServer({
          name: "dup",
          origin: origin({ scope: "global", inherited: true, editable: true }),
        }),
      ],
      [
        "a project-decided row",
        connectedServer({
          name: "dup",
          origin: origin({ scope: "project", label: "Project settings" }),
        }),
      ],
      ["an old-host row with no origin", connectedServer({ name: "dup" })],
    ])("blocks the name of %s", (_label, server) => {
      setProject([server]);
      renderKilo();
      tryProjectAdd("dup");

      expect(
        screen.getByText(/A server named “dup” already exists/),
      ).toBeDefined();
      expect(mcpMocks.mutate).not.toHaveBeenCalled();
    });
  });

  it("an editable inherited row in Project view is overridden with toggleServer, not Add", () => {
    mcpMocks.projectListResult.data = {
      servers: [
        connectedServer({
          name: "dup",
          origin: origin({ scope: "global", inherited: true, editable: true }),
        }),
      ],
      notices: [],
      coverage: null,
    };
    renderKilo();
    fireEvent.click(
      screen.getByRole("button", { name: /^MCP config location/ }),
    );
    fireEvent.click(screen.getByRole("option", { name: /app/ }));

    fireEvent.click(screen.getByRole("switch", { name: "Disable dup" }));

    expect(mcpMocks.mutate).toHaveBeenCalledTimes(1);
    expect(mcpMocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      providerId: "kilocode",
      scope: "project",
      workspaceRoot: "/Users/dev/app",
      mutation: { action: "toggleServer", name: "dup", enabled: false },
    });
  });

  it("U3: a non-Kilo provider's incomplete coverage gets the generic line, not Kilo copy", () => {
    setLists({
      global: [connectedServer({})],
      coverage: {
        complete: false,
        sources: [
          {
            label: "Managed settings",
            path: null,
            scope: "managed",
            outcome: "unsupported",
            reason: "Not readable here",
          },
        ],
      },
    });
    render(
      <ProviderMcpTab
        providerId="codex"
        capabilities={FULL_CAPS}
        providerLabel="Codex"
        cliBinaryResolved
      />,
    );

    const line = screen.getByTestId("mcp-coverage-line");
    expect(line.textContent).toBe(
      "This server list may be incomplete. Check: Managed settings (Not readable here).",
    );
    expect(line.textContent).not.toContain("Kilo");
  });

  it("U3: a tool decided by a rule shows the rule and its file", () => {
    setLists({
      global: [
        connectedServer({
          origin: origin({}),
          tools: [
            {
              name: "search_docs",
              description: null,
              inputSchema: null,
              enabled: false,
              readOnly: true,
              decidedBy: {
                pattern: "docs_*",
                action: "deny",
                label: "opencode.jsonc",
                path: null,
              },
            },
          ],
        }),
      ],
    });
    renderKilo();

    fireEvent.click(screen.getByRole("button", { name: /Expand context7/ }));
    expect(
      screen.getAllByText("Denied by docs_* in opencode.jsonc").length,
    ).toBeGreaterThan(0);
  });

  it("U5: the cwd-ignored and check-context-global notices render non-blocking", () => {
    mcpMocks.listResult.data = {
      servers: [connectedServer({})],
      coverage: null,
      notices: [
        {
          id: "kilocode-cwd-ignored",
          tone: "info",
          text: "Kilo ignores the working folder for this check.",
          blocking: false,
          remedy: null,
        },
        {
          id: "kilocode-check-context-global",
          tone: "info",
          text: "This check ran against global settings.",
          blocking: false,
          remedy: null,
        },
      ],
    };
    renderKilo();

    expect(
      screen.getByText("Kilo ignores the working folder for this check."),
    ).toBeDefined();
    expect(
      screen.getByText("This check ran against global settings."),
    ).toBeDefined();
    expect(screen.getByText("context7")).toBeDefined();
  });
});
