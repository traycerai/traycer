import type {
  ProviderMcpCapabilities,
  ProviderMcpServer,
} from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProvidersListRequest,
  ProvidersNativeMutateResponse,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  type RenderResult,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { ProviderMcpTab } from "@/components/settings/panels/provider-mcp-tab";
import type { McpListData } from "@/hooks/providers/native-response-map";
import { useProvidersMcpDiscover } from "@/hooks/providers/use-providers-mcp-discover-mutation";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useProvidersMcpMutate } from "@/hooks/providers/use-providers-mcp-mutate-mutation";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";
import { useProvidersWorkspaceSelectionStore } from "@/stores/settings/providers-workspace-selection-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

const runtimeMocks = vi.hoisted(() => ({
  addressableHostId: "host-a",
  client: null as HostClient<HostRpcRegistry> | null,
}));

const workspaceMocks = vi.hoisted(() => ({
  folders: [] as ReadonlyArray<{
    kind: "local-only";
    path: string;
    name: string;
  }>,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => {
    if (runtimeMocks.client === null) {
      throw new Error("test host client is not installed");
    }
    return runtimeMocks.client;
  },
  useHostBinding: () => ({ hostClient: runtimeMocks.client }),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => runtimeMocks.addressableHostId,
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({
    folders: workspaceMocks.folders,
    isLoading: false,
    isFetching: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: { workspaces: [] },
    isPending: false,
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActionsForClient: () => ({
    isPreparing: false,
    isRemoving: false,
    prepareFoldersMutation: null,
    removeEpicRepoMutation: null,
    pickAndPrepareFolders: vi.fn(),
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

vi.mock("@/hooks/providers/use-providers-mcp-auth-mutation", () => ({
  useProvidersMcpAuth: () => ({ mutate: vi.fn(), isPending: false }),
}));

const toastMocks = vi.hoisted(() => ({ errors: [] as string[] }));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (_error: unknown, fallback: string) => {
    toastMocks.errors.push(fallback);
  },
}));

vi.mock("@/components/settings/panels/provider-mcp-add-dialog", () => ({
  ProviderMcpAddDialog: () => null,
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

const GLOBAL = "global";
const PROJECT = "project";
const HOST_A = "host-a";
const HOST_B = "host-b";
const WORKSPACE_A = "/workspace-a";
const WORKSPACE_B = "/workspace-b";

const CAPS: ProviderMcpCapabilities = {
  transports: ["stdio", "http"],
  authTypes: ["none", "header", "oauth"],
  authActions: ["login", "logout"],
  actionScopes: {
    list: [GLOBAL, PROJECT],
    add: [GLOBAL, PROJECT],
    update: [GLOBAL, PROJECT],
    remove: [GLOBAL, PROJECT],
    toggleServer: [GLOBAL, PROJECT],
    toggleTool: [GLOBAL, PROJECT],
    discover: [GLOBAL, PROJECT],
    auth: [GLOBAL, PROJECT],
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

function server(name: string): ProviderMcpServer {
  return {
    name,
    enabled: true,
    transport: {
      type: "http",
      url: `https://${name}.example.test/mcp`,
      auth: null,
    },
    status: "connected",
    statusSource: "probe",
    statusDetail: null,
    tools: [],
    discoveryPending: false,
    instructions: null,
    configOnly: false,
    stdioDegraded: false,
  };
}

function discoveredServer(name: string): ProviderMcpServer {
  return {
    ...server(name),
    tools: [
      {
        name: "search_docs",
        description: "Search documentation",
        inputSchema: null,
        enabled: true,
        readOnly: false,
      },
    ],
  };
}

function pollingServer(name: string): ProviderMcpServer {
  return { ...server(name), discoveryPending: true };
}

type ListOutcome =
  | { readonly kind: "success"; readonly servers: readonly ProviderMcpServer[] }
  | { readonly kind: "error"; readonly error: Error }
  | {
      readonly kind: "pending";
      readonly promise: Promise<ProvidersListResponse>;
    };

interface ListKey {
  readonly hostId: string;
  readonly providerId: string;
  readonly scope: string;
  readonly workspaceRoot: string | null;
}

function listKey(args: ListKey): string {
  return [
    args.hostId,
    args.providerId,
    args.scope,
    args.workspaceRoot ?? "∅",
  ].join("|");
}

function listResponse(
  servers: readonly ProviderMcpServer[],
): ProvidersListResponse {
  return {
    providers: [],
    native: { ok: true, kind: "mcp", servers: [...servers] },
  };
}

function mutateResponse(
  servers: readonly ProviderMcpServer[],
): ProvidersNativeMutateResponse {
  return { result: { ok: true, kind: "mcp", servers: [...servers] } };
}

function discoverResponse(
  serverValue: ProviderMcpServer,
): ProvidersListResponse {
  return {
    providers: [],
    native: { ok: true, kind: "mcpDiscover", server: serverValue },
  };
}

interface Fixture {
  readonly clients: ReadonlyMap<string, HostClient<HostRpcRegistry>>;
  readonly discoverRequestCount: () => number;
  readonly listRequestCount: () => number;
  readonly mutateRequestCount: () => number;
  readonly mutateRequestHosts: () => readonly string[];
  readonly enqueue: (key: ListKey, outcome: ListOutcome) => void;
  readonly enqueueMutate: (outcome: MutationOutcome) => void;
  readonly enqueueDiscover: (outcome: DiscoverOutcome) => void;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

type MutationOutcome =
  | { readonly kind: "success"; readonly servers: readonly ProviderMcpServer[] }
  | { readonly kind: "error"; readonly error: Error }
  | {
      readonly kind: "pending";
      readonly promise: Promise<ProvidersNativeMutateResponse>;
    };

type DiscoverOutcome =
  | { readonly kind: "success"; readonly server: ProviderMcpServer }
  | { readonly kind: "error"; readonly error: Error }
  | {
      readonly kind: "pending";
      readonly promise: Promise<ProvidersListResponse>;
    };

function createFixture(): Fixture {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });
  const outcomes = new Map<string, ListOutcome[]>();
  const mutateOutcomes: MutationOutcome[] = [];
  const discoverOutcomes: DiscoverOutcome[] = [];
  let discoverRequestCount = 0;
  let listRequestCount = 0;
  let mutateRequestCount = 0;
  const mutateRequestHosts: string[] = [];

  const enqueue = (key: ListKey, outcome: ListOutcome): void => {
    const current = outcomes.get(listKey(key)) ?? [];
    current.push(outcome);
    outcomes.set(listKey(key), current);
  };

  const enqueueMutate = (outcome: MutationOutcome): void => {
    mutateOutcomes.push(outcome);
  };

  const enqueueDiscover = (outcome: DiscoverOutcome): void => {
    discoverOutcomes.push(outcome);
  };

  const createClient = (hostId: string): HostClient<HostRpcRegistry> => {
    const entry: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId,
      label: hostId,
    };
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (candidate) => (candidate === hostId ? entry : null),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => `${hostId}-request`,
        handlers: {
          "providers.list": (params: ProvidersListRequest) => {
            const native = params.native;
            if (native?.kind !== "mcp" && native?.kind !== "mcpDiscover") {
              return listResponse([]);
            }
            if (native.kind === "mcpDiscover") {
              discoverRequestCount += 1;
              const outcome = discoverOutcomes.shift() ?? {
                kind: "success" as const,
                server: server(native.serverName),
              };
              if (outcome.kind === "error") throw outcome.error;
              if (outcome.kind === "pending") return outcome.promise;
              return discoverResponse(outcome.server);
            }
            listRequestCount += 1;
            const queued = outcomes.get(
              listKey({
                hostId,
                providerId: native.providerId,
                scope: native.scope,
                workspaceRoot: native.workspaceRoot,
              }),
            );
            const outcome = queued?.shift() ?? {
              kind: "success" as const,
              servers: [],
            };
            if (outcome.kind === "error") throw outcome.error;
            if (outcome.kind === "pending") return outcome.promise;
            return listResponse(outcome.servers);
          },
          "providers.nativeMutate": () => {
            mutateRequestCount += 1;
            mutateRequestHosts.push(hostId);
            const outcome = mutateOutcomes.shift() ?? {
              kind: "success" as const,
              servers: [],
            };
            if (outcome.kind === "error") throw outcome.error;
            if (outcome.kind === "pending") return outcome.promise;
            return mutateResponse(outcome.servers);
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    return spine.createRequester(entry);
  };

  const clients = new Map<string, HostClient<HostRpcRegistry>>([
    [HOST_A, createClient(HOST_A)],
    [HOST_B, createClient(HOST_B)],
  ]);

  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    clients,
    discoverRequestCount: () => discoverRequestCount,
    listRequestCount: () => listRequestCount,
    mutateRequestCount: () => mutateRequestCount,
    mutateRequestHosts: () => mutateRequestHosts,
    enqueue,
    enqueueMutate,
    enqueueDiscover,
    queryClient,
    Wrapper,
  };
}

function renderTab(
  fixture: Fixture,
  providerId: "codex" | "cursor",
): RenderResult {
  const client = fixture.clients.get(runtimeMocks.addressableHostId);
  if (client === undefined) throw new Error("missing fixture client");
  runtimeMocks.client = client;
  return render(
    <ProviderMcpTab
      providerId={providerId}
      capabilities={CAPS}
      providerLabel={providerId}
      cliBinaryResolved
    />,
    { wrapper: fixture.Wrapper },
  );
}

function globalKey(hostId: string, providerId: string): ListKey {
  return { hostId, providerId, scope: GLOBAL, workspaceRoot: null };
}

function projectKey(
  hostId: string,
  providerId: string,
  workspaceRoot: string,
): ListKey {
  return { hostId, providerId, scope: PROJECT, workspaceRoot };
}

function scopeTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /^MCP config location/ });
}

function chooseScopeOption(name: RegExp): void {
  fireEvent.click(scopeTrigger());
  fireEvent.click(screen.getByRole("option", { name }));
}

async function refetchMcpList(fixture: Fixture): Promise<void> {
  await act(async () => {
    await fixture.queryClient.refetchQueries({
      type: "active",
      predicate: (query) =>
        query.queryKey.includes("providers.list") &&
        query.queryKey.includes("mcp"),
    });
  });
}

describe("<ProviderMcpTab /> stale MCP refresh integration", () => {
  beforeEach(() => {
    runtimeMocks.addressableHostId = HOST_A;
    runtimeMocks.client = null;
    workspaceMocks.folders = [];
    toastMocks.errors = [];
    useProvidersWorkspaceSelectionStore.setState({ selectedByHostId: {} });
    useWorkspaceFoldersStore.setState({ byHost: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps cached rows and the stale warning when refresh rejects, including after filtering to zero matches", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("cached-server")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("host refresh failed"),
    });
    renderTab(fixture, "codex");

    await screen.findByText("cached-server");
    await refetchMcpList(fixture);

    await screen.findByText("Couldn't refresh MCP servers");
    expect(screen.getByText("cached-server")).toBeDefined();
    expect(screen.getByText(/Showing the last known servers/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Search servers" }), {
      target: { value: "does-not-match" },
    });
    expect(
      screen.getByText("No servers match “does-not-match”."),
    ).toBeDefined();
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
  });

  it("shows only the initial error and Retry when the first list fails", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("initial list failed"),
    });
    renderTab(fixture, "codex");

    await screen.findByText("Couldn't load MCP servers");
    expect(screen.queryByText("No MCP servers")).toBeNull();
    expect(screen.queryByText("Loading MCP servers")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("disables Retry while a retry is pending, then replaces rows and clears stale state on success", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("old-server")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("temporary list failure"),
    });
    let resolveRetry: ((response: ProvidersListResponse) => void) | null = null;
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        resolveRetry = resolve;
      }),
    });
    renderTab(fixture, "codex");

    await screen.findByText("old-server");
    await refetchMcpList(fixture);
    await screen.findByText("Couldn't refresh MCP servers");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(true));
    expect(retry.querySelector("[aria-hidden='true']")).not.toBeNull();

    await act(() => {
      resolveRetry?.(listResponse([server("new-server")]));
      return Promise.resolve();
    });
    await screen.findByText("new-server");
    expect(screen.queryByText("old-server")).toBeNull();
    expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps confirmed rows, stale warning, and Retry through actual mutation pending and failure", async () => {
    const fixture = createFixture();
    const staleServer = server("stale-server");
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [staleServer],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("list refresh failed"),
    });
    let rejectMutation: ((reason: Error) => void) | null = null;
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>(
        (_resolve, reject) => {
          rejectMutation = (reason: Error) => reject(reason);
        },
      ),
    });
    let resolveRetry: ((response: ProvidersListResponse) => void) | null = null;
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        resolveRetry = resolve;
      }),
    });
    renderTab(fixture, "codex");

    await screen.findByText("stale-server");
    await refetchMcpList(fixture);
    await screen.findByText("Couldn't refresh MCP servers");

    const toggle = screen.getByRole("switch", {
      name: "Disable stale-server",
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();

    await act(() => {
      rejectMutation?.(new Error("mutation failed"));
      return Promise.resolve();
    });
    await waitFor(() =>
      expect(toastMocks.errors).toContain("Couldn't update MCP server."),
    );
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(
      screen.getByRole("switch", { name: "Disable stale-server" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => {
      expect(retry.hasAttribute("disabled")).toBe(true);
      expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
      expect(screen.getByText("stale-server")).toBeDefined();
    });

    await act(() => {
      resolveRetry?.(listResponse([server("fresh-server")]));
      return Promise.resolve();
    });
    await screen.findByText("fresh-server");
    expect(screen.queryByText("stale-server")).toBeNull();
    expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull();
  });

  it("keeps stale warning and Retry after actual single-row discovery writes the list cache", async () => {
    const fixture = createFixture();
    const refreshedServer = discoveredServer("stale-server");
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("stale-server")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("list refresh failed"),
    });
    let resolveDiscover: ((response: ProvidersListResponse) => void) | null =
      null;
    fixture.enqueueDiscover({
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        resolveDiscover = resolve;
      }),
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("fresh-server")],
    });
    renderTab(fixture, "codex");

    await screen.findByText("stale-server");
    await refetchMcpList(fixture);
    await screen.findByText("Couldn't refresh MCP servers");

    const refreshButton = screen.getByRole("button", {
      name: "Refresh stale-server",
    });
    fireEvent.click(refreshButton);
    await waitFor(() => {
      expect(refreshButton.hasAttribute("disabled")).toBe(true);
      expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    await act(() => {
      resolveDiscover?.(discoverResponse(refreshedServer));
      return Promise.resolve();
    });
    await screen.findByText("1 tool");
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("fresh-server");
    expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull();
  });

  it("keeps refresh error when a mutation writes authoritative rows until a full read", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("stale-server")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("list refresh failed"),
    });
    fixture.enqueueMutate({
      kind: "success",
      servers: [server("authoritative-server")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("authoritative-server")],
    });
    renderTab(fixture, "codex");

    await screen.findByText("stale-server");
    await refetchMcpList(fixture);
    await screen.findByText("Couldn't refresh MCP servers");
    fireEvent.click(
      screen.getByRole("switch", { name: "Disable stale-server" }),
    );

    await screen.findByText("authoritative-server");
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    const key = providersNativeQueryKeys.mcpList(HOST_A, {
      providerId: "codex",
      scope: GLOBAL,
      workspaceRoot: null,
    });
    expect(fixture.queryClient.getQueryState(key)?.isInvalidated).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fixture.listRequestCount()).toBe(3));
    await waitFor(() =>
      expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull(),
    );
    await screen.findByText("authoritative-server");
    expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull();
    expect(fixture.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it("keeps a successful toggle through a stale refresh until explicit Retry recovers", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("list refresh failed"),
    });
    let resolveRetry: ((response: ProvidersListResponse) => void) | null = null;
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        resolveRetry = resolve;
      }),
    });
    let resolveToggle:
      | ((response: ProvidersNativeMutateResponse) => void)
      | null = null;
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        resolveToggle = resolve;
      }),
    });
    renderTab(fixture, "codex");

    await screen.findByText("server-a");
    const toggle = screen.getByRole("switch", { name: "Disable server-a" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(true));

    await refetchMcpList(fixture);
    await screen.findByText("Couldn't refresh MCP servers");
    await act(() => {
      resolveToggle?.(
        mutateResponse([{ ...server("server-a"), enabled: false }]),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.hasAttribute("disabled")).toBe(false);
      expect(screen.getByText("server-a")).toBeDefined();
      expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
      expect(
        screen
          .getByRole("switch", { name: "Enable server-a" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    expect(
      screen
        .getByRole("switch", { name: "Enable server-a" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    await act(() => {
      resolveRetry?.(listResponse([server("server-b")]));
      return Promise.resolve();
    });
    await screen.findByText("server-b");
    expect(screen.queryByText("server-a")).toBeNull();
    expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull();
  });

  it("keeps a successful toggle and added row when a later Retry also fails", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("intervening list refresh failed"),
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("retry list refresh failed"),
    });
    let resolveToggle:
      | ((response: ProvidersNativeMutateResponse) => void)
      | null = null;
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        resolveToggle = resolve;
      }),
    });
    renderTab(fixture, "codex");

    await screen.findByText("server-a");
    fireEvent.click(screen.getByRole("switch", { name: "Disable server-a" }));
    await waitFor(() => expect(fixture.mutateRequestCount()).toBe(1));
    await refetchMcpList(fixture);
    await screen.findByText("Couldn't refresh MCP servers");
    await act(() => {
      resolveToggle?.(
        mutateResponse([
          { ...server("server-a"), enabled: false },
          server("server-b"),
        ]),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Enable server-a" }),
      ).toBeDefined();
      expect(
        screen
          .getByRole("switch", { name: "Enable server-a" })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(screen.getByText("server-b")).toBeDefined();
      expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fixture.listRequestCount()).toBe(3));
    await screen.findByText("retry list refresh failed");
    await waitFor(() => {
      expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
      expect(
        screen
          .getByRole("switch", { name: "Enable server-a" })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(screen.getByText("server-b")).toBeDefined();
    });
    expect(
      screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("applies concurrent mutations for both rows before a failed list refresh", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a"), server("server-b")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("list refresh failed after mutations"),
    });
    let resolveFirst:
      | ((response: ProvidersNativeMutateResponse) => void)
      | null = null;
    let resolveSecond:
      | ((response: ProvidersNativeMutateResponse) => void)
      | null = null;
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        resolveFirst = resolve;
      }),
    });
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        resolveSecond = resolve;
      }),
    });
    renderTab(fixture, "codex");
    await screen.findByText("server-a");
    await screen.findByText("server-b");

    const mutateRendered = renderHook(() => useProvidersMcpMutate(), {
      wrapper: fixture.Wrapper,
    });
    let firstPromise: Promise<unknown> | null = null;
    let secondPromise: Promise<unknown> | null = null;
    act(() => {
      firstPromise = mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        mutation: { action: "toggleServer", name: "server-a", enabled: false },
        suppressToast: undefined,
      });
      secondPromise = mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        mutation: { action: "toggleServer", name: "server-b", enabled: false },
        suppressToast: undefined,
      });
    });
    await waitFor(() => expect(fixture.mutateRequestCount()).toBe(2));

    await act(async () => {
      resolveFirst?.(
        mutateResponse([
          { ...server("server-a"), enabled: false },
          server("server-b"),
        ]),
      );
      await firstPromise;
    });
    await act(async () => {
      resolveSecond?.(
        mutateResponse([
          { ...server("server-a"), enabled: false },
          { ...server("server-b"), enabled: false },
        ]),
      );
      await secondPromise;
    });

    expect(fixture.mutateRequestHosts()).toEqual([HOST_A, HOST_A]);
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Enable server-a" })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(
        screen
          .getByRole("switch", { name: "Enable server-b" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });

    await screen.findByText("Couldn't refresh MCP servers");
    expect(screen.getByText("server-a")).toBeDefined();
    expect(screen.getByText("server-b")).toBeDefined();
    expect(
      screen
        .getByRole("switch", { name: "Enable server-a" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "Enable server-b" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("reconciles an older same-row mutation after a newer identical response", async () => {
    const fixture = createFixture();
    const key = providersNativeQueryKeys.mcpList(HOST_A, {
      providerId: "codex",
      scope: GLOBAL,
      workspaceRoot: null,
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a")],
    });
    interface PendingResponses {
      firstMutation: ((response: ProvidersNativeMutateResponse) => void) | null;
      secondMutation:
        | ((response: ProvidersNativeMutateResponse) => void)
        | null;
      list: ((response: ProvidersListResponse) => void) | null;
    }
    const pending: PendingResponses = {
      firstMutation: null,
      secondMutation: null,
      list: null,
    };
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        pending.firstMutation = resolve;
      }),
    });
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        pending.secondMutation = resolve;
      }),
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        pending.list = resolve;
      }),
    });
    renderTab(fixture, "codex");

    await screen.findByText("server-a");
    const initialData = fixture.queryClient.getQueryData<McpListData>(key);
    if (initialData === undefined) throw new Error("missing initial MCP data");
    const mutateRendered = renderHook(() => useProvidersMcpMutate(), {
      wrapper: fixture.Wrapper,
    });
    let firstPromise: Promise<unknown> | null = null;
    let secondPromise: Promise<unknown> | null = null;
    act(() => {
      firstPromise = mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        mutation: { action: "toggleServer", name: "server-a", enabled: false },
        suppressToast: undefined,
      });
      secondPromise = mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        mutation: { action: "toggleServer", name: "server-a", enabled: true },
        suppressToast: undefined,
      });
    });
    await waitFor(() => expect(fixture.mutateRequestCount()).toBe(2));

    await act(async () => {
      pending.secondMutation?.(mutateResponse([server("server-a")]));
      await secondPromise;
    });
    expect(fixture.queryClient.getQueryData<McpListData>(key)?.servers).toBe(
      initialData.servers,
    );

    await act(async () => {
      pending.firstMutation?.(
        mutateResponse([{ ...server("server-a"), enabled: false }]),
      );
      await firstPromise;
    });
    await waitFor(() => expect(fixture.listRequestCount()).toBe(2));

    await act(() => {
      pending.list?.(listResponse([server("server-a")]));
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Disable server-a" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
  });

  it("applies a late concurrent mutation response, then converges on a successful full read", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a"), server("server-b")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("concurrent reconciliation failed"),
    });
    let resolveFirst:
      | ((response: ProvidersNativeMutateResponse) => void)
      | null = null;
    let resolveSecond:
      | ((response: ProvidersNativeMutateResponse) => void)
      | null = null;
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        resolveFirst = resolve;
      }),
    });
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        resolveSecond = resolve;
      }),
    });
    renderTab(fixture, "codex");
    await screen.findByText("server-a");
    await screen.findByText("server-b");

    const mutateRendered = renderHook(() => useProvidersMcpMutate(), {
      wrapper: fixture.Wrapper,
    });
    let firstPromise: Promise<unknown> | null = null;
    let secondPromise: Promise<unknown> | null = null;
    act(() => {
      firstPromise = mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        mutation: { action: "toggleServer", name: "server-a", enabled: false },
        suppressToast: undefined,
      });
      secondPromise = mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        mutation: { action: "toggleServer", name: "server-b", enabled: false },
        suppressToast: undefined,
      });
    });
    await waitFor(() => expect(fixture.mutateRequestCount()).toBe(2));

    // Generation stamps were intentionally removed: completion order is
    // last-write-wins until a successful full read reconciles the catalog.
    await act(async () => {
      resolveSecond?.(
        mutateResponse([
          server("server-a"),
          { ...server("server-b"), enabled: false },
        ]),
      );
      await secondPromise;
    });
    await act(async () => {
      resolveFirst?.(
        mutateResponse([
          { ...server("server-a"), enabled: false },
          server("server-b"),
        ]),
      );
      await firstPromise;
    });

    await screen.findByText("Couldn't refresh MCP servers");
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Enable server-a" })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(
        screen
          .getByRole("switch", { name: "Disable server-b" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [
        { ...server("server-a"), enabled: false },
        { ...server("server-b"), enabled: false },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fixture.listRequestCount()).toBe(3));
    await waitFor(() =>
      expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull(),
    );
    await screen.findByRole("switch", { name: "Enable server-a" });
    await screen.findByRole("switch", { name: "Enable server-b" });
    expect(
      screen
        .getByRole("switch", { name: "Enable server-a" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "Enable server-b" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull();
  });

  it("keeps identical complete polling data referentially stable", async () => {
    const fixture = createFixture();
    const key = providersNativeQueryKeys.mcpList(HOST_A, {
      providerId: "codex",
      scope: GLOBAL,
      workspaceRoot: null,
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [pollingServer("server-a")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [pollingServer("server-a")],
    });

    const client = fixture.clients.get(HOST_A);
    if (client === undefined) throw new Error("missing fixture client");
    runtimeMocks.client = client;
    const rendered = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: GLOBAL,
          workspaceRoot: null,
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.data?.servers).toHaveLength(1),
    );
    const initialData = rendered.result.current.data;
    const initialDataUpdateCount =
      fixture.queryClient.getQueryState<McpListData>(key)?.dataUpdateCount ?? 0;
    await waitFor(() => expect(fixture.listRequestCount()).toBe(2), {
      timeout: 2000,
    });
    await waitFor(
      () =>
        expect(
          fixture.queryClient.getQueryState<McpListData>(key)?.dataUpdateCount,
        ).toBeGreaterThan(initialDataUpdateCount),
      { timeout: 2000 },
    );
    expect(fixture.queryClient.getQueryData<McpListData>(key)).toBe(
      initialData,
    );
    expect(rendered.result.current.data).toBe(initialData);
  });

  it("merges discovery during an identical poll and reconciles a changed target row", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a"), server("server-b")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a"), { ...server("server-b"), enabled: false }],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [{ ...server("server-a"), enabled: false }, server("server-b")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("reconciled-server")],
    });
    let resolveFirst: ((response: ProvidersListResponse) => void) | null = null;
    let resolveSecond: ((response: ProvidersListResponse) => void) | null =
      null;
    fixture.enqueueDiscover({
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        resolveFirst = resolve;
      }),
    });
    fixture.enqueueDiscover({
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        resolveSecond = resolve;
      }),
    });
    renderTab(fixture, "codex");
    await screen.findByText("server-a");
    await screen.findByText("server-b");

    const discoverRendered = renderHook(() => useProvidersMcpDiscover(), {
      wrapper: fixture.Wrapper,
    });
    let firstPromise: Promise<unknown> | null = null;
    act(() => {
      firstPromise = discoverRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        serverName: "server-a",
        forceRefresh: false,
      });
    });
    await waitFor(() => expect(fixture.discoverRequestCount()).toBe(1));
    await refetchMcpList(fixture);
    await screen.findByRole("switch", { name: "Enable server-b" });
    await act(async () => {
      resolveFirst?.(discoverResponse(discoveredServer("server-a")));
      await firstPromise;
    });
    await screen.findByText("1 tool");
    expect(screen.getByText("server-b")).toBeDefined();

    let secondPromise: Promise<unknown> | null = null;
    act(() => {
      secondPromise = discoverRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        serverName: "server-a",
        forceRefresh: true,
      });
    });
    await waitFor(() => expect(fixture.discoverRequestCount()).toBe(2));
    await refetchMcpList(fixture);
    await screen.findByRole("switch", { name: "Enable server-a" });
    await act(async () => {
      resolveSecond?.(discoverResponse(discoveredServer("server-a")));
      await secondPromise;
    });

    await screen.findByText("reconciled-server");
    expect(fixture.listRequestCount()).toBe(4);
    expect(screen.queryByText("1 tool")).toBeNull();
  });

  it("does not seed a partial list while an active complete read has no data", async () => {
    const fixture = createFixture();
    interface PendingList {
      resolve: ((response: ProvidersListResponse) => void) | null;
    }
    const pendingList: PendingList = { resolve: null };
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        pendingList.resolve = resolve;
      }),
    });
    const client = fixture.clients.get(HOST_A);
    if (client === undefined) throw new Error("missing fixture client");
    runtimeMocks.client = client;
    const listRendered = renderHook(
      () =>
        useProvidersMcpList({
          providerId: "codex",
          scope: GLOBAL,
          workspaceRoot: null,
          enabled: true,
          pollWhilePending: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(fixture.listRequestCount()).toBe(1));

    const discoverRendered = renderHook(() => useProvidersMcpDiscover(), {
      wrapper: fixture.Wrapper,
    });
    fixture.enqueueDiscover({
      kind: "success",
      server: discoveredServer("orphan-server"),
    });
    await act(async () => {
      await discoverRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        serverName: "orphan-server",
        forceRefresh: true,
      });
    });

    const key = providersNativeQueryKeys.mcpList(HOST_A, {
      providerId: "codex",
      scope: GLOBAL,
      workspaceRoot: null,
    });
    expect(fixture.queryClient.getQueryData<McpListData>(key)).toBeUndefined();
    pendingList.resolve?.(listResponse([]));
    await waitFor(() =>
      expect(listRendered.result.current.data?.servers).toEqual([]),
    );
    expect(listRendered.result.current.data?.servers).toEqual([]);
  });

  it("does not create a list query when discovery has no eligible cache", async () => {
    const fixture = createFixture();
    const client = fixture.clients.get(HOST_A);
    if (client === undefined) throw new Error("missing fixture client");
    runtimeMocks.client = client;
    fixture.enqueueDiscover({
      kind: "success",
      server: discoveredServer("orphan-server"),
    });
    const discoverRendered = renderHook(() => useProvidersMcpDiscover(), {
      wrapper: fixture.Wrapper,
    });
    await act(async () => {
      await discoverRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        serverName: "orphan-server",
        forceRefresh: true,
      });
    });

    const key = providersNativeQueryKeys.mcpList(HOST_A, {
      providerId: "codex",
      scope: GLOBAL,
      workspaceRoot: null,
    });
    expect(fixture.queryClient.getQueryData<McpListData>(key)).toBeUndefined();
    expect(fixture.queryClient.getQueryState(key)).toBeUndefined();
    expect(fixture.listRequestCount()).toBe(0);
  });

  it("preserves a refresh error through discovery and a successful toggle until Retry", async () => {
    const fixture = createFixture();
    const key = providersNativeQueryKeys.mcpList(HOST_A, {
      providerId: "codex",
      scope: GLOBAL,
      workspaceRoot: null,
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("refresh outage"),
    });
    fixture.enqueueDiscover({
      kind: "success",
      server: discoveredServer("server-a"),
    });
    fixture.enqueueMutate({
      kind: "success",
      servers: [{ ...discoveredServer("server-a"), enabled: false }],
    });
    renderTab(fixture, "codex");

    await screen.findByText("server-a");
    await refetchMcpList(fixture);
    await screen.findByText("Couldn't refresh MCP servers");
    fireEvent.click(screen.getByRole("button", { name: "Refresh server-a" }));
    await screen.findByText("1 tool");
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    expect(fixture.queryClient.getQueryState(key)?.isInvalidated).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Disable server-a" }));
    await screen.findByRole("switch", { name: "Enable server-a" });
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    expect(fixture.queryClient.getQueryState(key)?.isInvalidated).toBe(true);

    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [{ ...server("server-a"), enabled: false }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fixture.listRequestCount()).toBe(3));
    await waitFor(() =>
      expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull(),
    );
    await screen.findByRole("switch", { name: "Enable server-a" });
    expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull();
  });

  it("applies a successful mutation before its deferred reconciliation settles", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("server-a")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("refresh before deferred reconciliation"),
    });
    let rejectRetry: ((reason: Error) => void) | null = null;
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((_resolve, reject) => {
        rejectRetry = (reason: Error) => reject(reason);
      }),
    });
    let rejectReplacement: ((reason: Error) => void) | null = null;
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((_resolve, reject) => {
        rejectReplacement = (reason: Error) => reject(reason);
      }),
    });
    let resolveMutation:
      | ((response: ProvidersNativeMutateResponse) => void)
      | null = null;
    fixture.enqueueMutate({
      kind: "pending",
      promise: new Promise<ProvidersNativeMutateResponse>((resolve) => {
        resolveMutation = resolve;
      }),
    });
    renderTab(fixture, "codex");

    await screen.findByText("server-a");
    await refetchMcpList(fixture);
    await screen.findByText("Couldn't refresh MCP servers");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    const mutateRendered = renderHook(() => useProvidersMcpMutate(), {
      wrapper: fixture.Wrapper,
    });
    let mutationPromise: Promise<unknown> | null = null;
    act(() => {
      mutationPromise = mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: GLOBAL,
        workspaceRoot: null,
        mutation: { action: "toggleServer", name: "server-a", enabled: false },
        suppressToast: undefined,
      });
    });
    await waitFor(() => expect(fixture.mutateRequestCount()).toBe(1));

    await act(async () => {
      resolveMutation?.(
        mutateResponse([{ ...server("server-a"), enabled: false }]),
      );
      await mutationPromise;
    });
    await waitFor(() =>
      expect(mutateRendered.result.current.isPending).toBe(false),
    );
    await waitFor(() => expect(fixture.listRequestCount()).toBe(4));
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Enable server-a" })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
    });

    await act(async () => {
      rejectReplacement?.(new Error("deferred reconciliation failed"));
      rejectRetry?.(new Error("original reconciliation canceled"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("deferred reconciliation failed");
    expect(
      screen
        .getByRole("switch", { name: "Enable server-a" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText("Couldn't refresh MCP servers")).toBeDefined();
  });

  it("keeps Retry enabled during a background read and does not cancel it on ticks", async () => {
    const fixture = createFixture();
    let resolveBackground: ((response: ProvidersListResponse) => void) | null =
      null;
    let resolveRetry: ((response: ProvidersListResponse) => void) | null = null;
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [pollingServer("server-a")],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("background poll failed"),
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        resolveBackground = resolve;
      }),
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>((resolve) => {
        resolveRetry = resolve;
      }),
    });

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      renderTab(fixture, "codex");
      await screen.findByText("server-a");
      await act(async () => {
        vi.advanceTimersByTime(800);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await screen.findByText("Couldn't refresh MCP servers");

      await act(async () => {
        vi.advanceTimersByTime(800);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(fixture.listRequestCount()).toBe(3);
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.hasAttribute("disabled")).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(800);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(fixture.listRequestCount()).toBe(3);

      fireEvent.click(retry);
      await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(true));
      await waitFor(() => expect(fixture.listRequestCount()).toBe(4));
      await act(async () => {
        vi.advanceTimersByTime(800);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(fixture.listRequestCount()).toBe(4);
      await act(async () => {
        resolveBackground?.(listResponse([server("server-a")]));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        resolveRetry?.(listResponse([server("server-b")]));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await screen.findByText("server-b");
      expect(screen.queryByText("Couldn't refresh MCP servers")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn a previously empty successful list into a fresh absence after refresh fails", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [],
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "error",
      error: new Error("empty refresh failed"),
    });
    renderTab(fixture, "codex");

    await screen.findByText("No MCP servers");
    await refetchMcpList(fixture);

    await screen.findByText("Couldn't refresh MCP servers");
    expect(
      screen.getByText(
        "The last successful list had no MCP servers. Retry to check for changes.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("No MCP servers")).toBeNull();
  });

  it("drops prior provider rows while the new provider query key is pending", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("codex-host-a")],
    });
    fixture.enqueue(globalKey(HOST_A, "cursor"), {
      kind: "pending",
      promise: new Promise<ProvidersListResponse>(() => undefined),
    });
    const view = renderTab(fixture, "codex");
    await screen.findByText("codex-host-a");

    view.rerender(
      <ProviderMcpTab
        providerId="cursor"
        capabilities={CAPS}
        providerLabel="cursor"
        cliBinaryResolved
      />,
    );
    await screen.findByText("Loading MCP servers");
    expect(screen.queryByText("codex-host-a")).toBeNull();
  });

  it("drops prior host rows while the new host query key is errored", async () => {
    const fixture = createFixture();
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("host-a-server")],
    });
    runtimeMocks.addressableHostId = HOST_B;
    fixture.enqueue(globalKey(HOST_B, "codex"), {
      kind: "error",
      error: new Error("host-b list failed"),
    });
    runtimeMocks.addressableHostId = HOST_A;
    const view = renderTab(fixture, "codex");
    await screen.findByText("host-a-server");
    runtimeMocks.addressableHostId = HOST_B;
    const hostBClient = fixture.clients.get(HOST_B);
    if (hostBClient === undefined) throw new Error("missing host-b client");
    runtimeMocks.client = hostBClient;
    view.rerender(
      <ProviderMcpTab
        providerId="codex"
        capabilities={CAPS}
        providerLabel="codex"
        cliBinaryResolved
      />,
    );
    await screen.findByText("Couldn't load MCP servers");
    expect(screen.queryByText("host-a-server")).toBeNull();
  });

  it("drops prior workspace rows while the new workspace query key is errored", async () => {
    const fixture = createFixture();
    workspaceMocks.folders = [
      { kind: "local-only", path: WORKSPACE_A, name: "workspace-a" },
      { kind: "local-only", path: WORKSPACE_B, name: "workspace-b" },
    ];
    useWorkspaceFoldersStore.setState({
      byHost: {
        [HOST_A]: {
          folders: [WORKSPACE_A, WORKSPACE_B],
          folderInfoByPath: {
            [WORKSPACE_A]: {
              path: WORKSPACE_A,
              name: "workspace-a",
              repoIdentifier: null,
              hostId: HOST_A,
            },
            [WORKSPACE_B]: {
              path: WORKSPACE_B,
              name: "workspace-b",
              repoIdentifier: null,
              hostId: HOST_A,
            },
          },
          primaryPath: null,
        },
      },
    });
    fixture.enqueue(globalKey(HOST_A, "codex"), {
      kind: "success",
      servers: [server("global-server")],
    });
    fixture.enqueue(projectKey(HOST_A, "codex", WORKSPACE_A), {
      kind: "success",
      servers: [server("project-a-server")],
    });
    fixture.enqueue(projectKey(HOST_A, "codex", WORKSPACE_B), {
      kind: "error",
      error: new Error("workspace list failed"),
    });
    renderTab(fixture, "codex");
    await screen.findByText("global-server");
    chooseScopeOption(/workspace-a/);
    await screen.findByText("project-a-server");
    chooseScopeOption(/workspace-b/);

    await screen.findByText("Couldn't load MCP servers");
    expect(screen.queryByText("project-a-server")).toBeNull();
  });
});
