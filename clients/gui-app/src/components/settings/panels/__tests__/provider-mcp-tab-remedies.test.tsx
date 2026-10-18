import type {
  ProviderMcpCapabilities,
  ProviderMcpNotice,
  ProviderMcpServer,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderMcpTab } from "@/components/settings/panels/provider-mcp-tab";
import { ProviderNativeRpcError } from "@/hooks/providers/native-response-map";
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
  data:
    | { servers: ProviderMcpServer[]; notices: ProviderMcpNotice[] }
    | undefined;
  isPending: boolean;
  isError: boolean;
  error: { message: string } | null;
  isFetching: boolean;
  refetch: () => Promise<void>;
} {
  return {
    data: { servers: [], notices: [] },
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

const REMEDY_CAPS: ProviderMcpCapabilities = {
  ...KIMI_CAPS,
  actionScopes: { ...KIMI_CAPS.actionScopes, applyRemedy: [...GLOBAL_ONLY] },
};

const TRUST_REMEDY = {
  id: "trust-workspace",
  label: "Trust this folder",
  confirmation: "Kimi will run this folder's MCP servers on this machine.",
};

const BLOCKING_NOTICE: ProviderMcpNotice = {
  id: "project-untrusted",
  tone: "warning",
  text: "This project is not trusted, so its servers are hidden.",
  blocking: true,
  remedy: TRUST_REMEDY,
};

const ENABLE_REMEDY = {
  id: "kimi:enable:local-tool",
  label: "Enable local-tool",
  confirmation: "This server runs a program on this machine.",
};
const STDIO_ROW = connectedServer({
  name: "local-tool",
  enabled: false,
  transport: { type: "stdio", command: "node", env: null },
  enableConfirmation: ENABLE_REMEDY,
});

describe("<ProviderMcpTab /> host remedies and confirmations", () => {
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

  it("renders a notice remedy that stays unconfirmed until the person accepts", () => {
    mcpMocks.listResult.data = { servers: [], notices: [BLOCKING_NOTICE] };
    renderTab(REMEDY_CAPS, "kimi");

    expect(screen.getByText(BLOCKING_NOTICE.text)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: TRUST_REMEDY.label }));

    expect(screen.getByText(TRUST_REMEDY.confirmation)).toBeDefined();
    expect(mcpMocks.mutateAsync).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: TRUST_REMEDY.label }),
    );
    expect(mcpMocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mcpMocks.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      providerId: "kimi",
      scope: "global",
      mutation: { action: "applyRemedy", remedyId: TRUST_REMEDY.id },
    });
  });

  it("cancelling the remedy confirmation sends nothing", () => {
    mcpMocks.listResult.data = { servers: [], notices: [BLOCKING_NOTICE] };
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(screen.getByRole("button", { name: TRUST_REMEDY.label }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(mcpMocks.mutate).not.toHaveBeenCalled();
    expect(mcpMocks.mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides the remedy control when the host does not declare applyRemedy", () => {
    mcpMocks.listResult.data = { servers: [], notices: [BLOCKING_NOTICE] };
    renderTab(KIMI_CAPS, "kimi");

    // The notice text still tells the person what is wrong...
    expect(screen.getByText(BLOCKING_NOTICE.text)).toBeDefined();
    // ...but a remedy the host cannot apply is not offered.
    expect(
      screen.queryByRole("button", { name: TRUST_REMEDY.label }),
    ).toBeNull();
  });

  it("hides the remedy when applyRemedy is declared for another scope only", () => {
    mcpMocks.listResult.data = { servers: [], notices: [BLOCKING_NOTICE] };
    renderTab(
      {
        ...KIMI_CAPS,
        actionScopes: {
          ...KIMI_CAPS.actionScopes,
          applyRemedy: [...PROJECT_ONLY],
        },
      },
      "kimi",
    );
    expect(
      screen.queryByRole("button", { name: TRUST_REMEDY.label }),
    ).toBeNull();
  });

  it("a blocking notice with no rows replaces the empty state", () => {
    mcpMocks.listResult.data = { servers: [], notices: [BLOCKING_NOTICE] };
    renderTab(REMEDY_CAPS, "kimi");
    expect(screen.queryByText("No MCP servers")).toBeNull();
  });

  it("a non-blocking notice with no rows keeps the empty state", () => {
    mcpMocks.listResult.data = {
      servers: [],
      notices: [{ ...BLOCKING_NOTICE, blocking: false }],
    };
    renderTab(REMEDY_CAPS, "kimi");
    expect(screen.getByText("No MCP servers")).toBeDefined();
  });

  it("an old host (no notices, no row remedy) keeps the plain empty state", () => {
    mcpMocks.listResult.data = { servers: [], notices: [] };
    renderTab(KIMI_CAPS, "kimi");
    expect(screen.getByText("No MCP servers")).toBeDefined();
  });

  it("applies a row remedy only after its confirmation", () => {
    mcpMocks.listResult.data = {
      servers: [connectedServer({ name: "docs", remedy: TRUST_REMEDY })],
      notices: [],
    };
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(
      screen.getByRole("button", { name: `${TRUST_REMEDY.label} docs` }),
    );
    expect(mcpMocks.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(TRUST_REMEDY.confirmation)).toBeDefined();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: TRUST_REMEDY.label,
      }),
    );
    expect(mcpMocks.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      mutation: { action: "applyRemedy", remedyId: TRUST_REMEDY.id },
    });
  });

  it("does not offer a row remedy without the applyRemedy capability", () => {
    mcpMocks.listResult.data = {
      servers: [connectedServer({ name: "docs", remedy: TRUST_REMEDY })],
      notices: [],
    };
    renderTab(KIMI_CAPS, "kimi");
    expect(
      screen.queryByRole("button", { name: `${TRUST_REMEDY.label} docs` }),
    ).toBeNull();
  });

  it("enabling a server with an enable offer asks first, then applies its id", () => {
    mcpMocks.listResult.data = { servers: [STDIO_ROW], notices: [] };
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(screen.getByRole("switch", { name: "Enable local-tool" }));
    expect(mcpMocks.mutateAsync).not.toHaveBeenCalled();
    expect(
      screen.getByText("This server runs a program on this machine."),
    ).toBeDefined();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Enable",
      }),
    );
    expect(mcpMocks.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      mutation: { action: "applyRemedy", remedyId: ENABLE_REMEDY.id },
    });
  });

  it("confirms a declared enable offer on an HTTP row", () => {
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({
          name: "http-tool",
          enabled: false,
          enableConfirmation: ENABLE_REMEDY,
        }),
      ],
      notices: [],
    };
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(screen.getByRole("switch", { name: "Enable http-tool" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(mcpMocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Enable",
      }),
    );
    expect(mcpMocks.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      mutation: { action: "applyRemedy", remedyId: ENABLE_REMEDY.id },
    });
  });

  it("does not treat a notice remedy id as a server pending name", () => {
    mcpMocks.mutateAsync.mockImplementation(() => new Promise(() => {}));
    mcpMocks.listResult.data = {
      servers: [connectedServer({ name: "docs", enabled: true })],
      notices: [
        {
          ...BLOCKING_NOTICE,
          remedy: { ...TRUST_REMEDY, id: "docs" },
        },
      ],
    };
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(screen.getByRole("button", { name: TRUST_REMEDY.label }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: TRUST_REMEDY.label,
      }),
    );
    // The open modal hides the background from the accessibility tree, but
    // its row remains mounted and must not enter the server-pending set.
    const toggle = document.querySelector(
      '[role="switch"][aria-label="Disable docs"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.hasAttribute("disabled")).toBe(false);
  });

  it("an empty enable confirmation still requires the dialog", () => {
    mcpMocks.listResult.data = {
      servers: [
        {
          ...STDIO_ROW,
          enableConfirmation: { ...ENABLE_REMEDY, confirmation: "" },
        },
      ],
      notices: [],
    };
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(screen.getByRole("switch", { name: "Enable local-tool" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(mcpMocks.mutate).not.toHaveBeenCalled();
    expect(mcpMocks.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Enable",
      }),
    );
    expect(mcpMocks.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("a separate mutation does not lock the confirmation dialog", () => {
    mcpMocks.mutateIsPending = true;
    mcpMocks.listResult.data = {
      servers: [connectedServer({ name: "docs", remedy: TRUST_REMEDY })],
      notices: [],
    };
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(
      screen.getByRole("button", { name: `${TRUST_REMEDY.label} docs` }),
    );
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: TRUST_REMEDY.label,
    });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    expect(mcpMocks.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("an unrelated row mutation does not disable a notice remedy", () => {
    mcpMocks.mutateIsPending = true;
    mcpMocks.listResult.data = { servers: [], notices: [BLOCKING_NOTICE] };
    renderTab(REMEDY_CAPS, "kimi");

    const remedyButton = screen.getByRole("button", {
      name: TRUST_REMEDY.label,
    });
    expect(remedyButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(remedyButton);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("clears an old row error when applying that row's remedy", () => {
    mcpMocks.listResult.data = {
      servers: [
        connectedServer({ name: "docs", enabled: true, remedy: TRUST_REMEDY }),
      ],
      notices: [],
    };
    mcpMocks.mutate.mockImplementation(
      (
        _variables: unknown,
        callbacks: {
          readonly onError: (error: ProviderNativeRpcError) => void;
          readonly onSettled: () => void;
        },
      ) => {
        callbacks.onError(
          new ProviderNativeRpcError({
            code: "external_drift",
            detail: "Earlier failure",
            method: "providers.nativeMutate",
          }),
        );
        callbacks.onSettled();
      },
    );
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(screen.getByRole("switch", { name: "Disable docs" }));
    expect(screen.getByText("Earlier failure")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Trust this folder docs" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: TRUST_REMEDY.label,
      }),
    );
    expect(screen.queryByText("Earlier failure")).toBeNull();
  });

  it("disabling a server never asks, even when it carries an enable confirmation", () => {
    mcpMocks.listResult.data = {
      servers: [{ ...STDIO_ROW, enabled: true }],
      notices: [],
    };
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(screen.getByRole("switch", { name: "Disable local-tool" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mcpMocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      mutation: { action: "toggleServer", name: "local-tool", enabled: false },
    });
  });

  it("enables a server with no enable confirmation immediately (old host)", () => {
    mcpMocks.listResult.data = {
      servers: [connectedServer({ name: "plain", enabled: false })],
      notices: [],
    };
    renderTab(KIMI_CAPS, "kimi");

    fireEvent.click(screen.getByRole("switch", { name: "Enable plain" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mcpMocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      mutation: { action: "toggleServer", name: "plain", enabled: true },
    });
  });

  it("does not enable a stdio row without an offer on a remedy-capable host", () => {
    mcpMocks.listResult.data = {
      servers: [
        { ...STDIO_ROW, enableConfirmation: null, remedy: TRUST_REMEDY },
      ],
      notices: [],
    };
    renderTab(REMEDY_CAPS, "kimi");

    expect(
      screen.queryByRole("switch", { name: "Enable local-tool" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Trust this folder local-tool" }),
    ).toBeDefined();
    expect(mcpMocks.mutate).not.toHaveBeenCalled();
  });

  it("closes a confirmation when the row's offer id changes", () => {
    mcpMocks.listResult.data = { servers: [STDIO_ROW], notices: [] };
    const view = renderTab(REMEDY_CAPS, "kimi");
    fireEvent.click(screen.getByRole("switch", { name: "Enable local-tool" }));
    expect(screen.getByRole("dialog")).toBeDefined();

    mcpMocks.listResult.data = {
      servers: [
        {
          ...STDIO_ROW,
          enableConfirmation: { ...ENABLE_REMEDY, id: "kimi:enable:changed" },
        },
      ],
      notices: [],
    };
    view.rerender(
      <ProviderMcpTab
        providerId="kimi"
        capabilities={REMEDY_CAPS}
        providerLabel="kimi"
        cliBinaryResolved
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mcpMocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not attach an in-flight remedy failure to a replacement offer", async () => {
    let rejectWrite: (error: ProviderNativeRpcError) => void = () => {};
    mcpMocks.mutateAsync.mockImplementation(
      () =>
        new Promise(
          (_resolve, reject: (error: ProviderNativeRpcError) => void) => {
            rejectWrite = reject;
          },
        ),
    );
    mcpMocks.listResult.data = {
      servers: [connectedServer({ name: "docs", remedy: TRUST_REMEDY })],
      notices: [],
    };
    const view = renderTab(REMEDY_CAPS, "kimi");
    fireEvent.click(
      screen.getByRole("button", { name: "Trust this folder docs" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: TRUST_REMEDY.label,
      }),
    );

    mcpMocks.listResult.data = {
      servers: [
        connectedServer({
          name: "docs",
          remedy: { ...TRUST_REMEDY, id: "replacement-offer" },
        }),
      ],
      notices: [],
    };
    view.rerender(
      <ProviderMcpTab
        providerId="kimi"
        capabilities={REMEDY_CAPS}
        providerLabel="kimi"
        cliBinaryResolved
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Trust this folder docs" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      rejectWrite(
        new ProviderNativeRpcError({
          code: "external_drift",
          detail: "Earlier offer failed",
          method: "providers.nativeMutate",
        }),
      );
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Trust this folder docs" }),
    );
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.queryByText("Earlier offer failed")).toBeNull();
  });

  it("keeps a valid remedy confirmation retryable after a typed error", async () => {
    mcpMocks.listResult.data = {
      servers: [connectedServer({ name: "docs", remedy: TRUST_REMEDY })],
      notices: [],
    };
    mcpMocks.mutateAsync
      .mockRejectedValueOnce(
        new ProviderNativeRpcError({
          code: "external_drift",
          detail: "An unrelated config entry changed",
          method: "providers.nativeMutate",
        }),
      )
      .mockResolvedValueOnce(undefined);
    renderTab(REMEDY_CAPS, "kimi");

    fireEvent.click(
      screen.getByRole("button", { name: "Trust this folder docs" }),
    );
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: TRUST_REMEDY.label,
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "An unrelated config entry changed",
      ),
    );
    expect(mcpMocks.listResult.refetch).toHaveBeenCalledTimes(1);
    expect(confirm.hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirm);
    expect(mcpMocks.mutateAsync).toHaveBeenCalledTimes(2);
  });

  it("keeps a confirmation when refreshed rows retain the same offer id", () => {
    mcpMocks.listResult.data = { servers: [STDIO_ROW], notices: [] };
    const view = renderTab(REMEDY_CAPS, "kimi");
    fireEvent.click(screen.getByRole("switch", { name: "Enable local-tool" }));

    mcpMocks.listResult.data = {
      servers: [
        {
          ...STDIO_ROW,
          statusDetail: "refreshed",
          enableConfirmation: { ...ENABLE_REMEDY },
        },
      ],
      notices: [],
    };
    view.rerender(
      <ProviderMcpTab
        providerId="kimi"
        capabilities={REMEDY_CAPS}
        providerLabel="kimi"
        cliBinaryResolved
      />,
    );
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Enable",
      }),
    );
    expect(mcpMocks.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      mutation: { action: "applyRemedy", remedyId: ENABLE_REMEDY.id },
    });
  });
});
