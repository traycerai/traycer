import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";

const hookMocks = vi.hoisted(() => ({
  request: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
  openTileInTab: vi.fn(),
  openTileInPane: vi.fn(),
  markArtifactPendingCreate: vi.fn(),
  unmarkArtifactPendingCreate: vi.fn(),
  navigateNested: vi.fn(
    (_epicId: string, _tabId: string, prepare: () => unknown) => prepare(),
  ),
}));

const fakeHostClient = {
  request: hookMocks.request,
  getActiveHostId: () => "host-test",
  onChange: (_cb: () => void) => () => undefined,
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => fakeHostClient,
  useHostBinding: () => ({ hostClient: fakeHostClient }),
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => fakeHostClient,
  useHostBinding: () => ({ hostClient: fakeHostClient }),
}));

// The placeholder open is routed through the nested-focus navigation
// boundary: `navigateNested` is mocked to synchronously invoke `prepare()`
// (mirroring `bundle-open-button.test.tsx`), and the `prepare...FocusTarget`
// store helpers forward to the same `openTileInTab` / `openTileInPane` spies
// the pre-migration tests asserted on directly, so this proves the boundary
// is exercised without rewriting every existing assertion.
vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: <T,>(selector: (s: unknown) => T): T =>
    selector({
      prepareOpenTileInTabFocusTarget: (tabId: string, node: unknown) => {
        hookMocks.openTileInTab(tabId, node);
        return null;
      },
      prepareOpenTileInPaneFocusTarget: (
        tabId: string,
        paneId: string,
        node: unknown,
      ) => {
        hookMocks.openTileInPane(tabId, paneId, node);
        return null;
      },
      markArtifactPendingCreate: hookMocks.markArtifactPendingCreate,
      unmarkArtifactPendingCreate: hookMocks.unmarkArtifactPendingCreate,
    }),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => hookMocks.navigateNested,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import {
  type CreateTuiAgentStatus,
  useCreateTuiAgent,
} from "@/hooks/agent/use-create-tui-agent";
import { peekPreparedTerminalAgentLaunch } from "@/stores/terminals/prepared-terminal-agent-launch-store";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const WORKSPACE_PATH = "/tmp/workspace-a";

