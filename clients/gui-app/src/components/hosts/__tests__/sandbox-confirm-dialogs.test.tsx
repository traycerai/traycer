import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithProviders,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SandboxSessionReport } from "@/lib/sandboxes/sandbox-row-lines";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import { EMPTY_FOCUS_MODEL } from "@/lib/home-focus/build-focus-model";
import type { FocusModel } from "@/lib/home-focus/focus-model";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import type {
  SandboxBatchResult,
  SandboxDestroyBatchRequest,
} from "@/hooks/sandboxes/use-sandbox-destroy-batch-mutation";
import {
  agentSessionFixture,
  liveSessionReport,
  sandboxSummaryFixture,
  terminalSessionFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const mocks = vi.hoisted(() => ({
  report: { kind: "unknown" } as SandboxSessionReport,
  configuration: { kind: "personal" } as SandboxPageConfiguration,
  focusModel: null as FocusModel | null,
  handles: [] as TerminalSessionStoreHandle[],
  handleHosts: new WeakMap<TerminalSessionStoreHandle, string>(),
  openTile: vi.fn<(intent: TileOpenIntent) => NestedFocusTarget | null>(),
  routeNotification: vi.fn<(navigate: unknown, target: unknown) => boolean>(),
  destroyMutate: vi.fn<(variables: undefined, options: object) => void>(),
  batch: {
    isPending: false,
    mutate:
      vi.fn<
        (
          request: SandboxDestroyBatchRequest,
          options: {
            readonly onSuccess: (
              results: readonly SandboxBatchResult[],
            ) => void;
          },
        ) => void
      >(),
    reset: vi.fn(),
  },
}));

vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({ report: mocks.report, failed: false }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-configurations", () => ({
  useSandboxConfigurations: () => ({
    configurations: [mocks.configuration],
    teamEnvironmentIds: new Set<string>(),
    complete: true,
  }),
  sandboxConfigurationOf: () => mocks.configuration,
  useSandboxWakeString: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-keep-mutation", () => ({
  useSandboxKeep: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-patch-mutation", () => ({
  useSandboxPatch: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-destroy-batch-mutation", () => ({
  useSandboxDestroyBatch: () => mocks.batch,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-destroy-mutation", () => ({
  useSandboxDestroy: () => ({
    isPending: false,
    mutate: mocks.destroyMutate,
  }),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/home-focus/use-focus-model", () => ({
  useFocusModel: () => mocks.focusModel,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: mocks.openTile }),
}));
vi.mock("@/lib/notifications", () => ({
  routeNotificationForHost: (navigate: unknown, target: unknown) =>
    mocks.routeNotification(navigate, target),
}));
vi.mock("@/lib/registries/terminal-session-registry", () => ({
  getTerminalSessionRegistry: () => ({
    listHandles: () => mocks.handles,
    subscribe: () => () => undefined,
  }),
  getTerminalSessionHandleHostId: (handle: TerminalSessionStoreHandle) =>
    mocks.handleHosts.get(handle) ?? null,
}));

import {
  SandboxDestroyAllIdleDialog,
  SandboxDestroyDialog,
  SandboxIdleSettingsDialog,
  SandboxKeepDialog,
  SandboxStopDialog,
  SandboxSuspendDialog,
} from "@/components/hosts/sandbox-confirm-dialogs";

const NAME = "build-box";
const SANDBOX = sandboxSummaryFixture({ displayName: NAME, state: "awake" });

