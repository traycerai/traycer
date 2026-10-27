import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  SandboxListResponse,
  SandboxPod,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRpcRegistry } from "@/lib/host";
import { AutomationTerminalOpenError } from "@/components/settings/panels/automation-terminal-open-error";
import { AutomationTerminalOpenScope } from "@/components/settings/panels/automation-terminal-open-scope";
import { useOpenAutomationTerminal } from "@/components/settings/panels/use-open-automation-terminal";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";

const AUTOMATION_HOST = "host-automation-returned";
const ROW_HOST = "host-from-row";

const network = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly hostId: string;
    readonly method: string;
    readonly params: unknown;
  }>,
  hostClientLookups: [] as Array<string | null>,
  clients: new Map<string, {
    readonly getActiveHost: () => { readonly hostId: string; readonly websocketUrl: string | null } | null;
    readonly getActiveHostId: () => string | null;
    readonly getRequestContextUserId: () => string | null;
    readonly request: (method: string, params: unknown) => Promise<unknown>;
    readonly requestWithSignal: (method: string, params: unknown, signal: AbortSignal | undefined) => Promise<unknown>;
  }>(),
  directoryEntries: new Map<string, { readonly hostId: string; readonly websocketUrl: string | null; readonly transportDialability: "dialable" } | null>(),
  readyHostIds: new Set<string>(),
  sandboxListData: undefined as SandboxListResponse | null | undefined,
  sandboxListSentAt: null as number | null,
  responses: new Map<string, () => Promise<unknown>>(),
  openSandboxAutomation: vi.fn(),
  refreshDirectory: vi.fn(),
  request: vi.fn<(hostId: string, method: string, params: unknown) => Promise<unknown>>(),
  close: vi.fn(),
  navigate: vi.fn(),
  activateTab: vi.fn(),
  toastFromAuthError: vi.fn(),
  teamPods: new Map(),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    network.hostClientLookups.push(hostId);
    return hostId === null ? null : (network.clients.get(hostId) ?? null);
  },
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) =>
    hostId === null ? null : (network.directoryEntries.get(hostId) ?? null),
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-effective",
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-list-query")
  >()),
  useSandboxList: () => ({ data: network.sandboxListData }),
  sandboxListReadSentAt: (data: SandboxListResponse | null | undefined) =>
    data === network.sandboxListData ? network.sandboxListSentAt : null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-automation-query", () => ({
  useSandboxTeamPods: () => network.teamPods,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({
    auth: { openSandboxAutomation: network.openSandboxAutomation },
    directory: { refresh: network.refreshDirectory },
  }),
}));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: network.toastFromAuthError,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => network.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: network.activateTab,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: network.close }),
}));

function rpcKey(hostId: string, method: string): string {
  return `${hostId}\u0000${method}`;
}

function installHost(hostId: string, ready: boolean): void {
  network.directoryEntries.set(
    hostId,
    ready
      ? {
          hostId,
          websocketUrl: `wss://${hostId}.test/rpc`,
          transportDialability: "dialable",
        }
      : null,
  );
  if (ready) network.readyHostIds.add(hostId);
  else network.readyHostIds.delete(hostId);
  const client = {
    getActiveHost: () => network.directoryEntries.get(hostId) ?? null,
    getActiveHostId: () =>
      network.readyHostIds.has(hostId) ? hostId : null,
    getRequestContextUserId: () =>
      useAuthStore.getState().contextMetadata?.userId ?? null,
    request: (method: string, params: unknown) =>
      network.request(hostId, method, params),
    requestWithSignal: (method: string, params: unknown) =>
      network.request(hostId, method, params),
  };
  network.clients.set(hostId, client);
}

function setHostReady(hostId: string): void {
  installHost(hostId, true);
}

function workspaceBindings(hostId: string): ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listBindingsForEpic"
> {
  return { rows: [], folderlessCwd: `/home/${hostId}` };
}

function plainTerminalList(): ResponseOfMethod<
  HostRpcRegistry,
  "terminal.plain.list"
> {
  return {
    coverage: "complete-local",
    scope: { kind: "independent" },
    terminals: [],
  };
}

function plainTerminalCreate(
  hostId: string,
  terminalId: string,
): ResponseOfMethod<HostRpcRegistry, "terminal.plain.create"> {
  const cwd = `/home/${hostId}`;
  return {
    terminal: {
      record: {
        hostId,
        terminalId,
        scope: { kind: "independent" },
        launch: { cwd },
        manualTitle: null,
        revision: 1,
        createdAt: "2026-10-27T00:00:00Z",
        updatedAt: "2026-10-27T00:00:00Z",
      },
      runtime: {
        status: "running",
        sessionId: terminalId,
        currentCwd: cwd,
        activeProcessName: "zsh",
        cols: 80,
        rows: 24,
      },
    },
  };
}

