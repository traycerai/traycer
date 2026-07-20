import "../../../../../__tests__/test-browser-apis";
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

const mcpMocks = vi.hoisted(() => ({
  listResult: {
    data: { servers: [] as ProviderMcpServer[] },
    isPending: false,
    isError: false,
    error: null as { message: string } | null,
    isFetching: false,
  },
  projectListResult: {
    data: { servers: [] as ProviderMcpServer[] },
    isPending: false,
    isError: false,
    error: null as { message: string } | null,
    isFetching: false,
  },
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

const resolvedWorkspaceMocks = vi.hoisted(() => ({
  folders: [] as Array<{
    kind: "resolved" | "local-only" | "unresolved";
    path: string;
    name: string;
  }>,
  isLoading: false,
  isFetching: false,
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

function renderTab(
  caps: ProviderMcpCapabilities,
  providerId: "codex" | "cursor" | "kimi",
) {
  return render(
    <ProviderMcpTab
      providerId={providerId}
      capabilities={caps}
      providerLabel={providerId}
    />,
  );
}

describe("<ProviderMcpTab />", () => {
  beforeEach(() => {
    mcpMocks.listResult = {
      data: { servers: [] },
      isPending: false,
      isError: false,
      error: null,
      isFetching: false,
    };
    mcpMocks.projectListResult = {
      data: { servers: [] },
      isPending: false,
      isError: false,
      error: null,
      isFetching: false,
    };
    mcpMocks.mutate.mockReset();
    mcpMocks.mutateAsync.mockReset();
    mcpMocks.discoverMutate.mockReset();
    mcpMocks.authMutate.mockReset();
    mcpMocks.openExternalLink.mockReset();
    mcpMocks.mutateIsPending = false;
    mcpMocks.listCalls = [];
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

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    const projectCall = mcpMocks.listCalls.find(
      (c) =>
        c.scope === "project" &&
        c.enabled &&
        c.workspaceRoot === "/Users/dev/app",
    );
    expect(projectCall).toBeDefined();
    expect(screen.getByText("app")).toBeDefined();
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
    fireEvent.click(screen.getByRole("button", { name: "Project" }));

    const picker = screen.getByRole("combobox", { name: "Project workspace" });
    expect(picker).toBeDefined();
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("option", { name: "other" }));

    const projectCall = mcpMocks.listCalls.find(
      (c) =>
        c.scope === "project" &&
        c.enabled &&
        c.workspaceRoot === "/Users/dev/other",
    );
    expect(projectCall).toBeDefined();
  });

  it("disables Project chip when zero workspaces on this host", () => {
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
    });
    resolvedWorkspaceMocks.folders = [];
    renderTab(FULL_CAPS, "codex");

    const projectChip = screen.getByRole("button", { name: "Project" });
    expect(projectChip).toHaveProperty("disabled", true);
    expect(projectChip.getAttribute("title")).toBe("Open a workspace first");
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

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(
      screen.getByRole("combobox", { name: "Project workspace" }),
    ).toBeDefined();
    expect(screen.getByText(/Select a workspace/)).toBeDefined();
    expect(
      screen.queryByText(
        /Open a workspace to manage project-scoped MCP servers/,
      ),
    ).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Project" }));

    // Zero host-local workspaces → Project disabled / open-a-workspace empty.
    expect(
      screen.queryByRole("combobox", { name: "Project workspace" }),
    ).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Project" }));

    // Single host-resolved workspace auto-selects; foreign path is ignored.
    expect(
      screen.queryByRole("combobox", { name: "Project workspace" }),
    ).toBeNull();
    expect(screen.getByText("app")).toBeDefined();
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
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
    expect(screen.getByText("Global scope only")).toBeDefined();
  });

  it("hides Edit when actionScopes.update is empty", () => {
    const noUpdateCaps: ProviderMcpCapabilities = {
      ...FULL_CAPS,
      actionScopes: {
        ...FULL_CAPS.actionScopes,
        update: [],
      },
    };
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    renderTab(noUpdateCaps, "codex");
    expect(screen.queryByRole("button", { name: /Edit context7/ })).toBeNull();
  });

  it("shows Edit when actionScopes.update includes current scope", () => {
    mcpMocks.listResult.data = { servers: [connectedServer({})] };
    renderTab(FULL_CAPS, "codex");
    expect(screen.getByRole("button", { name: /Edit context7/ })).toBeDefined();
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

    fireEvent.click(screen.getByRole("button", { name: "Project" }));

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

  it("shows Traycer sessions only note when descriptor flag is set", () => {
    mcpMocks.listResult.data = { servers: [] };
    renderTab(
      {
        ...FULL_CAPS,
        traycerSessionsOnlyEnforcement: true,
      },
      "codex",
    );
    expect(screen.getByText(/Traycer sessions only/)).toBeDefined();
  });
});
