import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import {
  SetupCardSegment,
  type SetupCardViewModel,
  type SetupCardWorkspace,
  type SetupWorkspaceState,
} from "@/components/chat/segments/setup-card-segment";

const focusTerminal = vi.hoisted(() => vi.fn());
const retryMutate = vi.hoisted(() => vi.fn());
// `value === undefined` models the "liveness not yet known" window (the query
// has not settled); an array models a settled `terminal.list` response.
const terminalSessions = vi.hoisted<{
  value:
    | ReadonlyArray<{ sessionId: string; status: string; sessionKind: string }>
    | undefined;
}>(() => ({ value: undefined }));
// The tab-scoped client - an opaque non-null sentinel stands in for "the tab
// host resolved"; set to `null` to model the unresolved-directory window.
const tabClient = vi.hoisted<{ value: object | null }>(() => ({ value: {} }));
// Captures the client argument `SetupCardSegment` threads into the retry hook,
// so a test can assert Retry routes through the SAME tab client as the others.
const retryClientArg = vi.hoisted<{ value: object | null | "unset" }>(() => ({
  value: "unset",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => tabClient.value,
}));

vi.mock("@/hooks/terminal/use-terminal-list-for-query", () => ({
  useTerminalListFor: () => ({
    data:
      terminalSessions.value === undefined
        ? undefined
        : { sessions: terminalSessions.value },
  }),
}));

vi.mock("@/components/epic-canvas/renderers/chat-tile-focus-terminal", () => ({
  useFocusEpicTerminalSession: () => focusTerminal,
}));

vi.mock("@/hooks/worktree/use-worktree-retry-setup-mutation", () => ({
  useWorktreeRetrySetupFor: (client: object | null) => {
    retryClientArg.value = client;
    return { mutate: retryMutate, isPending: false };
  },
}));

// Contract guard: the state union is exactly these five. If it drifts,
// `Exclude<...>` stops resolving to `never` and `bun run compile` fails.
type UnexpectedStates = Exclude<
  SetupWorkspaceState,
  "creating" | "setting-up" | "ready" | "failed" | "cancelled"
>;
const _noUnexpectedState: UnexpectedStates extends never ? true : false = true;
void _noUnexpectedState;

const VIEW_TAB_ID = "tab-1";
const EPIC_ID = "epic-1";
const OWNER_ID = "owner-1";

function workspace(
  overrides: Partial<SetupCardWorkspace> & { state: SetupWorkspaceState },
): SetupCardWorkspace {
  return {
    workspacePath: "/repo",
    label: "repo",
    setupExitCode: null,
    terminalSessionId: "term-1",
    worktreePath: "/worktrees/repo/feature",
    branch: "feature",
    ...overrides,
  };
}

// The live (still-open) lifecycle by default. Stranded-historical cases spread
// `{ ...viewModel(...), isActive: false }` to model a window closed by a
// boundary while a workspace was still setting up.
function viewModel(
  state: SetupWorkspaceState,
  workspaces: ReadonlyArray<SetupCardWorkspace>,
): SetupCardViewModel {
  return {
    aggregate: {
      epicId: EPIC_ID,
      ownerId: OWNER_ID,
      ownerKind: "chat",
      state,
    },
    workspaces,
    createdAt: 5_000,
    isActive: true,
  };
}

function renderCard(model: SetupCardViewModel) {
  return render(
    <TooltipProvider>
      <SetupCardSegment model={model} viewTabId={VIEW_TAB_ID} variant="card" />
    </TooltipProvider>,
  );
}

// The card is a compact line; the dropdown (steps for single-repo, per-workspace
// rows for multi) is always reachable behind the toggle. `failed` auto-expands.
function expand() {
  fireEvent.click(screen.getByTestId("setup-card-toggle"));
}

beforeEach(() => {
  focusTerminal.mockReset();
  retryMutate.mockReset();
  terminalSessions.value = undefined;
  tabClient.value = {};
  retryClientArg.value = "unset";
});

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

