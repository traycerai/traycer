import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import {
  sandboxSummarySchema,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import type { HostStatusSessions } from "@traycer/protocol/host/status/contracts";
import {
  agentSessionFixture,
  terminalSessionFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { SandboxConfigurations } from "@/hooks/sandboxes/use-sandbox-configurations";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import {
  listEpicTerminalDurableCreateJobsForEpic,
  resetEpicTerminalDurableCreatesForTests,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import {
  hoverAlsoInTask,
  hoverTaskConfiguration,
  hoverTodayCost,
  KEEP_THIS_SANDBOX,
  reachSentence,
  REACH_UNNAMED_HOSTS,
  SESSIONS_UNKNOWN,
  shortPriceLabel,
  TASK_FILES,
} from "@/lib/sandboxes/sandbox-strings";

/**
 * Only the nondeterministic boundaries are replaced: the cloud reads, the host
 * RPCs, auth and the tile/panel openers. The projection choice and the host
 * section are the real ones.
 */
const h = vi.hoisted(() => {
  const NO_CONFIGURATIONS: SandboxConfigurations = {
    configurations: [{ kind: "personal" }],
    teamEnvironmentIds: new Set(),
    complete: false,
  };
  const state: {
    sandboxes: object[];
    taskHosts: object;
    cost: object[];
    busySessionCount: number | null;
    sessions: HostStatusSessions | null;
    statusUpdatedAt: number | null;
    listUpdatedAt: number | null;
    listFetching: boolean;
    refetchAgents: Mock;
    refetchTerminals: Mock;
    agents: object[];
    terminals: object[];
    teams: object[];
    registryOwner: object | null;
    configurations: SandboxConfigurations;
    setPanel: Mock;
    openDetails: Mock;
    openTile: Mock;
  } = {
    sandboxes: [],
    taskHosts: { kind: "none" },
    cost: [],
    busySessionCount: null,
    sessions: null,
    statusUpdatedAt: null,
    listUpdatedAt: null,
    listFetching: false,
    refetchAgents: vi.fn(),
    refetchTerminals: vi.fn(),
    agents: [],
    terminals: [],
    teams: [],
    registryOwner: { kind: "team", name: "Acme" },
    configurations: NO_CONFIGURATIONS,
    setPanel: vi.fn(),
    openDetails: vi.fn(),
    openTile: vi.fn(),
  };
  return state;
});

vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: { sandboxes: h.sandboxes } }),
}));
vi.mock("@/hooks/epic/use-task-hosts-view", () => ({
  useTaskHostsView: () => h.taskHosts,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: { sandboxes: h.cost } }),
}));
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: {
      providers: [
        { provider: "tensorlake", os: ["linux"], suspendFidelity: "memory" },
      ],
    },
  }),
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({
    data: {
      hosts: [{ hostId: "host-sbx", owner: h.registryOwner ?? undefined }],
    },
  }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-configurations")
      >();
    return { ...actual, useSandboxConfigurations: () => h.configurations };
  },
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: { readonly method: string }) => {
    if (args.method === "host.status") {
      return {
        isError: false,
        dataUpdatedAt: h.statusUpdatedAt ?? Date.now(),
        data:
          h.busySessionCount === null
            ? undefined
            : {
                busySessionCount: h.busySessionCount,
                sessions: h.sessions,
              },
      };
    }
    const snapshot = {
      isError: false,
      isFetching: h.listFetching,
      dataUpdatedAt: h.listUpdatedAt ?? Date.now(),
    };
    if (args.method === "agent.list") {
      return {
        ...snapshot,
        refetch: h.refetchAgents,
        data: { agents: h.agents },
      };
    }
    return {
      ...snapshot,
      refetch: h.refetchTerminals,
      data: { sessions: h.terminals },
    };
  },
}));
vi.mock("@/hooks/use-epic-store", () => ({
  useMaybeEpicStore: (
    selector: (state: unknown) => unknown,
    _fallback: unknown,
  ) =>
    selector({
      chats: {
        byId: {
          "agent-1": { id: "agent-1", hostId: "host-t", title: "Reviewer" },
          "agent-2": { id: "agent-2", hostId: "host-t", title: "Planner" },
          "agent-3": { id: "agent-3", hostId: "host-sbx", title: "Creator" },
        },
      },
      tuiAgents: { byId: {} },
    }),
}));
vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      shareableTeams: h.teams,
      contextMetadata: { userId: "user-1" },
    }),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: h.openTile }),
}));
vi.mock("@/components/epic-canvas/view-tab-context", () => ({
  useEpicViewTabId: () => "tab-1",
}));
vi.mock("@/stores/epics/left-panel-store", () => ({
  useEpicLeftPanelStore: (selector: (state: unknown) => unknown) =>
    selector({ setActivePanelIdAndExpand: h.setPanel }),
}));
vi.mock("@/stores/sandboxes/sandbox-details-store", () => ({
  openSandboxDetails: h.openDetails,
}));
vi.mock("@/components/hosts/sandbox-confirm-dialogs", () => ({
  SandboxKeepDialog: (props: { readonly sandbox: { readonly id: string } }) => (
    <div data-testid="keep-dialog">{props.sandbox.id}</div>
  ),
}));

const worktreeTooltipSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/worktree/worktree-owner-metadata", () => ({
  WorktreeOwnerMetadataTooltip: (props: {
    readonly trigger: React.ReactElement;
    readonly hostSection?: React.ReactNode;
    readonly supplementalContent: React.ReactNode | null;
    readonly side: "top" | "right" | "bottom" | "left";
  }) => {
    worktreeTooltipSpy(props);
    return (
      <div data-testid="worktree-owner-tooltip" data-side={props.side}>
        {props.trigger}
        <div data-testid="worktree-host-section">{props.hostSection}</div>
        <div data-testid="worktree-supplemental">
          {props.supplementalContent}
        </div>
      </div>
    );
  },
}));

import { AgentHoverTooltip } from "@/components/epic-canvas/sidebar/agent-hover-tooltip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SANDBOX_PUBLIC_STATE_LABEL } from "@/lib/sandboxes/sandbox-row-lines";

const CLAIM: RoleClaim = {
  claimId: "claim-1",
  role: "Edge owner",
  scope: "comm-graph edges",
  agentId: "agent-1",
  userId: "user-1",
  claimedAt: 1,
};

interface HoverOverrides {
  readonly hostId: string | null;
  readonly ownerKind: "chat" | "terminal-agent" | null;
  readonly ownerHostUnreachable: boolean;
  readonly roleClaims: readonly RoleClaim[];
  readonly side: "top" | "right" | "bottom" | "left";
  readonly extraContent: React.ReactElement | null;
}

const NO_EXTRA: Pick<HoverOverrides, "extraContent"> = { extraContent: null };

function hoverTree(overrides: HoverOverrides) {
  return (
    <TooltipProvider>
      <AgentHoverTooltip
        trigger={<button type="button">Reviewer</button>}
        epicId="epic-1"
        nodeId="agent-1"
        nodeName="Reviewer"
        hostId={overrides.hostId}
        ownerHostUnreachable={overrides.ownerHostUnreachable}
        ownerKind={overrides.ownerKind}
        roleClaims={overrides.roleClaims}
        extraContent={overrides.extraContent}
        side={overrides.side}
      />
    </TooltipProvider>
  );
}

function renderHover(overrides: HoverOverrides) {
  return render(hoverTree(overrides));
}

afterEach(() => {
  cleanup();
  resetEpicTerminalDurableCreatesForTests();
  worktreeTooltipSpy.mockClear();
  h.sandboxes = [];
  h.taskHosts = { kind: "none" };
  h.cost = [];
  h.busySessionCount = null;
  h.sessions = null;
  h.statusUpdatedAt = null;
  h.listUpdatedAt = null;
  h.listFetching = false;
  h.refetchAgents.mockClear();
  h.refetchTerminals.mockClear();
  vi.useRealTimers();
  h.agents = [];
  h.terminals = [];
  h.teams = [];
  h.registryOwner = { kind: "team", name: "Acme" };
  h.configurations = {
    configurations: [{ kind: "personal" }],
    teamEnvironmentIds: new Set(),
    complete: false,
  };
  h.setPanel.mockClear();
  h.openDetails.mockClear();
  h.openTile.mockClear();
});

