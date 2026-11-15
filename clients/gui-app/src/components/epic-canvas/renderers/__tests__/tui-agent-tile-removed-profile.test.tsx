import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { StrictMode, useEffect, type ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { providersListResponseSchema } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import {
  pinProfile,
  providerState,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { createAppQueryClient } from "@/lib/query-client";
import {
  armTerminalAgentContinueProfile,
  consumeTerminalAgentContinueProfile,
} from "@/stores/terminals/terminal-agent-continue-profile";

const testHostEntry = { ...mockLocalHostEntry, hostId: "test-host" };
const forkInventory = providersListResponseSchema.parse({
  providers: [
    providerState({
      providerId: "claude-code",
      authStatus: "authenticated",
      profiles: [
        pinProfile({
          profileId: "profile-source",
          label: "Source profile",
          kind: "managed",
          enabled: true,
          authStatus: "authenticated",
          aliases: [],
          personNotice: null,
          terminalOnThisComputer: true,
          otherNames: [],
        }),
      ],
    }),
  ],
  native: null,
  offersSignIns: true,
  removedProfiles: [],
});

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

const tileState = vi.hoisted(() => {
  let origin: "registry" | "cloud" = "registry";
  let harnessSessionId: string | null = "session-1";
  let forkProfileSupported = true;
  let bindingState: "success" | "error" | "pending" = "success";
  let reachability: "reachable" | "unreachable" = "reachable";
  return {
    origin: () => origin,
    harnessSessionId: () => harnessSessionId,
    forkProfileSupported: () => forkProfileSupported,
    bindingState: () => bindingState,
    reachability: () => reachability,
    setOrigin: (next: "registry" | "cloud") => {
      origin = next;
    },
    setHarnessSessionId: (next: string | null) => {
      harnessSessionId = next;
    },
    setForkProfileSupported: (next: boolean) => {
      forkProfileSupported = next;
    },
    setBindingState: (next: "success" | "error" | "pending") => {
      bindingState = next;
    },
    setReachability: (next: "reachable" | "unreachable") => {
      reachability = next;
    },
    reset: () => {
      origin = "registry";
      harnessSessionId = "session-1";
      forkProfileSupported = true;
      bindingState = "success";
      reachability = "reachable";
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
    origin: tileState.origin(),
    title: "Terminal agent",
    profileId: "profile-source",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    hostId: "test-host",
    harnessSessionId: tileState.harnessSessionId(),
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
        origin: "gesture" | "automatic",
      ) => {
        const result = actual.useAgentStartTerminalSession(client, origin);
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
  useWorktreeGetBinding: () => {
    const bindingState = tileState.bindingState();
    const bindingSucceeded = bindingState === "success";
    return {
      data: bindingSucceeded ? { binding: null } : undefined,
      isSuccess: bindingSucceeded,
      isError: bindingState === "error",
      isPending: bindingState === "pending",
    };
  },
}));

vi.mock(
  "@/hooks/agent/use-tui-fork-profile-support",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/agent/use-tui-fork-profile-support")
      >();
    return {
      ...actual,
      useTuiForkProfileSupported: () => tileState.forkProfileSupported(),
    };
  },
);

vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-host-reachability")
    >();
  return {
    ...actual,
    useHostReachability: (): HostReachability => ({
      status: tileState.reachability(),
      hostLabel: "Computer",
      unavailability: null,
      basis: "directory",
      hostKind: "remote",
    }),
  };
});

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="fork-harness-model-picker" />,
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => null,
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
      "providers.list": () => forkInventory,
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

function wrapperFor(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  function TestWrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <TabHostProvider hostId="test-host">{props.children}</TabHostProvider>
        </TooltipProvider>
      </QueryClientProvider>
    );
  }
  return TestWrapper;
}

function renderWithProviders(node: ReactNode): RenderResult {
  const queryClient = createAppQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
    mutations: { retry: false },
  });
  return render(node, { wrapper: wrapperFor(queryClient) });
}

function tileNode(): ReactNode {
  return (
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
    />
  );
}

function renderTile(): RenderResult {
  return renderWithProviders(tileNode());
}

function renderStrictTile(): RenderResult {
  return renderWithProviders(strictTileNode());
}

function strictTileNode(): ReactNode {
  return <StrictMode>{tileNode()}</StrictMode>;
}

function renderStrictDuplicateTiles(): RenderResult {
  return renderWithProviders(
    <StrictMode>
      {tileNode()}
      {tileNode()}
    </StrictMode>,
  );
}

function renderWithClient(): RenderResult {
  const fixture = buildClient("terminal.create", "RPC_ERROR");
  clientSlot.set(fixture.client);
  return renderTile();
}

function armMatchingRequest(): number {
  return armTerminalAgentContinueProfile("test-host", "epic-test", "agent-1");
}

