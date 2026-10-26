import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import type { HostSwitcherAction } from "@/components/settings/host-scope/host-switcher";
import type { HostPickIntent } from "@/components/settings/host-scope/host-option-model";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));
// Why this build cannot reach the sandbox control plane, or null. Only the
// one reader of it is replaced: the rest of the module stays real.
const control = vi.hoisted(() => ({
  unavailableReason: null as string | null,
}));
vi.mock("@/providers/use-runner-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/use-runner-host")>()),
  useRunnerHostOrNull: () =>
    control.unavailableReason === null
      ? null
      : { sandboxControlUnavailableReason: control.unavailableReason },
}));
vi.mock("@/lib/sandboxes/sandbox-wake", () => ({
  wakeSandboxOnPick: vi.fn(),
}));

/**
 * The host switcher draws one group per team the
 * person is in, titled with the team's name, with its own collapsed "Agent
 * sandboxes" sub-group; a sandbox whose registry row carries no `owner` stays
 * in the person's own "Sandboxes" group.
 */

const TEAM_A: HostOwnerPrincipal = {
  kind: "team",
  id: "team-a",
  name: "Alpha",
};
const TEAM_B: HostOwnerPrincipal = {
  kind: "team",
  id: "team-b",
  name: "Bravo",
};

const onSelect = vi.fn<(hostId: string) => void>();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  control.unavailableReason = null;
  useAuthStore.setState({ status: "signed-out" });
});

function registryItem(
  hostId: string,
  owner: HostOwnerPrincipal | undefined,
): HostListItem {
  const base: HostListItem = {
    hostId,
    displayName: hostId,
    platform: "linux-x64",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: new Date(0).toISOString(),
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: new Date(0).toISOString(),
    },
  };
  return owner === undefined ? base : { ...base, owner };
}

function sandboxRow(
  hostId: string,
  owner: HostOwnerPrincipal | undefined,
  summary: Partial<SandboxSummary>,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: hostId,
    kind: "sandbox",
    isLocalMachine: false,
    isActive: false,
    item: registryItem(hostId, owner),
    sandbox: {
      state: "awake",
      frozen: false,
      summary: sandboxSummaryFixture({
        id: `sbx-${hostId}`,
        hostId,
        ...summary,
      }),
      teamOwned: owner?.kind === "team",
    },
  });
}

const PERSONAL = hostScopeOptionFixture({
  hostId: "laptop",
  name: "Laptop",
  isActive: true,
});

const PICKER_ACTION: HostSwitcherAction = {
  kind: "manage-hosts",
  onSelect: () => undefined,
};
const HOST_LIST_ACTION: HostSwitcherAction = {
  kind: "add-host",
  onSelect: () => undefined,
};

function renderSwitcher(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly action: HostSwitcherAction;
  readonly intent: HostPickIntent;
}): void {
  render(
    <HostSwitcher
      refusalByHostId={NO_HOST_OPTION_REFUSALS}
      inertExceptHostId={null}
      hosts={input.hosts}
      selected={PERSONAL}
      activeHostId={PERSONAL.hostId}
      onSelect={onSelect}
      action={input.action}
      surface="field"
      intent={input.intent}
      disabled={false}
      isLoading={false}
      listsFailed={false}
      onRetryLists={() => undefined}
      updateViewForHost={null}
      environmentLabelForHost={null}
      composer={null}
    />,
  );
  fireEvent.click(screen.getByTestId("settings-host-switcher"));
}

function row(hostId: string): HTMLElement {
  return screen.getByTestId(`settings-host-switcher-option-${hostId}`);
}

function teamGroup(teamId: string): HTMLElement {
  return screen.getByTestId(`settings-host-switcher-team-${teamId}`);
}

function anyTeamGroup(): Element | null {
  return document.querySelector(
    '[data-testid^="settings-host-switcher-team-"]',
  );
}