/**
 * ONE hover for both the Agents navigator and the graph nodes. These pin the
 * precedence the sidebar established, so extracting it cannot quietly change
 * what either surface shows.
 */
describe("AgentHoverTooltip", () => {
  it("prefers owner metadata, carrying role claims as supplemental content", () => {
    renderHover({
      hostId: "host-a",
      ownerHostUnreachable: false,
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "top",
      ...NO_EXTRA,
    });

    expect(
      screen.getByTestId("worktree-owner-tooltip").getAttribute("data-side"),
    ).toBe("top");
    // The roles ride along rather than replacing the richer card.
    expect(screen.getByTestId("worktree-supplemental").textContent).toContain(
      "Edge owner",
    );
    // The name is the owner card's own title, not part of the roles section -
    // the supplemental content must not duplicate it.
    expect(
      screen.getByTestId("worktree-supplemental").textContent,
    ).not.toContain("Reviewer");
    expect(worktreeTooltipSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Reviewer" }),
    );
    expect(screen.getByRole("button", { name: "Reviewer" })).toBeDefined();
  });

  it("degrades to the role tooltip when the owner host is unreachable", async () => {
    // Outcome 1's content is a live RPC chain against the row's OWN binding
    // host, and branch and worktree path are filesystem facts of that machine
    // - so there is nothing to replicate that would let the card render
    // truthfully while the host is gone. Falling back shows what is still
    // true. Same inputs as the test above apart from this one flag, so the
    // flag is what proves to be the gate.
    renderHover({
      hostId: "host-a",
      ownerHostUnreachable: true,
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "top",
      ...NO_EXTRA,
    });

    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));

    const content = await screen.findByTestId("agent-role-hover-content");
    expect(content.textContent).toContain("Edge owner");
    // The roles card no longer duplicates the name - it is shown once, above
    // this section, by the fallback tooltip itself.
    expect(content.textContent).not.toContain("Reviewer");

    await screen.findByRole("tooltip");
    // One "Reviewer" is the trigger button's own label; the other is the
    // name shown once above the roles section in the fallback tooltip.
    expect(screen.getAllByText("Reviewer")).toHaveLength(2);
  });

  it("still shows the NAME on hover for an unreachable owner with no roles", async () => {
    // Never a bare trigger: sidebar rows and graph nodes truncate, so the
    // tooltip is the only place a long agent name is readable - and an offline
    // machine does not make its agent's name less true.
    renderHover({
      hostId: "host-a",
      ownerHostUnreachable: true,
      ownerKind: "chat",
      roleClaims: [],
      side: "top",
      ...NO_EXTRA,
    });

    const trigger = screen.getByRole("button", { name: "Reviewer" });
    await userEvent.hover(trigger);
    expect(await screen.findAllByText("Reviewer")).not.toHaveLength(0);
  });

  it("falls back to a role-only tooltip when there is no owner metadata", async () => {
    renderHover({
      hostId: null,
      ownerHostUnreachable: false,
      ownerKind: null,
      roleClaims: [CLAIM],
      side: "top",
      ...NO_EXTRA,
    });

    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));

    const content = await screen.findByTestId("agent-role-hover-content");
    expect(content.closest('[data-side="top"]')).not.toBeNull();
    expect(content.textContent).toContain("Edge owner");
    expect(content.textContent).toContain("comm-graph edges");
    // The roles card no longer duplicates the name - it is shown once, above
    // this section, by the fallback tooltip itself.
    expect(content.textContent).not.toContain("Reviewer");

    await screen.findByRole("tooltip");
    // One "Reviewer" is the trigger button's own label; the other is the
    // name shown once above the roles section in the fallback tooltip.
    expect(screen.getAllByText("Reviewer")).toHaveLength(2);
  });

  /**
   * An agent with nothing to say about itself gets NO hover - a card that opens
   * onto an empty box is worse than no card.
   */
  it("renders the bare trigger when there is nothing to show", async () => {
    renderHover({
      hostId: null,
      ownerHostUnreachable: false,
      ownerKind: null,
      roleClaims: [],
      side: "top",
      ...NO_EXTRA,
    });

    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Reviewer" });
    await userEvent.hover(trigger);
    expect(screen.queryByTestId("agent-role-hover-content")).toBeNull();
  });

  it("puts the caller's own content under the role content", () => {
    // The office adds a line of its own beneath the shared card. Both have to
    // survive: the floor's posture line replacing the roles would be a
    // regression the surfaces could not see in each other.
    renderHover({
      hostId: "host-a",
      ownerHostUnreachable: false,
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "top",
      extraContent: (
        <span data-testid="caller-extra">Working · large model</span>
      ),
    });

    const supplemental = screen.getByTestId("worktree-supplemental");
    expect(supplemental.textContent).toContain("Edge owner");
    expect(supplemental.textContent).toContain("Working · large model");
    // Under, not over: the shared card's own content comes first.
    const roles = supplemental.textContent.indexOf("Edge owner");
    const own = supplemental.textContent.indexOf("Working");
    expect(roles).toBeLessThan(own);
  });

  it("keeps the trigger's own click working under the tooltip", async () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <AgentHoverTooltip
          trigger={
            <button type="button" onClick={onClick}>
              Reviewer
            </button>
          }
          epicId="epic-1"
          nodeId="agent-1"
          nodeName="Reviewer"
          hostId={null}
          ownerHostUnreachable={false}
          ownerKind={null}
          roleClaims={[CLAIM]}
          extraContent={null}
          side="top"
        />
      </TooltipProvider>,
    );

    // The graph node's detail-panel click and the sidebar's row click both live
    // on the trigger; a tooltip that swallowed them would break both surfaces.
    await userEvent.click(screen.getByRole("button", { name: "Reviewer" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the sidebar metadata hover on the right", () => {
    renderHover({
      hostId: "host-a",
      ownerHostUnreachable: false,
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "right",
      ...NO_EXTRA,
    });

    expect(
      screen.getByTestId("worktree-owner-tooltip").getAttribute("data-side"),
    ).toBe("right");
  });

  it("keeps the agent name alongside extra content in the fallback tooltip", async () => {
    // Regression coverage: the fallback branch used to drop the name whenever
    // a caller supplied `extraContent`, because the label collapsed to just
    // the extra node. Both have to survive - the extra line is appended
    // UNDER the name, never in place of it.
    renderHover({
      hostId: null,
      ownerKind: null,
      ownerHostUnreachable: false,
      roleClaims: [],
      side: "top",
      extraContent: (
        <span data-testid="caller-extra">Working · large model</span>
      ),
    });

    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));

    // Wait for the tooltip content to actually mount before counting - the
    // trigger's own "Reviewer" already exists in the document, so a plain
    // findAllByText resolves on that single match without ever waiting for
    // the tooltip to open.
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Reviewer");
    expect(tooltip.textContent).toContain("Working · large model");
    // One "Reviewer" is the trigger button's own label; the other is the
    // tooltip content TooltipWrapper renders on hover - so finding two is
    // what proves the name reached the tooltip rather than just the trigger.
    expect(screen.getAllByText("Reviewer")).toHaveLength(2);
  });

  it("keeps the agent name alongside extra content when the owner host is unreachable", async () => {
    // Same fallback branch, reached through the OTHER gate: an owner host that
    // cannot be reached degrades from the rich card to this same tooltip, so
    // the name-plus-extra guarantee has to hold here too.
    renderHover({
      hostId: "host-a",
      ownerKind: "chat",
      ownerHostUnreachable: true,
      roleClaims: [],
      side: "top",
      extraContent: (
        <span data-testid="caller-extra">Working · large model</span>
      ),
    });

    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Reviewer");
    expect(tooltip.textContent).toContain("Working · large model");
    expect(screen.getAllByText("Reviewer")).toHaveLength(2);
  });
});