function clearContinueProfileRequest(
  hostId: string,
  epicId: string,
  agentId: string,
): void {
  const cleanupRequestId = armTerminalAgentContinueProfile(
    hostId,
    epicId,
    agentId,
  );
  consumeTerminalAgentContinueProfile(cleanupRequestId);
}

function noContinueDialog(): void {
  expect(
    screen.queryByRole("heading", {
      name: "Continue under another profile",
    }),
  ).toBeNull();
}

describe("<TuiAgentTile /> removed-profile refusals", () => {
  afterEach(() => {
    cleanup();
    hooks.reset();
    tileState.reset();
    clientSlot.clear();
    toastErrors.error.mockClear();
    __resetAppLocalNotificationsStoreForTests();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
    clearContinueProfileRequest("test-host", "epic-test", "agent-1");
    clearContinueProfileRequest("other-host", "epic-test", "agent-1");
    clearContinueProfileRequest("test-host", "other-epic", "agent-1");
    clearContinueProfileRequest("test-host", "epic-test", "other-agent");
    clearContinueProfileRequest("test-host", "epic-test", "another-agent");
  });

  afterAll(() => {
    vi.doUnmock("sonner");
    vi.doUnmock(
      "@/components/home/host-workspace-selector/host-workspace-selector",
    );
    vi.doUnmock("@/lib/host");
    vi.doUnmock("@/hooks/host/use-host-client-for");
    vi.doUnmock("@/hooks/host/use-host-directory-entry");
    vi.doUnmock("@/hooks/agent/use-agent-stop-controls");
    vi.doUnmock("@/lib/epic-selectors");
    vi.doUnmock("@/hooks/agent/use-prepare-tui-launch-mutation");
    vi.doUnmock("@/hooks/terminal/use-terminal-create-mutation");
    vi.doUnmock("@/lib/registries/terminal-session-registry");
    vi.doUnmock("@/stores/epics/canvas/store");
    vi.doUnmock("@/hooks/worktree/use-worktree-get-binding-query");
    vi.doUnmock("@/hooks/agent/use-tui-fork-profile-support");
    vi.doUnmock("@/hooks/agent/use-host-reachability");
    vi.doUnmock("@/components/home/pickers/harness-model-picker");
    vi.doUnmock("@/components/home/pickers/agent-mode-toggle");
    vi.doUnmock("../terminal-grid-measure-probe");
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

  it("opens the existing Continue dialog for one matching ready request", async () => {
    renderWithClient();
    expect(
      screen.getByRole("button", { name: "Fork" }).hasAttribute("disabled"),
    ).toBe(false);

    let requestId = 0;
    await act(async () => {
      requestId = armMatchingRequest();
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("heading", {
        name: "Continue under another profile",
      }),
    ).toBeTruthy();
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);
  });

  it("preserves another agent's queued request while this tile consumes its own", async () => {
    clientSlot.set(buildClient("terminal.create", "RPC_ERROR").client);
    const oldOtherRequestId = armTerminalAgentContinueProfile(
      "test-host",
      "epic-test",
      "another-agent",
    );
    const newerOtherRequestId = armTerminalAgentContinueProfile(
      "test-host",
      "epic-test",
      "another-agent",
    );
    const requestId = armMatchingRequest();
    renderTile();
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("heading", {
        name: "Continue under another profile",
      }),
    ).toBeTruthy();
    expect(consumeTerminalAgentContinueProfile(oldOtherRequestId)).toBe(false);
    expect(consumeTerminalAgentContinueProfile(newerOtherRequestId)).toBe(true);
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);
  });

  it.each([
    {
      target: "host",
      hostId: "other-host",
      epicId: "epic-test",
      agentId: "agent-1",
    },
    {
      target: "epic",
      hostId: "test-host",
      epicId: "other-epic",
      agentId: "agent-1",
    },
    {
      target: "agent",
      hostId: "test-host",
      epicId: "epic-test",
      agentId: "other-agent",
    },
  ])(
    "does not consume a request with a mismatched $target",
    async ({ hostId, epicId, agentId }) => {
      clientSlot.set(buildClient("terminal.create", "RPC_ERROR").client);
      const requestId = armTerminalAgentContinueProfile(
        hostId,
        epicId,
        agentId,
      );
      renderTile();
      await act(async () => {
        await Promise.resolve();
      });

      noContinueDialog();
      expect(consumeTerminalAgentContinueProfile(requestId)).toBe(true);
    },
  );

  it("consumes a matching request once across strict duplicate views and remount", async () => {
    clientSlot.set(buildClient("terminal.create", "RPC_ERROR").client);
    const requestId = armMatchingRequest();
    renderStrictDuplicateTiles();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("heading", {
        name: "Continue under another profile",
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("heading", {
        name: "Continue under another profile",
      }).length,
    ).toBe(1);
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(noContinueDialog);

    await act(async () => {
      cleanup();
      await Promise.resolve();
    });
    renderStrictTile();
    await act(async () => {
      await Promise.resolve();
    });
    noContinueDialog();
  });

  it("does not auto-open after an unsupported request is consumed", async () => {
    tileState.setForkProfileSupported(false);
    const rendered = renderWithClient();
    const trigger = screen.getByRole("button", { name: "More fork options" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    const continueItem = await screen.findByRole("menuitem", {
      name: /^Continue under another profile…/,
    });
    expect(continueItem.getAttribute("aria-disabled")).toBe("true");

    let requestId = 0;
    await act(async () => {
      requestId = armMatchingRequest();
      await Promise.resolve();
    });
    noContinueDialog();
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);

    tileState.setForkProfileSupported(true);
    await act(async () => {
      rendered.rerender(tileNode());
      await Promise.resolve();
    });
    noContinueDialog();
  });

  it("keeps the fork controls disabled without a harness session", async () => {
    tileState.setHarnessSessionId(null);
    const rendered = renderWithClient();
    expect(
      screen.getByRole("button", { name: "Fork" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "More fork options" })
        .hasAttribute("disabled"),
    ).toBe(true);

    let requestId = 0;
    await act(async () => {
      requestId = armMatchingRequest();
      await Promise.resolve();
    });
    noContinueDialog();
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);

    tileState.setHarnessSessionId("session-1");
    await act(async () => {
      rendered.rerender(tileNode());
      await Promise.resolve();
    });
    noContinueDialog();
  });

  it("keeps cloud terminal agents without fork controls or auto-open", async () => {
    tileState.setOrigin("cloud");
    const rendered = renderWithClient();
    expect(
      screen.queryByRole("button", { name: "More fork options" }),
    ).toBeNull();

    let requestId = 0;
    await act(async () => {
      requestId = armMatchingRequest();
      await Promise.resolve();
    });
    noContinueDialog();
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);

    tileState.setOrigin("registry");
    await act(async () => {
      rendered.rerender(tileNode());
      await Promise.resolve();
    });
    noContinueDialog();
  });

  it("consumes a request delivered while the tile has no toolbar", async () => {
    tileState.setReachability("unreachable");
    const rendered = renderTile();
    expect(
      screen.queryByTestId("terminal-agent-pre-launch-toolbar"),
    ).toBeNull();

    let requestId = 0;
    await act(async () => {
      requestId = armMatchingRequest();
      await Promise.resolve();
    });
    noContinueDialog();
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);

    tileState.setReachability("reachable");
    clientSlot.set(buildClient("terminal.create", "RPC_ERROR").client);
    await act(async () => {
      rendered.rerender(tileNode());
      await Promise.resolve();
    });
    noContinueDialog();
  });

  it("does not auto-open after a failed folder binding later resolves", async () => {
    tileState.setBindingState("error");
    const rendered = renderWithClient();
    expect(
      screen.getByRole("button", { name: "Fork" }).hasAttribute("disabled"),
    ).toBe(true);

    let requestId = 0;
    await act(async () => {
      requestId = armMatchingRequest();
      await Promise.resolve();
    });
    noContinueDialog();
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);

    tileState.setBindingState("success");
    await act(async () => {
      rendered.rerender(tileNode());
      await Promise.resolve();
    });
    noContinueDialog();
  });

  it("holds a request through pending binding and opens when binding succeeds", async () => {
    tileState.setBindingState("pending");
    clientSlot.set(buildClient("terminal.create", "RPC_ERROR").client);
    const requestId = armMatchingRequest();
    const rendered = renderStrictTile();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: "Fork" }).hasAttribute("disabled"),
    ).toBe(true);

    noContinueDialog();

    await act(async () => {
      tileState.setBindingState("success");
      rendered.rerender(strictTileNode());
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("heading", {
        name: "Continue under another profile",
      }),
    ).toBeTruthy();
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);
  });

  it("clears a pending request when binding fails and never opens on later success", async () => {
    tileState.setBindingState("pending");
    const rendered = renderWithClient();
    let requestId = 0;
    await act(async () => {
      requestId = armMatchingRequest();
      await Promise.resolve();
    });
    noContinueDialog();

    await act(async () => {
      tileState.setBindingState("error");
      rendered.rerender(tileNode());
      await Promise.resolve();
    });
    noContinueDialog();
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);

    await act(async () => {
      tileState.setBindingState("success");
      rendered.rerender(tileNode());
      await Promise.resolve();
    });
    noContinueDialog();
  });

  it("clears a pending request when the tile unmounts before binding settles", async () => {
    tileState.setBindingState("pending");
    const rendered = renderWithClient();
    let requestId = 0;
    await act(async () => {
      requestId = armMatchingRequest();
      await Promise.resolve();
    });
    noContinueDialog();

    await act(async () => {
      rendered.unmount();
      await Promise.resolve();
    });
    expect(consumeTerminalAgentContinueProfile(requestId)).toBe(false);
    await act(async () => {
      tileState.setBindingState("success");
      renderTile();
      await Promise.resolve();
    });
    noContinueDialog();
  });
});