describe("<SetupCardSegment /> worktree location", () => {
  it("shows the branch and worktree path in the single-repo expanded view", () => {
    renderCard(
      viewModel("ready", [
        workspace({
          state: "ready",
          branch: "my-feature",
          worktreePath: "/home/me/.traycer/worktrees/app/my-feature",
        }),
      ]),
    );
    expand();
    expect(screen.getByTestId("setup-card-branch").textContent).toBe(
      "my-feature",
    );
    const path = screen.getByTestId("setup-card-worktree-path");
    expect(path.textContent).toBe("/home/me/.traycer/worktrees/app/my-feature");
    // The path truncates from the START (leaf stays visible); the full path is
    // on hover via FilePathTooltip (a portal), so there is no `title` attr.
    expect(path.getAttribute("title")).toBeNull();
  });

  it("shows a branch + path per workspace in the multi-repo expanded view", () => {
    renderCard(
      viewModel("setting-up", [
        workspace({
          state: "ready",
          workspacePath: "/api",
          label: "api",
          branch: "api-feature",
          worktreePath: "/wt/api/api-feature",
        }),
        workspace({
          state: "setting-up",
          workspacePath: "/web",
          label: "web",
          branch: "web-feature",
          worktreePath: "/wt/web/web-feature",
        }),
      ]),
    );
    expand();
    expect(
      screen
        .getAllByTestId("setup-card-branch")
        .map((node) => node.textContent),
    ).toEqual(["api-feature", "web-feature"]);
    expect(
      screen
        .getAllByTestId("setup-card-worktree-path")
        .map((node) => node.textContent),
    ).toEqual(["/wt/api/api-feature", "/wt/web/web-feature"]);
  });

  it("renders no location line when branch and path are both absent", () => {
    renderCard(
      viewModel("ready", [
        workspace({ state: "ready", branch: null, worktreePath: null }),
      ]),
    );
    expand();
    expect(screen.queryByTestId("setup-card-branch")).toBeNull();
    expect(screen.queryByTestId("setup-card-worktree-path")).toBeNull();
  });
});

describe("<SetupCardSegment /> creating", () => {
  it("shows 'Creating worktree' and no terminal action while the worktree is being created", () => {
    // During `git worktree add` there is no setup terminal yet.
    renderCard(
      viewModel("creating", [
        workspace({ state: "creating", terminalSessionId: null }),
      ]),
    );
    // Collapsed header reflects the create phase, not "Setting up".
    expect(screen.getByText("Creating worktree")).toBeTruthy();
    expand();
    // The setup step is present but pending (no Open-terminal until setup runs).
    expect(screen.getByText("Setting up worktree")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open terminal/i })).toBeNull();
  });

  it("shows the create-phase header for a multi-repo creating window", () => {
    renderCard(
      viewModel("creating", [
        workspace({
          state: "creating",
          workspacePath: "/a",
          terminalSessionId: null,
        }),
        workspace({
          state: "creating",
          workspacePath: "/b",
          terminalSessionId: null,
        }),
      ]),
    );
    expect(screen.getByText("Creating 2 worktrees")).toBeTruthy();
  });
});

describe("<SetupCardSegment /> compact line + expand", () => {
  it("is collapsed by default and toggles the dropdown open and shut", () => {
    renderCard(viewModel("ready", [workspace({ state: "ready" })]));

    expect(screen.queryByTestId("setup-card-steps")).toBeNull();
    expand();
    expect(screen.getByTestId("setup-card-steps")).toBeTruthy();
    expand();
    expect(screen.queryByTestId("setup-card-steps")).toBeNull();
  });

  it("auto-expands a failed card so Retry is immediately reachable", () => {
    renderCard(
      viewModel("failed", [workspace({ state: "failed", setupExitCode: 1 })]),
    );

    expect(screen.getByRole("button", { name: "Retry setup" })).toBeTruthy();
  });
});