describe("<HostSwitcher /> team groups", () => {
  it("draws one group per team, titled by the team's name, holding that team's sandboxes", () => {
    renderSwitcher({
      hosts: [
        PERSONAL,
        sandboxRow("alpha-1", TEAM_A, {}),
        sandboxRow("bravo-1", TEAM_B, {}),
        sandboxRow("alpha-2", TEAM_A, {}),
      ],
      action: HOST_LIST_ACTION,
      intent: "view",
    });

    const alpha = teamGroup("team-a");
    const bravo = teamGroup("team-b");
    const alphaToggle = screen.getByTestId(
      "settings-host-switcher-team-team-a-toggle",
    );
    expect(alphaToggle.textContent).toContain("Alpha");
    // The count is the team's rows.
    expect(alphaToggle.textContent).toContain("2");
    expect(
      screen.getByTestId("settings-host-switcher-team-team-b-toggle")
        .textContent,
    ).toContain("Bravo");
    expect(alpha.contains(row("alpha-1"))).toBe(true);
    expect(alpha.contains(row("alpha-2"))).toBe(true);
    expect(alpha.contains(row("bravo-1"))).toBe(false);
    expect(bravo.contains(row("bravo-1"))).toBe(true);
  });

  it("orders the team groups by team name", () => {
    renderSwitcher({
      hosts: [
        PERSONAL,
        sandboxRow("bravo-1", TEAM_B, {}),
        sandboxRow("alpha-1", TEAM_A, {}),
      ],
      action: HOST_LIST_ACTION,
      intent: "view",
    });
    const order = teamGroup("team-a").compareDocumentPosition(
      teamGroup("team-b"),
    );
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a team's sandbox out of the person's own Sandboxes group, and the person's own out of the team's", () => {
    renderSwitcher({
      hosts: [
        PERSONAL,
        sandboxRow("mine", { kind: "user", id: "user-me" }, {}),
        sandboxRow("alpha-1", TEAM_A, {}),
      ],
      action: HOST_LIST_ACTION,
      intent: "view",
    });
    const own = screen.getByTestId("settings-host-switcher-sandboxes");
    expect(own.contains(row("mine"))).toBe(true);
    expect(own.contains(row("alpha-1"))).toBe(false);
    expect(teamGroup("team-a").contains(row("mine"))).toBe(false);
    expect(teamGroup("team-a").contains(row("alpha-1"))).toBe(true);
  });

  it("keeps a sandbox whose registry row has no owner in Sandboxes, and draws no team group for it", () => {
    renderSwitcher({
      hosts: [PERSONAL, sandboxRow("legacy", undefined, {})],
      action: HOST_LIST_ACTION,
      intent: "view",
    });
    expect(
      screen
        .getByTestId("settings-host-switcher-sandboxes")
        .contains(row("legacy")),
    ).toBe(true);
    expect(anyTeamGroup()).toBeNull();
  });

  it("draws no team group when no row is team-owned", () => {
    renderSwitcher({
      hosts: [PERSONAL, sandboxRow("mine", { kind: "user", id: "u" }, {})],
      action: HOST_LIST_ACTION,
      intent: "view",
    });
    expect(anyTeamGroup()).toBeNull();
  });

  it("lists a team's sandboxes and never its Automations pod", () => {
    renderSwitcher({
      hosts: [
        PERSONAL,
        sandboxRow("alpha-1", TEAM_A, {}),
        sandboxRow("alpha-pod", TEAM_A, { kind: "automation" }),
      ],
      action: HOST_LIST_ACTION,
      intent: "view",
    });
    expect(teamGroup("team-a").contains(row("alpha-1"))).toBe(true);
    expect(
      screen.queryByTestId("settings-host-switcher-option-alpha-pod"),
    ).toBeNull();
  });

  it("selects a team's sandbox row on a click", () => {
    renderSwitcher({
      hosts: [PERSONAL, sandboxRow("alpha-1", TEAM_A, {})],
      action: HOST_LIST_ACTION,
      intent: "view",
    });
    fireEvent.click(row("alpha-1"));
    expect(onSelect).toHaveBeenCalledWith("alpha-1");
  });
});

describe("<HostSwitcher /> a team's Agent sandboxes", () => {
  const hosts = [
    PERSONAL,
    sandboxRow("alpha-1", TEAM_A, {}),
    sandboxRow("alpha-burst", TEAM_A, { burst: true }),
    sandboxRow("bravo-1", TEAM_B, {}),
  ];

  it("nests an Agent sandboxes collapsible inside the team's group, collapsed until it is opened", () => {
    renderSwitcher({ hosts, action: HOST_LIST_ACTION, intent: "view" });

    const inner = screen.getByTestId(
      "settings-host-switcher-team-team-a-agent-sandboxes",
    );
    expect(teamGroup("team-a").contains(inner)).toBe(true);
    expect(inner.textContent).toContain("Agent sandboxes");
    expect(
      screen.queryByTestId("settings-host-switcher-option-alpha-burst"),
    ).toBeNull();
    // The team's own rows are open by default.
    expect(row("alpha-1")).toBeDefined();

    fireEvent.click(
      screen.getByTestId(
        "settings-host-switcher-team-team-a-agent-sandboxes-toggle",
      ),
    );
    expect(inner.contains(row("alpha-burst"))).toBe(true);
    expect(inner.contains(row("alpha-1"))).toBe(false);
  });

  it("draws the inner collapsible only for a team that has an agent sandbox", () => {
    renderSwitcher({ hosts, action: HOST_LIST_ACTION, intent: "view" });
    expect(
      screen.queryByTestId(
        "settings-host-switcher-team-team-b-agent-sandboxes",
      ),
    ).toBeNull();
  });

  it("keeps the person's own Agent sandboxes group apart from the team's", () => {
    renderSwitcher({
      hosts: [
        ...hosts,
        sandboxRow("mine-burst", { kind: "user", id: "u" }, { burst: true }),
      ],
      action: HOST_LIST_ACTION,
      intent: "view",
    });
    const own = screen.getByTestId("settings-host-switcher-agent-sandboxes");
    const inner = screen.getByTestId(
      "settings-host-switcher-team-team-a-agent-sandboxes",
    );
    expect(own).not.toBe(inner);
    expect(teamGroup("team-a").contains(own)).toBe(false);
  });

  it("offers no agent sandbox of a team in a picker", () => {
    renderSwitcher({ hosts, action: PICKER_ACTION, intent: "bind" });
    expect(
      screen.queryByTestId(
        "settings-host-switcher-team-team-a-agent-sandboxes",
      ),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-option-alpha-burst"),
    ).toBeNull();
    expect(teamGroup("team-a").contains(row("alpha-1"))).toBe(true);
  });
});

describe("<HostSwitcher /> a team group", () => {
  it("has no New sandbox entry: creation left the host list", () => {
    useAuthStore.setState({ status: "signed-in" });
    renderSwitcher({
      hosts: [PERSONAL, sandboxRow("alpha-1", TEAM_A, {})],
      action: HOST_LIST_ACTION,
      intent: "view",
    });

    expect(teamGroup("team-a")).toBeDefined();
    expect(
      screen.queryByTestId("settings-host-switcher-team-team-a-new-sandbox"),
    ).toBeNull();
  });
});