function sandboxRow(overrides: Partial<SandboxSummary>): SandboxSummary {
  const parsed = sandboxSummarySchema.parse({
    id: "sbx-1",
    hostId: "host-sbx",
    kind: "agent",
    provider: "tensorlake",
    region: "us",
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: 10240,
    displayName: "build-box",
    state: "awake",
    frozen: false,
    failureCode: null,
    idleMinutes: 30,
    destroyAfterRestingMinutes: 7 * 24 * 60,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    createdAt: 0,
    lastTransitionAt: Date.now() - 12 * 60_000,
    lastActivityAt: null,
    destroyedAt: null,
    priceMcPerHour: { awakeMc: 120, suspendedMc: 1, stoppedMc: 1 },
    createdBy: { userId: "user-1", displayName: "Sam" },
    wakePayer: { userId: "user-1", displayName: "Sam" },
  });
  return { ...parsed, ...overrides };
}

function taskHostRow(overrides: Partial<TaskHostRow>): TaskHostRow {
  return {
    hostId: "host-t",
    label: "team-box",
    principal: { kind: "team", id: "team-1" },
    reach: "same_principal",
    ...overrides,
  };
}

function tasksView(...hosts: readonly TaskHostRow[]): TaskHostsView {
  return { kind: "hosts", hosts };
}

