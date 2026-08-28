import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  tooltipTextFor,
  tooltipTextNear,
} from "@/components/ui/__tests__/tooltip-probe";

let mockBinding: WorktreeBinding | null = null;
let mockBindingResolved = true;

/** The subset of `TerminalAgentForkDialogProps` this file's tests read off a
 *  captured open call - not the real (unexported) prop type, since the mock
 *  below stands in for the whole component and only these fields matter here. */
interface CapturedForkDialogProps {
  readonly open: boolean;
  readonly target: { readonly intent: string } | null;
}

const tileMocks = vi.hoisted(() => ({
  openProps: [] as CapturedForkDialogProps[],
  forkProfileSupported: true,
  showAgentsAction: false,
}));

vi.mock("@/lib/host", () => {
  const entry = {
    hostId: "test-host",
    label: "Test host",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: null,
    transportDialability: "dialable",
  };
  return {
    useHostBinding: () => null,
    useHostClient: () => ({
      request: () => new Promise(() => {}),
      getActiveHostId: () => "host-test",
      getRequestContextUserId: () => "user-test",
      onChange: () => () => undefined,
    }),
    useHostDirectory: () => ({
      findById: () => entry,
      onChange: () => ({ dispose: () => undefined }),
    }),
  };
});

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => "host-test",
    getRequestContextUserId: () => "user-test",
    onChange: () => () => undefined,
  }),
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => (
      <div data-testid="host-workspace-selector">Local</div>
    ),
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () =>
    tileMocks.showAgentsAction
      ? {
          self: {
            id: "agent-1",
            title: "Claude agent",
            surface: "tui",
            activity: "turn",
            hostId: "host-test",
          },
          descendants: [
            {
              id: "agent-child",
              title: "Child agent",
              surface: "gui",
              activity: "turn",
              hostId: "host-test",
            },
          ],
        }
      : { self: null, descendants: [] },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: (): TuiAgentProjection => ({
    id: "agent-1",
    // An ordinary registry-backed agent - this suite exercises the tile's
    // fork-split affordance, not doc residency.
    docResident: false,
    harnessId: "claude",
    title: "Claude agent",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: "user-test",
    hostId: "host-test",
    harnessSessionId: "harness-session-1",
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: ["--continue"],
    workspaceFolders: ["/tmp/workspace"],
    workspaceMode: undefined,
    archivedAt: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: [] },
    isFetching: false,
    refetch: () => Promise.resolve({ data: { sessions: [] } }),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-create-mutation", () => ({
  useTerminalCreate: () => ({
    isError: false,
    isIdle: true,
    isSuccess: false,
    error: null,
    reset: () => undefined,
    mutate: () => undefined,
  }),
}));

vi.mock("@/hooks/agent/use-prepare-tui-launch-mutation", () => ({
  useAgentStartTerminalSession: () => ({
    isError: false,
    isPending: false,
    isIdle: true,
    error: null,
    reset: () => undefined,
    mutateAsync: () => new Promise(() => {}),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({
    mutate: vi.fn(),
  }),
}));

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
  useEpicCanvasStore: (selector: (s: unknown) => unknown) =>
    selector({
      closeCanvasTab: () => undefined,
    }),
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({
    data: mockBindingResolved ? { binding: mockBinding } : undefined,
    isSuccess: mockBindingResolved,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-set-local-mutation", () => ({
  useWorktreeSetLocal: () => ({
    mutate: () => undefined,
    isPending: false,
  }),
}));

vi.mock("@/hooks/agent/use-tui-fork-profile-support", () => ({
  useTuiForkProfileSupported: () => tileMocks.forkProfileSupported,
}));

// Capture fork-dialog open props; the dialog body is not under test here.
vi.mock("../terminal-agent-fork-dialog", () => ({
  TerminalAgentForkDialog: (props: CapturedForkDialogProps) => {
    if (props.open) tileMocks.openProps.push(props);
    return null;
  },
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";

function withQueryClient(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
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
          name: "claude",
          hostId: "test-host",
        }}
        tileId="tile-1"
        isActive
      />,
    ),
  );
}

function lastForkTargetIntent(): string {
  expect(tileMocks.openProps.length).toBeGreaterThan(0);
  const props = tileMocks.openProps[tileMocks.openProps.length - 1];
  if (props.target === null) {
    throw new Error("expected fork dialog target");
  }
  return props.target.intent;
}