describe("<SetupCardSegment /> single-repo dropdown (two steps)", () => {
  it("shows the two setup steps with the live phase active", () => {
    renderCard(viewModel("setting-up", [workspace({ state: "setting-up" })]));

    // Collapsed line shows the phase; the steps live in the dropdown.
    expect(screen.getByText("Setting up worktree")).toBeTruthy();
    expect(screen.queryByTestId("setup-card-steps")).toBeNull();
    expand();
    const steps = screen.getByTestId("setup-card-steps");
    expect(within(steps).getByText("Creating worktree")).toBeTruthy();
    expect(within(steps).getByText("Setting up worktree")).toBeTruthy();
    expect(
      within(steps).getByRole("button", { name: "Open terminal" }),
    ).toBeTruthy();
    // Cancel is not offered anywhere.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows a live elapsed counter in the header while setting up", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      renderCard(viewModel("setting-up", [workspace({ state: "setting-up" })]));
      // createdAt 5s, now 10s -> 5s elapsed, shown on the (collapsed) line.
      expect(screen.getByText("5s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a compact ready line and reveals Open terminal on expand", () => {
    renderCard(
      viewModel("ready", [workspace({ state: "ready", label: "my-feature" })]),
    );

    expect(screen.getByText("Worktree ready")).toBeTruthy();
    expect(screen.getByText(/my-feature/)).toBeTruthy();
    expand();
    expect(screen.getByRole("button", { name: "Open terminal" })).toBeTruthy();
  });

  it("auto-expands on failure, showing the exit code, Retry and Open terminal", () => {
    renderCard(
      viewModel("failed", [workspace({ state: "failed", setupExitCode: 1 })]),
    );

    expect(screen.getByText("Setup failed")).toBeTruthy();
    const steps = screen.getByTestId("setup-card-steps");
    expect(within(steps).getByText(/exit 1/)).toBeTruthy();
    expect(
      within(steps).getByRole("button", { name: "Open terminal" }),
    ).toBeTruthy();

    fireEvent.click(within(steps).getByRole("button", { name: "Retry setup" }));
    expect(retryMutate).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      ownerId: OWNER_ID,
      ownerKind: "chat",
      workspacePath: "/repo",
    });
  });

  it("offers Retry on a cancelled setup after expand", () => {
    renderCard(viewModel("cancelled", [workspace({ state: "cancelled" })]));

    expect(screen.getByText("Setup cancelled")).toBeTruthy();
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(retryMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/repo" }),
    );
  });

  it("gates the failed-setup report action on capability and reports only fixed generic context", () => {
    renderCard(
      viewModel("failed", [workspace({ state: "failed", setupExitCode: 1 })]),
    );

    // Capability-gated off by default.
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Worktree setup failed",
        message: null,
        code: null,
        source: "Setup",
      },
    });
  });

  it("omits the report action for a cancelled (non-failed) setup", () => {
    renderCard(viewModel("cancelled", [workspace({ state: "cancelled" })]));
    expand();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });
});

describe("<SetupCardSegment /> Open terminal liveness", () => {
  it("enables Open terminal when the session is live and focuses it on click", () => {
    terminalSessions.value = [
      { sessionId: "term-1", status: "running", sessionKind: "terminal" },
    ];
    renderCard(viewModel("ready", [workspace({ state: "ready" })]));
    expand();

    const button = screen.getByRole("button", { name: "Open terminal" });
    expect(button).not.toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(focusTerminal).toHaveBeenCalledWith(
      "term-1",
      "/worktrees/repo/feature",
    );
  });

  it("disables Open terminal once liveness reports it gone, with the reason in a tooltip not the label", () => {
    terminalSessions.value = [];
    renderCard(viewModel("ready", [workspace({ state: "ready" })]));
    expand();

    // The label stays "Open terminal" (no appended "(session ended)"); the
    // reason is delivered via a tooltip on the disabled button.
    const button = screen.getByTestId("setup-card-open-terminal-ended");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("Open terminal");
    expect(button.textContent).not.toContain("session ended");
    fireEvent.click(button);
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("omits Open terminal when no terminal was ever linked", () => {
    terminalSessions.value = [];
    renderCard(
      viewModel("failed", [
        workspace({ state: "failed", terminalSessionId: null }),
      ]),
    );
    // failed auto-expands.

    expect(screen.queryByRole("button", { name: /Open terminal/ })).toBeNull();
    // Recovery path remains.
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeTruthy();
  });
});

describe("<SetupCardSegment /> multi-repo", () => {
  const workspaces: ReadonlyArray<SetupCardWorkspace> = [
    workspace({
      state: "ready",
      workspacePath: "/api",
      label: "api",
      terminalSessionId: "term-api",
    }),
    workspace({
      state: "ready",
      workspacePath: "/web",
      label: "web",
      terminalSessionId: "term-web",
    }),
    workspace({
      state: "setting-up",
      workspacePath: "/worker",
      label: "worker",
      terminalSessionId: "term-worker",
    }),
  ];

  it("renders one consolidated line, expanding to a sub-row per workspace", () => {
    renderCard(viewModel("setting-up", workspaces));

    expect(screen.getByText("Setting up 3 worktrees")).toBeTruthy();
    expect(screen.getByText(/2 of 3 done/)).toBeTruthy();
    // Sub-rows live in the dropdown.
    expect(screen.queryByTestId("setup-card-workspace-/api")).toBeNull();
    expand();
    for (const path of ["/api", "/web", "/worker"]) {
      const row = screen.getByTestId(`setup-card-workspace-${path}`);
      expect(
        within(row).getByRole("button", { name: "Open terminal" }),
      ).toBeTruthy();
    }
    // No Cancel affordance on any sub-row.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("retries the correct workspace from its sub-row", () => {
    const failing: ReadonlyArray<SetupCardWorkspace> = [
      workspace({
        state: "ready",
        workspacePath: "/api",
        label: "api",
        terminalSessionId: "term-api",
      }),
      workspace({
        state: "failed",
        workspacePath: "/worker",
        label: "worker",
        setupExitCode: 2,
        terminalSessionId: "term-worker",
      }),
    ];
    renderCard(viewModel("failed", failing));
    // failed auto-expands.

    const row = screen.getByTestId("setup-card-workspace-/worker");
    fireEvent.click(within(row).getByRole("button", { name: "Retry setup" }));
    expect(retryMutate).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      ownerId: OWNER_ID,
      ownerKind: "chat",
      workspacePath: "/worker",
    });
    // The succeeded sibling exposes no retry affordance.
    const apiRow = screen.getByTestId("setup-card-workspace-/api");
    expect(
      within(apiRow).queryByRole("button", { name: "Retry setup" }),
    ).toBeNull();
  });

  it("shows the create + setup steps and a branch/path header per workspace", () => {
    renderCard(
      viewModel("setting-up", [
        workspace({
          state: "ready",
          workspacePath: "/api",
          label: "api",
          branch: "api-feat",
          worktreePath: "/wt/api/api-feat",
          terminalSessionId: "term-api",
        }),
        workspace({
          state: "setting-up",
          workspacePath: "/web",
          label: "web",
          branch: "web-feat",
          worktreePath: "/wt/web/web-feat",
          terminalSessionId: "term-web",
        }),
      ]),
    );
    expand();
    for (const path of ["/api", "/web"]) {
      const row = screen.getByTestId(`setup-card-workspace-${path}`);
      // The identical two-step "create + setup" view, per workspace.
      const steps = within(row).getByTestId("setup-card-steps");
      expect(within(steps).getByText("Creating worktree")).toBeTruthy();
      expect(within(steps).getByText("Setting up worktree")).toBeTruthy();
      // The header carries this worktree's own branch + path.
      expect(within(row).getByTestId("setup-card-branch")).toBeTruthy();
      expect(within(row).getByTestId("setup-card-worktree-path")).toBeTruthy();
    }
  });
});

