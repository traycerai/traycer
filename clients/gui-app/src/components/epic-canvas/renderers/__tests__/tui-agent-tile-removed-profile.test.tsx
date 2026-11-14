import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import type { HostRpcRegistry } from "@/lib/host";

const testHostEntry = { ...mockLocalHostEntry, hostId: "test-host" };

const hooks = vi.hoisted(() => {
  let prepareError: unknown = null;
  let createError: unknown = null;
  return {
    getPrepareError: () => prepareError,
    getCreateError: () => createError,
    setPrepareError: (error: unknown) => {
      prepareError = error;
    },
    setCreateError: (error: unknown) => {
      createError = error;
    },
    reset: () => {
      prepareError = null;
      createError = null;
    },
  };
});

const clientSlot = vi.hoisted(() => {
  let client: unknown = null;
  return {
    get: () => client,
    set: (next: unknown) => {
      client = next;
    },
    clear: () => {
      client = null;
    },
  };
});

const toastErrors = vi.hoisted(() => ({
  error: vi.fn<(message: unknown) => void>(),
}));

vi.mock("sonner", () => {
  const toast = vi.fn();
  return {
    toast: Object.assign(toast, {
      error: toastErrors.error,
      success: vi.fn(),
      warning: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => null,
    useHostDirectory: () => ({
      findById: (hostId: string) =>
        hostId === testHostEntry.hostId ? testHostEntry : null,
      onChange: () => ({ dispose: () => undefined }),
    }),
  };
});

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => clientSlot.get(),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => testHostEntry,
}));

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: () => ({
    id: "agent-1",
    harnessId: "claude",
    title: "Terminal agent",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    hostId: "test-host",
    harnessSessionId: "session-1",
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: [],
    workspaceFolders: [],
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
  }),
}));

vi.mock(
  "@/hooks/agent/use-prepare-tui-launch-mutation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/agent/use-prepare-tui-launch-mutation")
      >();
    return {
      ...actual,
      useAgentStartTerminalSession: (
        client: HostClient<HostRpcRegistry> | null,
      ) => {
        const result = actual.useAgentStartTerminalSession(client);
        useEffect(() => hooks.setPrepareError(result.error), [result.error]);
        return result;
      },
    };
  },
);

vi.mock(
  "@/hooks/terminal/use-terminal-create-mutation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/terminal/use-terminal-create-mutation")
      >();
    return {
      ...actual,
      useTerminalCreate: (client: HostClient<HostRpcRegistry> | null) => {
        const result = actual.useTerminalCreate(client);
        useEffect(() => hooks.setCreateError(result.error), [result.error]);
        return result;
      },
    };
  },
);

vi.mock(
  "@/lib/registries/terminal-session-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/registries/terminal-session-registry")
    >()),
    useTerminalSessionHandle: () => null,
  }),
);

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({ closeCanvasTab: () => undefined }),
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({ data: { binding: null } }),
}));

vi.mock("../terminal-grid-measure-probe", () => ({
  TerminalGridMeasureProbe: ({
    onMeasured,
  }: {
    readonly onMeasured: (cols: number, rows: number) => void;
  }) => {
    useEffect(() => onMeasured(80, 24), [onMeasured]);
    return null;
  },
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";
import { hostRpcRegistry } from "@/lib/host";

interface TileHostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
}

function buildClient(
  failureMethod: "agent.tui.prepareLaunch" | "terminal.create",
  failureCode: "removed-by-person" | "RPC_ERROR",
): TileHostFixture {
  const error = new HostRpcError({
    code: failureCode,
    message: 'No profile "work" is registered for provider "claude-code".',
    requestId: "req-1",
    method: failureMethod,
    fatalDetails: null,
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: {
      "terminal.list": () => ({ sessions: [], homeCwd: "/home" }),
      "agent.tui.prepareLaunch": () => {
        if (failureMethod === "agent.tui.prepareLaunch") throw error;
        return {
          harnessId: "claude",
          harnessSessionId: "session-1",
          terminalShellCommand: "claude",
          terminalShellArgs: [],
          hostId: "test-host",
          workingDirectory: "/home",
          workspaceFolders: [],
          worktreeBusyPaths: [],
        };
      },
      "terminal.create": () => {
        if (failureMethod === "terminal.create") throw error;
        throw new Error("terminal.create was not expected");
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === testHostEntry.hostId ? testHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    client: spine.createRequester(testHostEntry),
    messenger,
  };
}

function errorCode(error: unknown): string | null {
  if (error instanceof HostRpcError) return error.code;
  return null;
}

function withQueryClient(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TabHostProvider hostId="test-host">{node}</TabHostProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function renderTile(): void {
  render(
    withQueryClient(
      <TuiAgentTile
        viewTabId="tab-test"
        node={{
          id: "agent-1",
          instanceId: "inst-agent-1",
          type: "terminal-agent",
          name: "terminal-agent",
          hostId: "test-host",
        }}
        tileId="tile-1"
        isActive
      />,
    ),
  );
}

describe("<TuiAgentTile /> removed-profile refusals", () => {
  afterEach(() => {
    cleanup();
    hooks.reset();
    clientSlot.clear();
    toastErrors.error.mockClear();
    __resetAppLocalNotificationsStoreForTests();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  const removedProfileFailureCases: ReadonlyArray<{
    readonly label: string;
    readonly method: "agent.tui.prepareLaunch" | "terminal.create";
    readonly code: "removed-by-person";
  }> = [
    {
      label: "prepareLaunch",
      method: "agent.tui.prepareLaunch",
      code: "removed-by-person",
    },
    {
      label: "terminal.create",
      method: "terminal.create",
      code: "removed-by-person",
    },
  ];

  it.each(removedProfileFailureCases)(
    "shows the removed-profile recovery after $label is refused",
    async ({ method, code }) => {
      const fixture = buildClient(method, code);
      clientSlot.set(fixture.client);
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
      renderTile();

      if (method === "agent.tui.prepareLaunch") {
        await waitFor(() =>
          expect(errorCode(hooks.getPrepareError())).toBe("removed-by-person"),
        );
      } else {
        await waitFor(() =>
          expect(errorCode(hooks.getCreateError())).toBe("removed-by-person"),
        );
      }

      expect(screen.getByText("Was removed")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
      expect(screen.queryByText(/Failed to start terminal/)).toBeNull();
      const methods = fixture.messenger.calls.map((call) => call.method);
      expect(methods).toContain(method);
      if (method === "agent.tui.prepareLaunch") {
        const warnings = toastErrors.error.mock.calls.map(
          ([message]) => message,
        );
        expect(warnings).toContain("Was removed");
      }
    },
  );

  it("keeps the generic failure sentence for another code with the same message", async () => {
    const fixture = buildClient("agent.tui.prepareLaunch", "RPC_ERROR");
    clientSlot.set(fixture.client);
    renderTile();

    await waitFor(() =>
      expect(errorCode(hooks.getPrepareError())).toBe("RPC_ERROR"),
    );
    expect(
      screen.getByText(
        'Failed to start terminal: No profile "work" is registered for provider "claude-code".',
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Was removed")).toBeNull();
    const methods = fixture.messenger.calls.map((call) => call.method);
    expect(methods).toContain("agent.tui.prepareLaunch");
  });
});