async function openContinueMenuItem(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "More fork options" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  // The accessible name gains an appended disabled reason on an old host
  // (`tui-agent-tile.tsx`'s `aria-label`, amend-01 Fix 5) - match the stable
  // prefix so this helper finds the item in both the enabled and disabled
  // cell.
  return waitFor(() =>
    screen.getByRole("menuitem", {
      name: /^Continue under another profile…/,
    }),
  );
}

describe("<TuiAgentTile /> fork split button", () => {
  beforeEach(() => {
    mockBinding = { entries: [] };
    mockBindingResolved = true;
    tileMocks.openProps.length = 0;
    tileMocks.forkProfileSupported = true;
    tileMocks.showAgentsAction = false;
    useWorktreeIntentStagingStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the Fork actions as one joined outline button group", () => {
    renderTile();

    const group = screen.getByRole("group", { name: "Fork actions" });
    const fork = within(group).getByRole("button", { name: "Fork" });
    const more = within(group).getByRole("button", {
      name: "More fork options",
    });

    expect(group.getAttribute("data-slot")).toBe("button-group");
    expect(group.children).toHaveLength(2);
    expect(group.children[0].contains(fork)).toBe(true);
    expect(group.children[1]).toBe(more);
    expect(fork.getAttribute("data-variant")).toBe("outline");
    expect(more.getAttribute("data-variant")).toBe("outline");
    expect(tooltipTextFor(more)).toBe("More fork options");
  });

  it("renders the conditional Agents toolbar action as outline", () => {
    tileMocks.showAgentsAction = true;
    renderTile();

    expect(
      screen
        .getByTestId("tui-agent-subagents-trigger")
        .getAttribute("data-variant"),
    ).toBe("outline");
  });

  it("opens the fork dialog with intent fork from the main Fork button", () => {
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    expect(lastForkTargetIntent()).toBe("fork");
  });

  it("opens the fork dialog with intent continue from the chevron menu item", async () => {
    renderTile();

    const item = await openContinueMenuItem();
    const label = within(item).getByText("Continue under another profile…");
    const menu = item.closest('[data-slot="dropdown-menu-content"]');
    expect(label.classList.contains("whitespace-nowrap")).toBe(true);
    expect(item.classList.contains("flex-col")).toBe(false);
    expect(menu?.classList.contains("w-max")).toBe(true);
    fireEvent.click(item);

    await waitFor(() => {
      expect(lastForkTargetIntent()).toBe("continue");
    });
  });

  it("disables Continue under another profile on an old host with update guidance", async () => {
    tileMocks.forkProfileSupported = false;
    renderTile();

    const item = await openContinueMenuItem();
    if (!(item instanceof HTMLElement)) {
      throw new Error("expected continue menu item");
    }
    // Radix marks disabled items with data-disabled / aria-disabled.
    expect(
      item.getAttribute("data-disabled") === "" ||
        item.getAttribute("aria-disabled") === "true" ||
        (item instanceof HTMLButtonElement && item.disabled),
    ).toBe(true);
    expect(tooltipTextNear(item)).toBe(
      "Update Traycer host to continue this session under another profile.",
    );
    // amend-02 a11y fix: Radix's roving-tabindex skips this disabled item
    // entirely, so keyboard/AT users never focus it to hear the aria-label
    // or trigger the hover-only tooltip above. The reason must also render
    // as static, always-visible text inside the item - reachable without
    // focus or hover.
    expect(
      within(item).getByText(
        "Update Traycer host to continue this session under another profile.",
      ),
    ).not.toBeNull();

    fireEvent.click(item);
    expect(tileMocks.openProps).toHaveLength(0);
  });

  it("keeps the main Fork button available when continue-under-profile is unsupported", () => {
    tileMocks.forkProfileSupported = false;
    renderTile();

    const fork = screen.getByRole("button", { name: "Fork" });
    if (!(fork instanceof HTMLButtonElement)) {
      throw new Error("expected Fork button");
    }
    expect(fork.disabled).toBe(false);
    fireEvent.click(fork);
    expect(lastForkTargetIntent()).toBe("fork");
  });
});