function plainTerminalCreateParams(
  params: unknown,
): RequestOfMethod<HostRpcRegistry, "terminal.plain.create"> {
  if (
    typeof params !== "object" ||
    params === null ||
    !("terminalId" in params) ||
    typeof params.terminalId !== "string" ||
    !("cwd" in params) ||
    typeof params.cwd !== "string" ||
    !("cols" in params) ||
    typeof params.cols !== "number" ||
    !("rows" in params) ||
    typeof params.rows !== "number" ||
    !("scope" in params) ||
    typeof params.scope !== "object" ||
    params.scope === null ||
    !("kind" in params.scope) ||
    params.scope.kind !== "independent"
  ) {
    throw new Error("terminal.plain.create did not receive a valid request");
  }
  return {
    terminalId: params.terminalId,
    cwd: params.cwd,
    cols: params.cols,
    rows: params.rows,
    scope: { kind: "independent" },
  };
}

function openedSandbox(hostId: string, settled: boolean): {
  readonly kind: "ok";
  readonly sandbox: SandboxSummary;
  readonly settled: boolean;
} {
  return {
    kind: "ok",
    sandbox: sandboxSummaryFixture({
      id: "sbx-automation",
      hostId,
      displayName: "Automations",
      kind: "automation",
      state: "awake",
      burst: false,
    }),
    settled,
  };
}

function hostRpcError(method: string, message: string): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    requestId: `test-${method}`,
    method,
    message,
    fatalDetails: null,
  });
}

type AutomationTerminalInput = Parameters<
  typeof useOpenAutomationTerminal
>[0];

function AutomationTerminalHarness(props: {
  readonly existing: AutomationTerminalInput["existing"];
  readonly teamEnvironmentId?: string | null;
}) {
  const opener = useOpenAutomationTerminal({
    existing: props.existing,
    teamEnvironmentId: props.teamEnvironmentId ?? null,
  });
  return (
    <div>
      <button type="button" onClick={opener.run}>
        Open terminal
      </button>
      {opener.starting ? <span role="status">Opening terminal</span> : null}
      {opener.failed ? (
        <AutomationTerminalOpenError
          onRetry={opener.run}
          pending={opener.starting}
        />
      ) : null}
    </div>
  );
}

function renderHarness(existing: AutomationTerminalInput["existing"]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <AutomationTerminalHarness existing={existing} />
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    queryClient,
    rerenderHarness: () => view.rerender(tree()),
  };
}

function renderTeamScopeHarness(teamEnvironmentId: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <AutomationTerminalOpenScope teamEnvironmentId={teamEnvironmentId}>
        <AutomationTerminalHarness
          existing={null}
          teamEnvironmentId={teamEnvironmentId}
        />
      </AutomationTerminalOpenScope>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    queryClient,
    rerenderHarness: () => view.rerender(tree()),
  };
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