function renderAgent(
  overrides: Pick<
    HoverOverrides,
    "hostId" | "ownerKind" | "ownerHostUnreachable"
  >,
) {
  return renderHover({
    ...overrides,
    roleClaims: [],
    side: "top",
    ...NO_EXTRA,
  });
}

describe("AgentHoverTooltip host section", () => {
  it("shows host identity, cost, payer, shape and actions for a row in the viewer's sandbox list", () => {
    h.sandboxes = [sandboxRow({})];
    h.cost = [{ sandboxId: "sbx-1", todayMillicredits: 2000 }];
    h.busySessionCount = 3;
    h.agents = [
      { id: "agent-3", hostId: "host-sbx", title: "Creator", active: true },
    ];
    h.terminals = [
      {
        sessionId: "t-1",
        title: "build",
        status: "running",
        sessionKind: "terminal",
      },
    ];
    renderAgent({
      hostId: "host-sbx",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });

    const text = screen.getByTestId("worktree-host-section").textContent;
    expect(text).toContain("Host");
    expect(text).toContain("build-box");
    expect(text).toContain(SANDBOX_PUBLIC_STATE_LABEL.awake);
    expect(text).toContain("Acme");
    expect(text).toContain(shortPriceLabel(120));
    expect(text).toContain("Sandbox · Linux · 2 vCPU · 4 GB");
    expect(text).toContain("started by you");
    expect(text).toContain("paid by you");
    expect(text).toMatch(/\d+ min awake/);
    expect(text).toContain(hoverTodayCost(2000));
    expect(text).toContain("Suspends after 30 idle min");
    expect(text).toContain("destroyed after 7 resting days");
    expect(text).toContain("Creator, build");
    expect(text).toContain("1 more in other tasks");
    for (const name of ["Open terminal", "Files", "Details"]) {
      expect(screen.getByRole("button", { name })).toBeDefined();
    }
    expect(screen.queryByRole("button", { name: TASK_FILES })).toBeNull();
    expect(
      screen.queryByRole("button", { name: KEEP_THIS_SANDBOX }),
    ).toBeNull();
  });

  describe("the configuration line under the name", () => {
    const configuration = () =>
      screen.queryByTestId("agent-host-configuration")?.textContent;
    const renderHostSandbox = () => {
      h.sandboxes = [sandboxRow({})];
      renderAgent({
        hostId: "host-sbx",
        ownerKind: "chat",
        ownerHostUnreachable: false,
      });
    };

    it("reads Personal for a sandbox with no registry owner whose environment is outside every team's", () => {
      h.registryOwner = null;
      h.configurations = {
        configurations: [
          { kind: "personal" },
          {
            kind: "team",
            teamId: "team-1",
            teamName: "Acme",
            environmentId: "env-acme",
          },
        ],
        teamEnvironmentIds: new Set(["env-acme"]),
        complete: true,
      };
      h.sandboxes = [sandboxRow({ environmentId: "env-elsewhere" })];
      renderAgent({
        hostId: "host-sbx",
        ownerKind: "chat",
        ownerHostUnreachable: false,
      });
      expect(configuration()).toBe("Personal");
    });

    it("reads the team's name for a team environment's sandbox with no registry owner", () => {
      h.registryOwner = null;
      h.configurations = {
        configurations: [
          { kind: "personal" },
          {
            kind: "team",
            teamId: "team-1",
            teamName: "Acme",
            environmentId: "env-acme",
          },
        ],
        teamEnvironmentIds: new Set(["env-acme"]),
        complete: true,
      };
      h.sandboxes = [sandboxRow({ environmentId: "env-acme" })];
      renderAgent({
        hostId: "host-sbx",
        ownerKind: "chat",
        ownerHostUnreachable: false,
      });
      expect(configuration()).toBe("Acme");
    });

    it("reads Personal for a registry owner of kind user", () => {
      h.registryOwner = { kind: "user", userId: "user-1" };
      h.sandboxes = [sandboxRow({ environmentId: "env-elsewhere" })];
      renderAgent({
        hostId: "host-sbx",
        ownerKind: "chat",
        ownerHostUnreachable: false,
      });
      expect(configuration()).toBe("Personal");
    });

    it("shows no configuration while a team has not answered", () => {
      h.registryOwner = null;
      h.sandboxes = [sandboxRow({ environmentId: "env-elsewhere" })];
      renderAgent({
        hostId: "host-sbx",
        ownerKind: "chat",
        ownerHostUnreachable: false,
      });
      expect(configuration()).toBeUndefined();
    });

    it("is a line under the name, not a badge beside it", () => {
      renderHostSandbox();
      const line = screen.getByTestId("agent-host-configuration");
      expect(line.textContent).toBe("Acme");
      expect(line.tagName).toBe("P");
      expect(screen.getByText("build-box").parentElement?.contains(line)).toBe(
        false,
      );
    });
  });

  it("reads a day's cost below a cent as under $0.01 and a cent or more in dollars", () => {
    h.sandboxes = [sandboxRow({})];
    h.cost = [{ sandboxId: "sbx-1", todayMillicredits: 3 }];
    renderAgent({
      hostId: "host-sbx",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });
    expect(screen.getByTestId("worktree-host-section").textContent).toContain(
      " · under $0.01 today",
    );
    cleanup();
    h.cost = [{ sandboxId: "sbx-1", todayMillicredits: 20 }];
    renderAgent({
      hostId: "host-sbx",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });
    expect(screen.getByTestId("worktree-host-section").textContent).toContain(
      " · $0.02 today",
    );
  });

  describe("what runs on the host", () => {
    function renderAwake(): void {
      h.sandboxes = [sandboxRow({})];
      h.busySessionCount = 2;
      renderAgent({
        hostId: "host-sbx",
        ownerKind: "chat",
        ownerHostUnreachable: false,
      });
    }

    it("says how many agents and terminals run on the host, after the idle policy", () => {
      h.sessions = {
        agents: [agentSessionFixture({})],
        terminals: [terminalSessionFixture({})],
      };
      renderAwake();

      const section = screen.getByTestId("worktree-host-section");
      const activity = screen.getByTestId("agent-host-activity");
      expect(activity.textContent).toBe("1 agent and 1 terminal on it");
      const idle = within(section).getByText("Suspends after 30 idle min", {
        exact: false,
      });
      expect(
        idle.compareDocumentPosition(activity) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("counts an idle terminal the busy count leaves out", () => {
      h.sessions = {
        agents: [],
        terminals: [terminalSessionFixture({})],
      };
      renderAwake();

      expect(screen.getByTestId("agent-host-activity").textContent).toBe(
        "1 terminal on it",
      );
    });

    it("draws no host-wide line when the host sends no list", () => {
      h.sessions = null;
      renderAwake();

      expect(screen.queryByTestId("agent-host-activity")).toBeNull();
    });

    it("draws no host-wide line when nothing runs", () => {
      h.sessions = { agents: [], terminals: [] };
      renderAwake();

      expect(screen.queryByTestId("agent-host-activity")).toBeNull();
    });
  });

  it("opens a terminal tile on a resting sandbox, whose create waits for the host's cwd", async () => {
    h.sandboxes = [sandboxRow({ state: "suspended" })];
    renderAgent({
      hostId: "host-sbx",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Open terminal" }),
    );
    expect(h.openTile).toHaveBeenCalledTimes(1);
    const [intent] = h.openTile.mock.calls[0] as [
      { readonly node: { readonly type: string; readonly hostId: string } },
    ];
    expect(intent.node).toMatchObject({ type: "terminal", hostId: "host-sbx" });
    expect(
      listEpicTerminalDurableCreateJobsForEpic("epic-1").map((job) => [
        job.hostId,
        job.cwd,
      ]),
    ).toEqual([["host-sbx", ""]]);
  });

  it("says sessions are unknown rather than inventing a count when no status is held", () => {
    h.sandboxes = [sandboxRow({})];
    renderAgent({
      hostId: "host-sbx",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });

    expect(screen.getByTestId("worktree-host-section").textContent).toContain(
      SESSIONS_UNKNOWN,
    );
  });

  it("opens Details for the row from the viewer's list", async () => {
    h.sandboxes = [sandboxRow({})];
    renderAgent({
      hostId: "host-sbx",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });

    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(h.openDetails).toHaveBeenCalledWith("sbx-1");
  });

  it("shows only the approved label, configuration, reach and task files for a task-only host", async () => {
    h.teams = [{ teamId: "team-1", slug: "acme" }];
    h.taskHosts = tasksView(taskHostRow({ reach: "other_principal" }));
    renderAgent({
      hostId: "host-t",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });

    // A task row never authorizes the owner card: it is the plain card with the
    // host section, not the worktree tooltip.
    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));
    const card = await screen.findByRole("dialog", { name: "Reviewer" });
    const text = card.textContent;

    expect(text).toContain("team-box");
    expect(text).toContain(hoverTaskConfiguration("acme"));
    expect(text).toContain(reachSentence(REACH_UNNAMED_HOSTS));
    // Other agents the task shows on that host; never the viewing agent.
    expect(text).toContain(hoverAlsoInTask("Planner"));
    expect(text).not.toContain("Reviewer,");

    expect(screen.getByRole("button", { name: TASK_FILES })).toBeDefined();
    for (const name of ["Open terminal", "Details", KEEP_THIS_SANDBOX]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(text).not.toMatch(/\$|paid by|vCPU|started by|awake|Suspends/);

    await userEvent.click(screen.getByRole("button", { name: TASK_FILES }));
    expect(h.setPanel).toHaveBeenCalledWith("tab-1", "artifacts");
  });

  it("names the configuration generically when the viewer is not in the team, and omits the reach sentence for a reachable host", async () => {
    h.taskHosts = tasksView(taskHostRow({ reach: "same_principal" }));
    renderAgent({
      hostId: "host-t",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });

    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));
    const text = (await screen.findByRole("dialog", { name: "Reviewer" }))
      .textContent;

    expect(text).toContain(hoverTaskConfiguration(null));
    expect(text).not.toContain(reachSentence(REACH_UNNAMED_HOSTS));
  });

  it("gives a person's own computer no host section", () => {
    h.taskHosts = tasksView(taskHostRow({ label: null }));
    renderAgent({
      hostId: "host-t",
      ownerKind: "chat",
      ownerHostUnreachable: false,
    });

    expect(screen.queryByText("Host")).toBeNull();
    expect(screen.getByTestId("worktree-owner-tooltip")).toBeDefined();
  });

  it("keeps the host section for an unreachable owner and drops owner metadata", async () => {
    h.sandboxes = [sandboxRow({})];
    renderAgent({
      hostId: "host-sbx",
      ownerKind: "chat",
      ownerHostUnreachable: true,
    });

    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));
    const text = (await screen.findByRole("dialog", { name: "Reviewer" }))
      .textContent;

    expect(text).toContain("build-box");
    expect(text).toContain(SESSIONS_UNKNOWN);
    expect(
      screen.getByRole("button", { name: "Files" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the Keep dialog open after the hover card closes", async () => {
    h.sandboxes = [sandboxRow({ burst: true, createdByAgentId: "agent-3" })];
    renderAgent({
      hostId: "host-sbx",
      ownerKind: null,
      ownerHostUnreachable: false,
    });

    const trigger = screen.getByRole("button", { name: "Reviewer" });
    await userEvent.hover(trigger);
    await userEvent.click(
      await screen.findByRole("button", { name: KEEP_THIS_SANDBOX }),
    );
    expect(screen.getByTestId("keep-dialog").textContent).toBe("sbx-1");

    await userEvent.unhover(trigger);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Reviewer" })).toBeNull();
    });
    expect(screen.getByTestId("keep-dialog").textContent).toBe("sbx-1");
  });

  describe("held session snapshot", () => {
    const SHOWN = "Creator, build";

    function holdSessions(count: number, at: number): void {
      h.sandboxes = [sandboxRow({})];
      h.busySessionCount = count;
      h.statusUpdatedAt = at;
      h.listUpdatedAt = at;
      h.agents = [
        { id: "agent-3", hostId: "host-sbx", title: "Creator", active: true },
      ];
      h.terminals = [
        {
          sessionId: "t-1",
          title: "build",
          status: "running",
          sessionKind: "terminal",
        },
      ];
    }

    function sectionText(): string {
      return screen.getByTestId("worktree-host-section").textContent;
    }

    it("stops trusting a held host.status exactly 30 seconds after it was read", () => {
      vi.useFakeTimers();
      holdSessions(3, Date.now());
      renderAgent({
        hostId: "host-sbx",
        ownerKind: "chat",
        ownerHostUnreachable: false,
      });
      expect(sectionText()).toContain(SHOWN);

      act(() => {
        vi.advanceTimersByTime(29_999);
      });
      expect(sectionText()).toContain(SHOWN);
      expect(sectionText()).not.toContain(SESSIONS_UNKNOWN);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(sectionText()).toContain(SESSIONS_UNKNOWN);
      expect(sectionText()).not.toContain(SHOWN);
    });

    it("shows unknown while the task lists predate a newer held count, then the refreshed names", () => {
      const base = Date.now();
      holdSessions(3, base);
      const view = renderAgent({
        hostId: "host-sbx",
        ownerKind: "chat",
        ownerHostUnreachable: false,
      });
      // A fresh element each time, so React re-renders and re-reads the mocks.
      const rerenderSame = (current: typeof view): void => {
        current.rerender(
          hoverTree({
            hostId: "host-sbx",
            ownerKind: "chat",
            ownerHostUnreachable: false,
            roleClaims: [],
            side: "top",
            ...NO_EXTRA,
          }),
        );
      };
      expect(sectionText()).toContain(SHOWN);
      expect(sectionText()).toContain("1 more in other tasks");
      // The held status asks the task lists to refresh once.
      expect(h.refetchAgents).toHaveBeenCalledTimes(1);
      expect(h.refetchTerminals).toHaveBeenCalledTimes(1);

      // A newer count lands while both snapshots are older than it: combining
      // them would call the new work "in other tasks".
      h.busySessionCount = 5;
      h.statusUpdatedAt = base + 1_000;
      rerenderSame(view);
      expect(sectionText()).toContain(SESSIONS_UNKNOWN);
      expect(sectionText()).not.toContain(SHOWN);
      expect(sectionText()).not.toContain("more in other tasks");
      expect(h.refetchAgents).toHaveBeenCalledTimes(2);
      expect(h.refetchTerminals).toHaveBeenCalledTimes(2);

      // A snapshot that is still being fetched is not current either.
      h.listUpdatedAt = base + 1_000;
      h.listFetching = true;
      rerenderSame(view);
      expect(sectionText()).toContain(SESSIONS_UNKNOWN);

      h.listFetching = false;
      rerenderSame(view);
      expect(sectionText()).toContain(SHOWN);
      expect(sectionText()).toContain("3 more in other tasks");
    });
  });
});