describe("<SetupCardSegment /> in-flight vs stranded (isActive)", () => {
  it("renders a stranded setting-up window statically: no timer, 'incomplete'", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      renderCard({
        ...viewModel("setting-up", [workspace({ state: "setting-up" })]),
        isActive: false,
      });

      // No ticking elapsed counter (it would read "5s" if it rendered).
      expect(screen.queryByText("5s")).toBeNull();
      // The line reads "incomplete", not the live "Setting up worktree".
      expect(screen.getByText("Worktree setup incomplete")).toBeTruthy();
      expect(screen.queryByText("Setting up worktree")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the live elapsed counter while a sibling repo is still setting up despite a failed rollup", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      renderCard(
        viewModel("failed", [
          workspace({
            state: "failed",
            workspacePath: "/api",
            label: "api",
            setupExitCode: 1,
            terminalSessionId: "term-api",
          }),
          workspace({
            state: "setting-up",
            workspacePath: "/web",
            label: "web",
            terminalSessionId: "term-web",
          }),
        ]),
      );

      // aggregate rolled up to "failed", but a repo is still in flight, so the
      // header keeps the live timer (keyed on any-workspace-setting-up, NOT the
      // rollup, which would have hidden it).
      expect(screen.getByText("5s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the live timer on a stranded multi-repo window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      renderCard({
        ...viewModel("setting-up", [
          workspace({
            state: "ready",
            workspacePath: "/api",
            label: "api",
            terminalSessionId: "term-api",
          }),
          workspace({
            state: "setting-up",
            workspacePath: "/web",
            label: "web",
            terminalSessionId: "term-web",
          }),
        ]),
        isActive: false,
      });

      expect(screen.queryByText("5s")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("<SetupCardSegment /> tab-host scoping", () => {
  it("routes Retry through the SAME tab client as the other actions", () => {
    renderCard(viewModel("failed", [workspace({ state: "failed" })]));

    // The client threaded into the retry hook is exactly the tab client (the
    // same one liveness/Open use), not the app-wide default host.
    expect(retryClientArg.value).toBe(tabClient.value);
  });

  it("hides Retry while the tab client is unresolved", () => {
    tabClient.value = null;

    // Failed card (auto-expanded): Retry would no-op against a null client, so
    // it's hidden until the tab host client resolves.
    renderCard(viewModel("failed", [workspace({ state: "failed" })]));
    expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
  });
});