function queryClientWrapper(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function QueryClientWrapper(props: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

interface CapturedCall {
  readonly method: string;
  readonly payload: unknown;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const startSessionResponse = {
  harnessSessionId: "harness-session-1",
  terminalShellCommand: "claude",
  terminalShellArgs: ["--resume", "harness-session-1"],
  hostId: "host-test",
  workingDirectory: "/tmp/worktree/feature-x",
  workspaceFolders: [WORKSPACE_PATH],
  worktreeBusyPaths: [],
  harnessId: "claude" as const,
};

function setupSequencedMock(): {
  readonly calls: ReadonlyArray<CapturedCall>;
} {
  const calls: CapturedCall[] = [];
  hookMocks.request.mockImplementation((method, payload) => {
    calls.push({ method, payload });
    if (method === "agent.tui.prepareLaunch") {
      return Promise.resolve(startSessionResponse);
    }
    if (method === "epic.createTuiAgent") {
      return Promise.resolve({
        tuiAgentId:
          (payload as { tuiAgentId?: string | null }).tuiAgentId ?? "server-id",
      });
    }
    return Promise.resolve({ binding: { entries: [] } });
  });
  return { calls };
}

describe("useCreateTuiAgent", () => {
  beforeEach(() => {
    hookMocks.request.mockReset();
    hookMocks.openTileInTab.mockReset();
    hookMocks.openTileInPane.mockReset();
    hookMocks.markArtifactPendingCreate.mockReset();
    hookMocks.unmarkArtifactPendingCreate.mockReset();
    hookMocks.navigateNested.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("Worktree-mode (create) dispatches worktree.create BEFORE agent.tui.prepareLaunch", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/fix-x",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: null,
      });
    });

    const methodOrder = calls.map((call) => call.method);
    const createIdx = methodOrder.indexOf("worktree.create");
    const startIdx = methodOrder.indexOf("agent.tui.prepareLaunch");
    const persistIdx = methodOrder.indexOf("epic.createTuiAgent");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(createIdx);
    expect(persistIdx).toBeGreaterThan(startIdx);

    // The same client-minted id is plumbed through every call so the
    // host's binding row, the harness preparation, and the persisted
    // record all reference one terminal-agent identity.
    const createPayload = calls[createIdx].payload as { ownerId: string };
    const startPayload = calls[startIdx].payload as {
      tuiAgentId: string | null;
      agentMode: string;
    };
    const persistPayload = calls[persistIdx].payload as {
      tuiAgentId: string | null | undefined;
      agentMode: string;
    };
    expect(createPayload.ownerId).toBeTruthy();
    expect(startPayload.tuiAgentId).toBe(createPayload.ownerId);
    expect(persistPayload.tuiAgentId).toBe(createPayload.ownerId);
    expect(startPayload.agentMode).toBe("regular");
    expect(persistPayload.agentMode).toBe("regular");

    queryClient.clear();
  });

  it("forwards edited landing terminal-agent args to prepare and persisted record", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/args-x",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: "--dangerously-skip-permissions",
      });
    });

    const prepareCall = calls.find(
      (c) => c.method === "agent.tui.prepareLaunch",
    );
    const persistCall = calls.find((c) => c.method === "epic.createTuiAgent");
    expect(prepareCall).toBeDefined();
    expect(persistCall).toBeDefined();
    expect(
      (
        prepareCall?.payload as {
          readonly terminalAgentArgs: string | null;
        }
      ).terminalAgentArgs,
    ).toBe("--dangerously-skip-permissions");
    expect(
      (
        persistCall?.payload as {
          readonly terminalAgentArgs: string | null;
        }
      ).terminalAgentArgs,
    ).toBe("--dangerously-skip-permissions");

    queryClient.clear();
  });

  it("fork launches wait for the forked session before opening the canvas placeholder", async () => {
    const calls: CapturedCall[] = [];
    const statuses: CreateTuiAgentStatus[] = [];
    const startState: {
      resolve: ((value: unknown) => void) | null;
    } = { resolve: null };
    hookMocks.request.mockImplementation((method, payload) => {
      calls.push({ method, payload });
      if (method === "agent.tui.prepareLaunch") {
        return new Promise<unknown>((resolve) => {
          startState.resolve = resolve;
        });
      }
      if (method === "epic.createTuiAgent") {
        return Promise.resolve({
          tuiAgentId:
            (payload as { tuiAgentId?: string | null }).tuiAgentId ??
            "server-id",
        });
      }
      return Promise.resolve({ binding: { entries: [] } });
    });
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const createState: {
      promise: Promise<string | null> | null;
    } = { promise: null };
    act(() => {
      createState.promise = result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: "source-parent",
        title: "Fork - Source terminal",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: "claude-sonnet-4",
        reasoningEffort: "high",
        agentMode: "regular",
        forkSourceHarnessSessionId: "source-harness-session",
        onStatusChange: (nextStatus) => statuses.push(nextStatus),
        workspaceMode: "inherit",
        worktreeIntent: null,
        terminalAgentArgs: "--allowedTools Edit",
      });
    });

    await waitFor(() => {
      expect(startState.resolve).not.toBeNull();
    });
    expect(statuses).toEqual(["forking-session"]);
    expect(hookMocks.openTileInTab).not.toHaveBeenCalled();
    expect(hookMocks.markArtifactPendingCreate).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "epic.createTuiAgent")).toBe(false);

    const resolveStartSession = startState.resolve;
    const pendingCreate = createState.promise;
    if (resolveStartSession === null || pendingCreate === null) {
      throw new Error("fork launch did not start");
    }
    await act(async () => {
      resolveStartSession({
        ...startSessionResponse,
        terminalShellArgs: [
          "--resume",
          "source-harness-session",
          "--fork-session",
          "--session-id",
          "harness-session-1",
        ],
      });
      await pendingCreate;
    });

    const prepareCall = calls.find(
      (c) => c.method === "agent.tui.prepareLaunch",
    );
    const persistCall = calls.find((c) => c.method === "epic.createTuiAgent");
    expect(prepareCall).toBeDefined();
    expect(persistCall).toBeDefined();
    const preparePayload = prepareCall?.payload as {
      readonly forkSourceHarnessSessionId: string | null;
      readonly harnessSessionId: string | null;
      readonly terminalAgentArgs: string | null;
    };
    const persistPayload = persistCall?.payload as {
      readonly tuiAgentId: string | null;
      readonly parentId: string | null;
      readonly title: string;
      readonly harnessSessionId: string | null;
      readonly terminalAgentArgs: string | null;
    };
    expect(preparePayload.forkSourceHarnessSessionId).toBe(
      "source-harness-session",
    );
    expect(preparePayload.harnessSessionId).toBeNull();
    expect(preparePayload.terminalAgentArgs).toBe("--allowedTools Edit");
    expect(persistPayload.parentId).toBe("source-parent");
    expect(persistPayload.title).toBe("Fork - Source terminal");
    expect(persistPayload.harnessSessionId).toBe("harness-session-1");
    expect(persistPayload.terminalAgentArgs).toBe("--allowedTools Edit");
    if (persistPayload.tuiAgentId === null) {
      throw new Error("fork create did not pass a client-minted tuiAgentId");
    }
    expect(
      peekPreparedTerminalAgentLaunch(persistPayload.tuiAgentId),
    ).toStrictEqual({
      cwd: "/tmp/worktree/feature-x",
      shellCommand: "claude",
      shellArgs: [
        "--resume",
        "source-harness-session",
        "--fork-session",
        "--session-id",
        "harness-session-1",
      ],
      worktreeBusyPaths: [],
    });
    expect(statuses).toEqual(["forking-session", "starting-terminal"]);
    expect(hookMocks.openTileInTab).toHaveBeenCalledTimes(1);
    expect(hookMocks.openTileInTab).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({
        type: "terminal-agent",
        name: "Fork - Source terminal",
        pendingTuiHarnessId: "claude",
      }),
    );

    queryClient.clear();
  });

  it("opens the canvas tab placeholder BEFORE agent.tui.prepareLaunch blocks on setup", async () => {
    // Acceptance: "landing Worktree-mode terminal-agent navigates and
    // opens/persists a terminal-agent placeholder before setup
    // completion." The hook must call `openTileInTab` before
    // `agent.tui.prepareLaunch` resolves so the user has a visible
    // terminal-agent canvas tab inside the Epic for the entire setup
    // wait. We block `agent.tui.prepareLaunch` on a manual resolver
    // and assert the placeholder is already open at that point.
    const calls: CapturedCall[] = [];
    const startResolvers: Array<(value: unknown) => void> = [];
    hookMocks.request.mockImplementation((method, payload) => {
      calls.push({ method, payload });
      if (method === "agent.tui.prepareLaunch") {
        return new Promise<unknown>((resolve) => {
          startResolvers.push(resolve);
        });
      }
      if (method === "epic.createTuiAgent") {
        return Promise.resolve({
          tuiAgentId:
            (payload as { tuiAgentId?: string | null }).tuiAgentId ??
            "server-id",
        });
      }
      return Promise.resolve({ binding: { entries: [] } });
    });

    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/fix-x",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };

    let createPromise: Promise<string | null> | null = null;
    act(() => {
      createPromise = result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: null,
      });
    });

    // While `agent.tui.prepareLaunch` is still pending the placeholder
    // canvas tab is already opened with the same id we will eventually
    // persist. The harness has not started - `epic.createTuiAgent`
    // is not yet on the wire.
    await waitFor(() => {
      expect(startResolvers.length).toBe(1);
    });
    expect(hookMocks.openTileInTab).toHaveBeenCalledTimes(1);
    const placeholderCall = hookMocks.openTileInTab.mock.calls[0] as [
      string,
      {
        id: string;
        type: string;
        name: string;
        pendingTuiHarnessId: TuiHarnessId | undefined;
      },
    ];
    const placeholderTabId = placeholderCall[0];
    const placeholderNode = placeholderCall[1];
    expect(placeholderTabId).toBe(TAB_ID);
    expect(placeholderNode.type).toBe("terminal-agent");
    expect(placeholderNode.pendingTuiHarnessId).toBe("claude");
    const bindingCall = calls.find((c) => c.method === "worktree.create");
    expect(bindingCall).toBeDefined();
    const worktreeRequestIndex = hookMocks.request.mock.calls.findIndex(
      ([method]) => method === "worktree.create",
    );
    expect(worktreeRequestIndex).toBeGreaterThanOrEqual(0);
    expect(hookMocks.openTileInTab.mock.invocationCallOrder[0]).toBeLessThan(
      hookMocks.request.mock.invocationCallOrder[worktreeRequestIndex],
    );
    const ownerId = (bindingCall?.payload as { ownerId: string }).ownerId;
    expect(placeholderNode.id).toBe(ownerId);
    expect(calls.some((c) => c.method === "epic.createTuiAgent")).toBe(false);

    // Resolve the in-flight setup wait so the create call doesn't leak.
    await act(async () => {
      startResolvers[0](startSessionResponse);
      await createPromise;
    });

    queryClient.clear();
  });

  it("Worktree-mode (import) routes the import entry through one worktree.create BEFORE agent.tui.prepareLaunch", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "import",
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          isPrimary: true,
          worktreePath: "/tmp/worktrees/feature-x",
        },
      ],
    };

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: null,
      });
    });

    const methodOrder = calls.map((call) => call.method);
    // The initial dispatch collapses to a single `worktree.create`; the
    // host's `resolveIntent` routes the `import` entry. No separate
    // `worktree.import` RPC is issued from the initial dispatch.
    expect(methodOrder).not.toContain("worktree.import");
    const createIdx = methodOrder.indexOf("worktree.create");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeLessThan(
      methodOrder.indexOf("agent.tui.prepareLaunch"),
    );
    const createCall = calls[createIdx];
    const createEntries = (
      createCall.payload as { entries: ReadonlyArray<{ kind: string }> }
    ).entries;
    expect(createEntries).toHaveLength(1);
    expect(createEntries[0].kind).toBe("import");

    queryClient.clear();
  });

  it("setup failure: agent.tui.prepareLaunch rejection prevents epic.createTuiAgent", async () => {
    const calls: CapturedCall[] = [];
    hookMocks.request.mockImplementation((method, payload) => {
      calls.push({ method, payload });
      if (method === "agent.tui.prepareLaunch") {
        return Promise.reject(
          new Error("WORKTREE_SETUP_FAILED: setup exited 1"),
        );
      }
      if (method === "epic.createTuiAgent") {
        return Promise.resolve({ tuiAgentId: "server-id" });
      }
      return Promise.resolve({ binding: { entries: [] } });
    });

    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/fix-x",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.create({
          epicId: EPIC_ID,
          tabId: TAB_ID,
          parentId: null,
          title: "",
          placement: { kind: "active-tile" },
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          agentMode: "regular",
          forkSourceHarnessSessionId: null,
          onStatusChange: null,
          workspaceMode: "inherit",
          worktreeIntent: intent,
          terminalAgentArgs: null,
        });
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/WORKTREE_SETUP_FAILED/);

    const methodOrder = calls.map((call) => call.method);
    expect(methodOrder).toContain("worktree.create");
    expect(methodOrder).toContain("agent.tui.prepareLaunch");
    // Harness never starts: the persisted record is never written when
    // setup rejects.
    expect(methodOrder).not.toContain("epic.createTuiAgent");
    // Placeholder canvas tab IS opened before the setup wait so the user
    // is not stranded outside the Epic context on failure. The recovery
    // surface is the placeholder + setup terminal tab + toast - no
    // hidden unrecoverable owner state is created.
    expect(hookMocks.openTileInTab).toHaveBeenCalledTimes(1);
    const createCall = calls.find((c) => c.method === "worktree.create");
    expect(createCall).toBeDefined();
    const placeholderNode = hookMocks.openTileInTab.mock.calls[0][1] as {
      id: string;
      type: string;
    };
    expect(placeholderNode.id).toBe(
      (createCall?.payload as { ownerId: string }).ownerId,
    );
    expect(placeholderNode.type).toBe("terminal-agent");

    queryClient.clear();
  });

  it("setup cancellation: agent.tui.prepareLaunch cancellation prevents epic.createTuiAgent", async () => {
    const calls: CapturedCall[] = [];
    hookMocks.request.mockImplementation((method, payload) => {
      calls.push({ method, payload });
      if (method === "agent.tui.prepareLaunch") {
        return Promise.reject(
          new Error("WORKTREE_SETUP_CANCELLED: setup terminal killed"),
        );
      }
      if (method === "epic.createTuiAgent") {
        return Promise.resolve({ tuiAgentId: "server-id" });
      }
      return Promise.resolve({ binding: { entries: [] } });
    });

    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/fix-x",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };

    await act(async () => {
      try {
        await result.current.create({
          epicId: EPIC_ID,
          tabId: TAB_ID,
          parentId: null,
          title: "",
          placement: { kind: "active-tile" },
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          agentMode: "regular",
          forkSourceHarnessSessionId: null,
          onStatusChange: null,
          workspaceMode: "inherit",
          worktreeIntent: intent,
          terminalAgentArgs: null,
        });
      } catch {
        // expected
      }
    });

    const methodOrder = calls.map((call) => call.method);
    expect(methodOrder).not.toContain("epic.createTuiAgent");
    // Same recovery-surface invariant on cancellation: the placeholder
    // is visible inside the Epic context even though the harness never
    // launched and no record was persisted.
    expect(hookMocks.openTileInTab).toHaveBeenCalledTimes(1);
    const placeholderNode = hookMocks.openTileInTab.mock.calls[0][1] as {
      type: string;
    };
    expect(placeholderNode.type).toBe("terminal-agent");

    queryClient.clear();
  });

  it("Local mode (intent === null) launches normally without worktree.* dispatch", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: null,
        terminalAgentArgs: null,
      });
    });

    const methodOrder = calls.map((call) => call.method);
    expect(methodOrder).not.toContain("worktree.create");
    expect(methodOrder).not.toContain("worktree.import");
    expect(methodOrder).not.toContain("worktree.setLocal");
    // Existing two-step launch path still runs in order.
    expect(methodOrder.indexOf("agent.tui.prepareLaunch")).toBeLessThan(
      methodOrder.indexOf("epic.createTuiAgent"),
    );
    expect(hookMocks.openTileInTab).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });

  it("Local-intent with empty entries skips host worktree calls (the prepare-launch seam seeds the default binding)", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    // Mode-only intent with no entries - prepareLaunch's host seam
    // (`materializeDefaultBinding`) seeds the default owner-scoped Local binding
    // from the epic's folders when it sees no row, so no per-entry worktree call
    // needs to fire here.
    const intent: WorktreeIntent = {
      entries: [],
    };

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: null,
      });
    });

    const methodOrder = calls.map((call) => call.method);
    expect(methodOrder).not.toContain("worktree.setLocal");
    expect(methodOrder).not.toContain("worktree.setEntryMode");
    expect(methodOrder).not.toContain("worktree.create");
    expect(methodOrder).not.toContain("worktree.import");
    expect(methodOrder).toContain("agent.tui.prepareLaunch");

    queryClient.clear();
  });

  it("Local-intent with entries routes the local entry through one worktree.create BEFORE agent.tui.prepareLaunch", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/workspace/app",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: null,
      });
    });

    const methodOrder = calls.map((call) => call.method);
    // The initial dispatch no longer fans `local` out to `worktree.setEntryMode`;
    // it sends one `worktree.create` carrying the local entry for the host to
    // route.
    expect(methodOrder).not.toContain("worktree.setEntryMode");
    const createIdx = methodOrder.indexOf("worktree.create");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeLessThan(
      methodOrder.indexOf("agent.tui.prepareLaunch"),
    );
    const createEntries = (
      calls[createIdx].payload as { entries: ReadonlyArray<{ kind: string }> }
    ).entries;
    expect(createEntries).toHaveLength(1);
    expect(createEntries[0].kind).toBe("local");

    queryClient.clear();
  });

  it("mixed intent issues a SINGLE worktree.create carrying all entries (no separate import / setEntryMode calls)", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/workspace/app",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/mixed-x",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
        {
          kind: "local",
          workspacePath: "/workspace/docs",
          repoIdentifier: null,
          isPrimary: false,
        },
        {
          kind: "import",
          workspacePath: "/workspace/lib",
          repoIdentifier: { owner: "traycerai", repo: "lib" },
          isPrimary: false,
          worktreePath: "/tmp/worktrees/lib-x",
        },
      ],
    };

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: null,
      });
    });

    const createCalls = calls.filter((c) => c.method === "worktree.create");
    expect(createCalls).toHaveLength(1);
    expect(calls.some((c) => c.method === "worktree.import")).toBe(false);
    expect(calls.some((c) => c.method === "worktree.setEntryMode")).toBe(false);
    const createEntries = (
      createCalls[0].payload as {
        entries: ReadonlyArray<{ kind: string; workspacePath: string }>;
      }
    ).entries;
    expect(createEntries.map((entry) => entry.kind)).toEqual([
      "worktree",
      "local",
      "import",
    ]);

    queryClient.clear();
  });

  it("persists binding-derived workspaceFolders (primary first) onto the terminal-agent record", async () => {
    // Host has already projected the binding entries into the
    // `agent.tui.prepareLaunch` response with the primary worktree
    // path at index 0. The hook must forward that array verbatim to
    // `epic.createTuiAgent` so reopen and workspace-folder detection both
    // run from the bound worktree path.
    const calls: CapturedCall[] = [];
    hookMocks.request.mockImplementation((method, payload) => {
      calls.push({ method, payload });
      if (method === "agent.tui.prepareLaunch") {
        return Promise.resolve({
          ...startSessionResponse,
          workingDirectory: "/tmp/worktrees/feature-x",
          workspaceFolders: [
            "/tmp/worktrees/feature-x",
            "/tmp/worktrees/sibling-y",
          ],
        });
      }
      if (method === "epic.createTuiAgent") {
        return Promise.resolve({
          tuiAgentId:
            (payload as { tuiAgentId?: string | null }).tuiAgentId ??
            "server-id",
        });
      }
      return Promise.resolve({ binding: { entries: [] } });
    });

    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/x",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: null,
      });
    });

    const persistCall = calls.find((c) => c.method === "epic.createTuiAgent");
    expect(persistCall).toBeDefined();
    const persistPayload = persistCall?.payload as {
      readonly workspaceFolders: readonly string[];
    };
    expect([...persistPayload.workspaceFolders]).toEqual([
      "/tmp/worktrees/feature-x",
      "/tmp/worktrees/sibling-y",
    ]);

    queryClient.clear();
  });

  it("successful binding: persisted record uses the same id as the binding RPC", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/launch-x",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };

    let returned: string | null = null;
    await act(async () => {
      returned = await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: null,
      });
    });

    const createCall = calls.find((c) => c.method === "worktree.create");
    const persistCall = calls.find((c) => c.method === "epic.createTuiAgent");
    expect(createCall).toBeDefined();
    expect(persistCall).toBeDefined();
    const ownerId = (createCall?.payload as { ownerId: string }).ownerId;
    const persistedId = (
      persistCall?.payload as { tuiAgentId: string | null | undefined }
    ).tuiAgentId;
    expect(persistedId).toBe(ownerId);
    expect(returned).toBe(ownerId);
    expect(hookMocks.openTileInTab).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({ id: ownerId, type: "terminal-agent" }),
    );

    queryClient.clear();
  });

  it("routes the active-tile placeholder open through the nested-focus navigation boundary", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: null,
        terminalAgentArgs: null,
      });
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(hookMocks.navigateNested).toHaveBeenCalledTimes(1);
    expect(hookMocks.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      TAB_ID,
      expect.any(Function),
    );
    // The boundary's prepared target actually reached the tab-targeted
    // opener, not the pane-targeted one.
    expect(hookMocks.openTileInTab).toHaveBeenCalledTimes(1);
    expect(hookMocks.openTileInPane).not.toHaveBeenCalled();

    queryClient.clear();
  });

  it("routes the target-group placeholder open through prepareOpenTileInPaneFocusTarget via the navigation boundary", async () => {
    const { calls } = setupSequencedMock();
    const queryClient = makeQueryClient();
    const { result } = renderHook(() => useCreateTuiAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });
    const groupId = "group-1";

    await act(async () => {
      await result.current.create({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        parentId: null,
        title: "",
        placement: { kind: "target-group", groupId },
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        workspaceMode: "inherit",
        worktreeIntent: null,
        terminalAgentArgs: null,
      });
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(hookMocks.navigateNested).toHaveBeenCalledTimes(1);
    expect(hookMocks.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      TAB_ID,
      expect.any(Function),
    );
    expect(hookMocks.openTileInPane).toHaveBeenCalledTimes(1);
    expect(hookMocks.openTileInPane).toHaveBeenCalledWith(
      TAB_ID,
      groupId,
      expect.objectContaining({ type: "terminal-agent" }),
    );
    expect(hookMocks.openTileInTab).not.toHaveBeenCalled();

    queryClient.clear();
  });
});