function render(element: ReactElement) {
  const client = new QueryClient();
  return renderWithProviders(element, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

function sessionsLine(): string {
  return screen.getByTestId("sandbox-confirm-sessions-line").textContent;
}

describe("sandbox confirm dialogs", () => {
  beforeEach(() => {
    mocks.report = { kind: "unknown" };
    mocks.configuration = { kind: "personal" };
    mocks.focusModel = EMPTY_FOCUS_MODEL;
    mocks.handles = [];
    mocks.handleHosts = new WeakMap();
    mocks.openTile.mockReset();
    mocks.routeNotification.mockReset();
    mocks.destroyMutate.mockReset();
    mocks.batch.mutate.mockReset();
  });
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("says how many sessions are running, with the caption", () => {
    mocks.report = liveSessionReport(
      {
        agents: [agentSessionFixture({})],
        terminals: [
          terminalSessionFixture({ sessionId: "t1", name: "build" }),
          terminalSessionFixture({ sessionId: "t2", name: "tests" }),
        ],
      },
      true,
    );
    render(
      <SandboxSuspendDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />,
    );
    // The count, then each session's pill.
    expect(sessionsLine()).toBe("3 sessions runningPlannerbuildtests");
    expect(
      screen.getByTestId("sandbox-confirm-sessions").textContent,
    ).toContain(
      "Known running agents and Task terminals. Other sessions may also be interrupted.",
    );
  });

  describe("the named sessions", () => {
    const HOST_ID = SANDBOX.hostId;

    function focusAgents(
      agents: ReadonlyArray<{
        readonly agentId: string;
        readonly title: string;
        readonly hostId: string;
      }>,
    ): void {
      mocks.focusModel = {
        ...EMPTY_FOCUS_MODEL,
        tasks: [
          {
            epicId: "epic-1",
            taskTitle: null,
            mountedHere: true,
            needsYou: false,
            stoppable: true,
            agents: agents.map((agent) => ({
              ...agent,
              surface: "chat",
              tier: "turn",
              parentId: null,
              hostUnattributed: false,
              stoppable: true,
            })),
          },
        ],
      };
    }

    function openTerminal(title: string, hostId: string): void {
      const handle = createTerminalSessionStore({
        scope: { kind: "epic", epicId: "epic-1" },
        sessionId: "term-1",
        cols: 80,
        rows: 24,
        reattachMode: "fresh",
        kind: "terminal",
        viewer: "presentation",
        streamClientFactory: () => ({
          sendAction: () => undefined,
          close: () => undefined,
        }),
      });
      handle.store.setState({ status: "running", kind: "terminal", title });
      mocks.handles = [handle];
      mocks.handleHosts.set(handle, hostId);
      useEpicCanvasStore.setState({
        tabsById: {
          "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic" },
        },
        canvasByTabId: {
          "tab-1": {
            root: null,
            activePaneId: null,
            sizesByGroupId: {},
            tilesByInstanceId: {
              "inst-1": {
                id: "term-1",
                instanceId: "inst-1",
                type: "terminal",
                name: "Shell",
                titleSource: "default",
                hostId,
                cwd: "/repo",
              },
            },
          },
        },
      });
    }

    it("lists a running agent on the sandbox's host and not one on another", () => {
      focusAgents([
        { agentId: "a1", title: "Planner", hostId: HOST_ID },
        { agentId: "a2", title: "Elsewhere", hostId: "other-host" },
      ]);
      render(
        <SandboxSuspendDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />,
      );
      const list = screen.getByTestId("known-host-sessions");
      expect(list.textContent).toBe("Planner");
    });

    it("lists an open Task terminal on the sandbox's host by its title", () => {
      openTerminal("make watch", HOST_ID);
      render(
        <SandboxStopDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />,
      );
      expect(screen.getByTestId("known-host-sessions").textContent).toBe(
        "make watch",
      );
    });

    it("draws each session as a pill beside the line, by its name", () => {
      mocks.report = liveSessionReport(
        {
          agents: [agentSessionFixture({ name: "Planner" })],
          terminals: [terminalSessionFixture({ name: null })],
        },
        true,
      );
      render(
        <SandboxSuspendDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />,
      );
      expect(
        screen
          .getAllByTestId("sandbox-confirm-session-pill")
          .map((pill) => pill.textContent),
      ).toEqual(["Planner", "Terminal"]);
    });

    it("closes the dialog when a named session is opened", () => {
      focusAgents([{ agentId: "a1", title: "Planner", hostId: HOST_ID }]);
      mocks.routeNotification.mockReturnValue(true);
      const onOpenChange = vi.fn();
      render(
        <SandboxSuspendDialog
          sandbox={SANDBOX}
          open
          onOpenChange={onOpenChange}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Planner" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    describe("the host's own list", () => {
      const WITHOUT_TILE_NAME = "idle shell";

      function renderSuspend(): void {
        render(
          <SandboxSuspendDialog
            sandbox={SANDBOX}
            open
            onOpenChange={vi.fn()}
          />,
        );
      }

      it("lists only the named sessions, a terminal agent not renamed as Terminal agent", () => {
        mocks.report = liveSessionReport(
          {
            agents: [
              agentSessionFixture({ sessionId: "c1", name: "Planner" }),
              agentSessionFixture({ sessionId: "c2", name: null }),
              agentSessionFixture({
                kind: "terminal-agent",
                sessionId: "ta1",
                name: null,
              }),
            ],
            terminals: [
              terminalSessionFixture({ sessionId: "t1", name: "make watch" }),
              terminalSessionFixture({ sessionId: "t2", name: null }),
            ],
          },
          true,
        );
        renderSuspend();

        expect(screen.getByTestId("known-host-sessions").textContent).toBe(
          "PlannerTerminal agentmake watch",
        );
        expect(
          screen.getByText(
            "Known running agents and Task terminals. Other sessions may also be interrupted.",
          ),
        ).toBeDefined();
      });

      it("routes a chat to its task and closes the dialog when it opens", () => {
        mocks.report = liveSessionReport(
          {
            agents: [
              agentSessionFixture({
                sessionId: "chat-7",
                taskId: "epic-7",
                name: "Planner",
              }),
            ],
            terminals: [],
          },
          true,
        );
        mocks.routeNotification.mockReturnValue(true);
        const onOpenChange = vi.fn();
        render(
          <SandboxSuspendDialog
            sandbox={SANDBOX}
            open
            onOpenChange={onOpenChange}
          />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Planner" }));

        expect(mocks.routeNotification.mock.calls[0]?.[1]).toEqual({
          kind: "chat",
          epicId: "epic-7",
          chatId: "chat-7",
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });

      it("opens the tile of a terminal that has one, and lists one without a tile as plain text", () => {
        openTerminal("make watch", SANDBOX.hostId);
        mocks.report = liveSessionReport(
          {
            agents: [],
            terminals: [
              terminalSessionFixture({
                sessionId: "term-1",
                taskId: "epic-1",
                name: "make watch",
              }),
              terminalSessionFixture({
                sessionId: "term-9",
                taskId: "epic-1",
                name: WITHOUT_TILE_NAME,
              }),
            ],
          },
          false,
        );
        renderSuspend();

        expect(
          screen.queryByRole("button", { name: WITHOUT_TILE_NAME }),
        ).toBeNull();
        const list = screen.getByTestId("known-host-sessions");
        expect(within(list).getByText(WITHOUT_TILE_NAME)).toBeDefined();

        fireEvent.click(
          within(list).getByRole("button", { name: "make watch" }),
        );

        expect(mocks.openTile).toHaveBeenCalledTimes(1);
        expect(mocks.openTile.mock.calls[0]?.[0]).toMatchObject({
          node: { type: "terminal", id: "term-1" },
          target: { epicId: "epic-1" },
        });
      });

      it("falls back to what this window knows when the report is not live", () => {
        focusAgents([{ agentId: "a1", title: "Planner", hostId: HOST_ID }]);
        mocks.report = { kind: "stale", count: 2, at: 1_000 };
        renderSuspend();

        expect(screen.getByTestId("known-host-sessions").textContent).toBe(
          "Planner",
        );
      });
    });

    it("keeps the Destroy dialog's team sentence after the caption", () => {
      mocks.configuration = {
        kind: "team",
        teamId: "team-1",
        teamName: "acme",
        environmentId: null,
      };
      render(
        <SandboxDestroyDialog
          sandbox={SANDBOX}
          open
          onOpenChange={vi.fn()}
          onDestroyed={null}
        />,
      );
      expect(
        screen.getByTestId("sandbox-confirm-sessions").textContent,
      ).toContain(
        "Known running agents and Task terminals. Other sessions may also be interrupted. Affected members are told who destroyed it.",
      );
    });
  });

  it("says 1 session running in the singular", () => {
    mocks.report = liveSessionReport(
      { agents: [], terminals: [terminalSessionFixture({})] },
      false,
    );
    render(<SandboxStopDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />);
    expect(sessionsLine()).toBe("1 session runningbuild");
  });

  it("says the count is unknown, never a zero, when no report is held", () => {
    render(
      <SandboxSuspendDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />,
    );
    expect(sessionsLine()).toBe("Sessions unknown · no report yet");
  });

  describe("Destroy", () => {
    function renderDestroy(): void {
      render(
        <SandboxDestroyDialog
          sandbox={SANDBOX}
          open
          onOpenChange={vi.fn()}
          onDestroyed={null}
        />,
      );
    }

    it("names the live count in the outcome sentence", () => {
      mocks.report = liveSessionReport(
        {
          agents: [agentSessionFixture({})],
          terminals: [terminalSessionFixture({})],
        },
        true,
      );
      renderDestroy();
      expect(
        screen.getByTestId("confirm-destructive-dialog").textContent,
      ).toContain("Destroying ends 1 agent and 1 terminal.");
    });

    it("says every running session ends when the count is unknown", () => {
      renderDestroy();
      expect(
        screen.getByTestId("confirm-destructive-dialog").textContent,
      ).toContain("Destroying ends every running session.");
    });

    it("keeps Destroy disabled until the typed name matches", () => {
      renderDestroy();
      const confirm = screen.getByTestId("confirm-action");
      const input = screen.getByTestId("sandbox-confirm-destroy-typed");
      expect(confirm.hasAttribute("disabled")).toBe(true);

      fireEvent.change(input, { target: { value: "build" } });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      fireEvent.click(confirm);
      expect(mocks.destroyMutate).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: ` ${NAME} ` } });
      expect(confirm.hasAttribute("disabled")).toBe(false);
      fireEvent.click(confirm);
      expect(mocks.destroyMutate).toHaveBeenCalledTimes(1);
    });
  });
  describe("Destroy, by what runs on the sandbox", () => {
    const TAIL =
      "The disk is not recoverable; files on it were never synced anywhere. Published chats stay readable.";

    it("names the live split, then lists the named sessions and gives the caption, with no count line", () => {
      mocks.report = liveSessionReport(
        {
          agents: [agentSessionFixture({ name: "Planner" })],
          terminals: [
            terminalSessionFixture({ sessionId: "t1", name: "make watch" }),
            terminalSessionFixture({ sessionId: "t2", name: null }),
          ],
        },
        true,
      );
      render(
        <SandboxDestroyDialog
          sandbox={SANDBOX}
          open
          onOpenChange={vi.fn()}
          onDestroyed={null}
        />,
      );

      const description = screen.getByText(
        `Destroying ends 1 agent and 2 terminals. ${TAIL}`,
      );
      const list = screen.getByTestId("known-host-sessions");
      const caption = screen.getByText(
        "Known running agents and Task terminals. Other sessions may also be interrupted.",
      );
      expect(list.textContent).toBe("Plannermake watch");
      expect(
        description.compareDocumentPosition(list) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        list.compareDocumentPosition(caption) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.queryByTestId("sandbox-confirm-sessions-line")).toBeNull();
    });

    it("says nothing runs on a stopped sandbox, with no sessions block", () => {
      render(
        <SandboxDestroyDialog
          sandbox={sandboxSummaryFixture({
            displayName: NAME,
            state: "stopped",
          })}
          open
          onOpenChange={vi.fn()}
          onDestroyed={null}
        />,
      );

      expect(
        screen.getByText(`Nothing is running on it. ${TAIL}`),
      ).toBeDefined();
      expect(screen.queryByTestId("sandbox-confirm-sessions")).toBeNull();
    });
  });

  it("keeps the opening sentence for a sandbox already mid-destroy, never Nothing is running", () => {
    render(
      <SandboxDestroyDialog
        sandbox={sandboxSummaryFixture({
          displayName: NAME,
          state: "destroying",
        })}
        open
        onOpenChange={vi.fn()}
        onDestroyed={null}
      />,
    );

    const dialog = screen.getByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      "Destroying ends every running session.",
    );
    expect(dialog.textContent).not.toContain("Nothing is running on it.");
  });

  it("gives the Keep dialog no sessions block, which Suspend and Stop keep", () => {
    mocks.report = liveSessionReport({ agents: [], terminals: [] }, false);
    render(<SandboxKeepDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId("sandbox-confirm-sessions")).toBeNull();
    expect(screen.queryByText(/0 sessions running/)).toBeNull();
    expect(
      screen.queryByText(
        "Known running agents and Task terminals. Other sessions may also be interrupted.",
      ),
    ).toBeNull();
    cleanup();

    render(<SandboxStopDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />);
    expect(screen.getByTestId("sandbox-confirm-sessions")).toBeDefined();
  });

  describe("dates, counted from a pinned now", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 25, 10, 36));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function stopSentence(destroyAfterRestingMinutes: number | null): string {
      render(
        <SandboxStopDialog
          sandbox={sandboxSummaryFixture({
            displayName: NAME,
            destroyAfterRestingMinutes,
          })}
          open
          onOpenChange={vi.fn()}
        />,
      );
      return screen.getByTestId("sandbox-confirm-stop").textContent;
    }

    it("ends the Stop dialog with the destroy date and time", () => {
      expect(stopSentence(60)).toContain(
        "Destroyed on Oct 25 at 11:36 unless started.",
      );
    });

    it.each([null, 0])(
      "gives the Stop dialog no destroy date for a sandbox kept until destroyed (%s)",
      (kept) => {
        const text = stopSentence(kept);
        expect(text).not.toContain("destroy-after");
        expect(text).not.toContain("Destroyed on");
      },
    );

    it("gives the Keep preview its date with a time", () => {
      render(
        <SandboxKeepDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />,
      );
      expect(screen.getByTestId("sandbox-confirm-keep").textContent).toContain(
        "on Nov 1 at 10:36 if it rests from now.",
      );
    });
  });

  it("previews a resting period of Never as three whole sentences", () => {
    render(
      <SandboxIdleSettingsDialog
        sandbox={sandboxSummaryFixture({
          displayName: NAME,
          destroyAfterRestingMinutes: 10_080,
        })}
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByTestId("sandbox-idle-settings-resting-value"),
      {
        target: { value: "" },
      },
    );
    expect(
      screen.getByTestId("sandbox-idle-settings-preview").textContent,
    ).toBe(
      "Kept until you destroy it. Never applies to idle cleanup. Out-of-credit sandboxes are deleted after 30 days frozen.",
    );
  });

  it("keeps the confirmed set in Destroy all idle once the list drops the destroyed rows", () => {
    const targets = [
      sandboxSummaryFixture({
        id: "sbx-a",
        hostId: "host-a",
        displayName: "box-a",
        state: "suspended",
      }),
      sandboxSummaryFixture({
        id: "sbx-b",
        hostId: "host-b",
        displayName: "box-b",
        state: "stopped",
      }),
    ];
    const requestTargets = targets.map((target) => ({
      sandboxId: target.id,
      hostId: target.hostId,
      name: target.displayName,
    }));
    const dialog = (live: typeof targets) => (
      <SandboxDestroyAllIdleDialog targets={live} open onOpenChange={vi.fn()} />
    );
    const { rerender } = render(dialog(targets));
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(mocks.batch.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ targets: requestTargets }),
      expect.any(Object),
    );

    rerender(dialog([targets[1]]));
    expect(screen.getByRole("heading").textContent).toBe(
      "Destroy 2 idle sandboxes?",
    );
    const callback = mocks.batch.mutate.mock.calls[0][1];
    act(() =>
      callback.onSuccess([
        { ...requestTargets[0], outcome: { kind: "destroyed" } },
        { ...requestTargets[1], outcome: { kind: "failed", message: "busy" } },
      ]),
    );
    rerender(dialog([]));
    expect(screen.getByRole("heading").textContent).toBe(
      "Destroy 2 idle sandboxes?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.batch.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ targets: [requestTargets[1]] }),
      expect.any(Object),
    );
  });
});