beforeEach(() => {
  network.calls.length = 0;
  network.hostClientLookups.length = 0;
  network.clients.clear();
  network.directoryEntries.clear();
  network.readyHostIds.clear();
  network.sandboxListData = undefined;
  network.sandboxListSentAt = null;
  network.responses.clear();
  network.openSandboxAutomation.mockReset();
  network.refreshDirectory.mockReset();
  network.request.mockReset();
  network.close.mockReset();
  network.navigate.mockReset();
  network.activateTab.mockReset();
  network.toastFromAuthError.mockReset();
  network.teamPods.clear();
  network.navigate.mockReturnValue(new Promise<void>(() => undefined));
  network.request.mockImplementation((hostId, method, params) => {
    network.calls.push({ hostId, method, params });
    const response = network.responses.get(rpcKey(hostId, method));
    if (response !== undefined) return response();
    if (method === "worktree.listBindingsForEpic") {
      return Promise.resolve(workspaceBindings(hostId));
    }
    if (method === "terminal.plain.list") {
      return Promise.resolve(plainTerminalList());
    }
    if (method === "terminal.plain.create") {
      return Promise.resolve(
        plainTerminalCreate(hostId, plainTerminalCreateParams(params).terminalId),
      );
    }
    return Promise.reject(new Error(`Unexpected RPC ${method}`));
  });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  useLandingPanelStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("useOpenAutomationTerminal readiness and stale completions", () => {
  it("waits for a 202 host to become dialable, then routes every request and the durable tab to the returned host", async () => {
    installHost(AUTOMATION_HOST, false);
    network.openSandboxAutomation.mockResolvedValue(
      openedSandbox(AUTOMATION_HOST, false),
    );
    const rendered = renderHarness({
      hostId: ROW_HOST,
      sandboxId: "sbx-row",
      awake: false,
    });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    await waitFor(() => {
      expect(network.hostClientLookups).toContain(AUTOMATION_HOST);
    });
    expect(network.openSandboxAutomation).toHaveBeenCalledWith(null);
    expect(network.calls).toHaveLength(0);
    expect(useLandingPanelStore.getState().tabs).toHaveLength(0);

    setHostReady(AUTOMATION_HOST);
    rendered.rerenderHarness();

    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(network.calls.length).toBeGreaterThanOrEqual(3);
    expect(network.calls.every((call) => call.hostId === AUTOMATION_HOST)).toBe(
      true,
    );
    expect(network.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        "worktree.listBindingsForEpic",
        "terminal.plain.list",
        "terminal.plain.create",
      ]),
    );
    const createCall = network.calls.find(
      (call) => call.method === "terminal.plain.create",
    );
    if (createCall === undefined) throw new Error("no create request was sent");
    const terminalId = plainTerminalCreateParams(createCall.params).terminalId;
    const terminalTab = useLandingPanelStore.getState().tabs[0];
    expect(terminalTab).toMatchObject({
      kind: "terminal",
      hostId: AUTOMATION_HOST,
      cwd: `/home/${AUTOMATION_HOST}`,
      sessionId: terminalId,
      pendingCreate: false,
    });
    expect(createCall.params).toEqual(
      expect.objectContaining({
        cwd: `/home/${AUTOMATION_HOST}`,
        scope: { kind: "independent" },
      }),
    );
  });

  it("shows Retry after a wake failure and starts a terminal when the wake retry succeeds", async () => {
    setHostReady(AUTOMATION_HOST);
    network.openSandboxAutomation
      .mockRejectedValueOnce(new Error("wake failed"))
      .mockResolvedValueOnce(openedSandbox(AUTOMATION_HOST, true));
    renderHarness({ hostId: ROW_HOST, sandboxId: "sbx-row", awake: false });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't open a terminal on Automations.",
    );
    expect(network.calls).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(network.openSandboxAutomation).toHaveBeenCalledTimes(2);
    expect(network.calls.some((call) => call.method === "terminal.plain.create")).toBe(
      true,
    );
  });

  it("shows Retry for a folderless cwd failure and re-reads the binding before creating", async () => {
    setHostReady(AUTOMATION_HOST);
    let bindingReads = 0;
    network.responses.set(rpcKey(AUTOMATION_HOST, "worktree.listBindingsForEpic"), () => {
      bindingReads += 1;
      return bindingReads === 1
        ? Promise.reject(
            hostRpcError("worktree.listBindingsForEpic", "Directory unavailable"),
          )
        : Promise.resolve(workspaceBindings(AUTOMATION_HOST));
    });
    renderHarness({ hostId: AUTOMATION_HOST, sandboxId: "sbx-row", awake: true });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't open a terminal on Automations.",
    );
    expect(
      network.calls.some((call) => call.method === "terminal.plain.create"),
    ).toBe(false);
    expect(network.openSandboxAutomation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(bindingReads).toBe(2);
    expect(network.calls.filter((call) => call.method === "terminal.plain.create")).toHaveLength(1);
  });

  it("disables Retry and shows its spinner while the folderless cwd is being retried", async () => {
    setHostReady(AUTOMATION_HOST);
    const secondRead = deferred<
      ResponseOfMethod<HostRpcRegistry, "worktree.listBindingsForEpic">
    >();
    let bindingReads = 0;
    network.responses.set(
      rpcKey(AUTOMATION_HOST, "worktree.listBindingsForEpic"),
      () => {
        bindingReads += 1;
        return bindingReads === 1
          ? Promise.reject(
              hostRpcError(
                "worktree.listBindingsForEpic",
                "Directory unavailable",
              ),
            )
          : secondRead.promise;
      },
    );
    renderHarness({ hostId: AUTOMATION_HOST, sandboxId: "sbx-row", awake: true });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    await userEvent.click(retry);

    await waitFor(() => {
      expect(retry.hasAttribute("disabled")).toBe(true);
      expect(retry.querySelector('[aria-hidden="true"]')).not.toBeNull();
    });
    expect(bindingReads).toBe(2);
    expect(network.calls.some((call) => call.method === "terminal.plain.create")).toBe(
      false,
    );
    act(() => {
      secondRead.resolve(workspaceBindings(AUTOMATION_HOST));
    });
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
  });

  it("retries a rejected create with the same terminal id and adopts only its successful response", async () => {
    setHostReady(AUTOMATION_HOST);
    const secondCreate = deferred<
      ResponseOfMethod<HostRpcRegistry, "terminal.plain.create">
    >();
    let createCount = 0;
    network.responses.set(
      rpcKey(AUTOMATION_HOST, "terminal.plain.create"),
      () => {
        createCount += 1;
        return createCount === 1
          ? Promise.reject(new Error("Create response was lost"))
          : secondCreate.promise;
      },
    );
    renderHarness({
      hostId: AUTOMATION_HOST,
      sandboxId: "sbx-row",
      awake: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't open a terminal on Automations.",
    );
    expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    expect(network.activateTab).not.toHaveBeenCalled();
    const firstCreate = network.calls.find(
      (call) => call.method === "terminal.plain.create",
    );
    if (firstCreate === undefined) throw new Error("no create request was sent");
    const requestedTerminalId = plainTerminalCreateParams(
      firstCreate.params,
    ).terminalId;

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => {
      expect(createCount).toBe(2);
      expect(retry.hasAttribute("disabled")).toBe(true);
      expect(retry.querySelector('[aria-hidden="true"]')).not.toBeNull();
    });
    const createCalls = network.calls.filter(
      (call) => call.method === "terminal.plain.create",
    );
    expect(createCalls).toHaveLength(2);
    expect(
      plainTerminalCreateParams(createCalls[1].params).terminalId,
    ).toBe(requestedTerminalId);
    expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    expect(network.activateTab).not.toHaveBeenCalled();

    act(() => {
      secondCreate.resolve(
        plainTerminalCreate(AUTOMATION_HOST, requestedTerminalId),
      );
    });
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingPanelStore.getState().tabs[0]).toMatchObject({
      kind: "terminal",
      hostId: AUTOMATION_HOST,
      sessionId: requestedTerminalId,
      pendingCreate: false,
    });
    expect(network.activateTab).toHaveBeenCalledTimes(1);
  });

  it.each([
    { state: "failed" as const, frozen: false },
    { state: "released" as const, frozen: false },
    { state: "awake" as const, frozen: true },
  ])(
    "offers Retry when a fresh Automations row is $state and does not create a terminal",
    async ({ state, frozen }) => {
      installHost(AUTOMATION_HOST, false);
      network.openSandboxAutomation.mockResolvedValue(
        openedSandbox(AUTOMATION_HOST, false),
      );
      const rendered = renderHarness({ existing: null, teamEnvironmentId: null });

      await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
      await waitFor(() => {
        expect(network.hostClientLookups).toContain(AUTOMATION_HOST);
      });
      network.sandboxListData = {
        sandboxes: [
          sandboxSummaryFixture({
            id: "sbx-automation",
            hostId: AUTOMATION_HOST,
            kind: "automation",
            state,
            frozen,
          }),
        ],
      };
      network.sandboxListSentAt = Date.now() + 1;
      rendered.rerenderHarness();

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Couldn't open a terminal on Automations.",
      );
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(
        network.calls.some((call) => call.method === "terminal.plain.create"),
      ).toBe(false);
    },
  );

  it("ignores a failed Automations row from before the click and continues when the host becomes dialable", async () => {
    installHost(AUTOMATION_HOST, false);
    network.sandboxListData = {
      sandboxes: [
        sandboxSummaryFixture({
          id: "sbx-automation",
          hostId: AUTOMATION_HOST,
          kind: "automation",
          state: "failed",
        }),
      ],
    };
    network.sandboxListSentAt = Date.now() - 5_000;
    network.openSandboxAutomation.mockResolvedValue(
      openedSandbox(AUTOMATION_HOST, false),
    );
    const rendered = renderHarness({ existing: null, teamEnvironmentId: null });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    await waitFor(() => {
      expect(network.hostClientLookups).toContain(AUTOMATION_HOST);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      network.calls.some((call) => call.method === "terminal.plain.create"),
    ).toBe(false);

    setHostReady(AUTOMATION_HOST);
    rendered.rerenderHarness();
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(
      network.calls.some((call) => call.method === "terminal.plain.create"),
    ).toBe(true);
  });

  it("retries a first-created team pod by its returned ordinal and opens on its returned host", async () => {
    const teamEnvironmentId = "env-team";
    installHost(AUTOMATION_HOST, false);
    network.openSandboxAutomation
      .mockResolvedValueOnce(openedSandbox(AUTOMATION_HOST, false))
      .mockResolvedValueOnce(openedSandbox(AUTOMATION_HOST, false));
    const rendered = renderTeamScopeHarness(teamEnvironmentId);

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    await waitFor(() => {
      expect(network.hostClientLookups).toContain(AUTOMATION_HOST);
    });
    expect(network.openSandboxAutomation).toHaveBeenCalledWith({
      environmentId: teamEnvironmentId,
      ordinal: null,
    });

    const pod = {
      sandbox: sandboxSummaryFixture({
        id: "sbx-automation",
        hostId: AUTOMATION_HOST,
        kind: "automation",
        state: "awake",
        environmentId: teamEnvironmentId,
      }),
      ordinal: 3,
      liveShells: 0,
      headroom: 1,
    } satisfies SandboxPod;
    network.teamPods.set(teamEnvironmentId, [pod]);
    network.sandboxListData = {
      sandboxes: [
        sandboxSummaryFixture({
          id: pod.sandbox.id,
          hostId: AUTOMATION_HOST,
          kind: "automation",
          state: "failed",
          environmentId: teamEnvironmentId,
        }),
      ],
    };
    network.sandboxListSentAt = Date.now() + 1;
    rendered.rerenderHarness();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't open a terminal on Automations.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(network.openSandboxAutomation).toHaveBeenNthCalledWith(2, {
        environmentId: teamEnvironmentId,
        ordinal: pod.ordinal,
      });
    });

    setHostReady(AUTOMATION_HOST);
    rendered.rerenderHarness();
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingPanelStore.getState().tabs[0]).toMatchObject({
      kind: "terminal",
      hostId: AUTOMATION_HOST,
      cwd: `/home/${AUTOMATION_HOST}`,
      pendingCreate: false,
    });
    expect(
      network.calls.some(
        (call) =>
          call.hostId === AUTOMATION_HOST &&
          call.method === "terminal.plain.create",
      ),
    ).toBe(true);
  });

  it("does not adopt a terminal create response after the opener unmounts", async () => {
    setHostReady(AUTOMATION_HOST);
    const createResponse = deferred<
      ResponseOfMethod<HostRpcRegistry, "terminal.plain.create">
    >();
    network.responses.set(
      rpcKey(AUTOMATION_HOST, "terminal.plain.create"),
      () => createResponse.promise,
    );
    const rendered = renderHarness({
      hostId: AUTOMATION_HOST,
      sandboxId: "sbx-row",
      awake: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    await waitFor(() => {
      expect(
        network.calls.some((call) => call.method === "terminal.plain.create"),
      ).toBe(true);
    });
    const createCall = network.calls.find(
      (call) => call.method === "terminal.plain.create",
    );
    if (createCall === undefined) throw new Error("no create request was sent");
    const terminalId = plainTerminalCreateParams(createCall.params).terminalId;
    expect(rendered.queryClient.isMutating()).toBeGreaterThan(0);
    rendered.unmount();

    act(() => {
      createResponse.resolve(plainTerminalCreate(AUTOMATION_HOST, terminalId));
    });
    await waitFor(() => {
      expect(rendered.queryClient.isMutating()).toBe(0);
    });
    expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    expect(network.close).not.toHaveBeenCalled();
    expect(network.activateTab).not.toHaveBeenCalled();
    expect(network.navigate).not.toHaveBeenCalled();
  });

  it("does not adopt a terminal create response after the signed-in account changes", async () => {
    setHostReady(AUTOMATION_HOST);
    const createResponse = deferred<
      ResponseOfMethod<HostRpcRegistry, "terminal.plain.create">
    >();
    network.responses.set(
      rpcKey(AUTOMATION_HOST, "terminal.plain.create"),
      () => createResponse.promise,
    );
    const rendered = renderHarness({
      hostId: AUTOMATION_HOST,
      sandboxId: "sbx-row",
      awake: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    await waitFor(() => {
      expect(
        network.calls.some((call) => call.method === "terminal.plain.create"),
      ).toBe(true);
    });
    const createCall = network.calls.find(
      (call) => call.method === "terminal.plain.create",
    );
    if (createCall === undefined) throw new Error("no create request was sent");
    const terminalId = plainTerminalCreateParams(createCall.params).terminalId;
    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "u2", username: "grace" },
      });
    });

    act(() => {
      createResponse.resolve(plainTerminalCreate(AUTOMATION_HOST, terminalId));
    });
    await waitFor(() => {
      expect(rendered.queryClient.isMutating()).toBe(0);
    });
    expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    expect(network.close).not.toHaveBeenCalled();
    expect(network.activateTab).not.toHaveBeenCalled();
    expect(network.navigate).not.toHaveBeenCalled();
  });
});
