import type { KeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import type { HostSwitcherComposerMode } from "@/components/settings/host-scope/host-switcher";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HostPickIntent } from "@/components/settings/host-scope/host-option-model";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type {
  HostScopeOption,
  HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));
// The wake is the sandbox-wake suite's concern; here only whether a pick asks.
vi.mock("@/lib/sandboxes/sandbox-wake", () => ({
  wakeSandboxOnPick: vi.fn(),
}));

import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";

const VIEWER = "user-me";
const TEAM_A: HostOwnerPrincipal = {
  kind: "team",
  id: "team-a",
  name: "Alpha",
};

/** Calls in the order they happened, across the composer and the surface. */
const calls: string[] = [];
const onSelect = vi.fn<(hostId: string) => void>((hostId) => {
  calls.push(`select:${hostId}`);
});
const onPickHost = vi.fn<(host: HostScopeOption) => void>((host) => {
  calls.push(`pick:${host.hostId}`);
});
const onPickNew = vi.fn<(configurationKey: string) => boolean | void>();
const onOpenShape = vi.fn<(configurationKey: string) => void>();
const onManage = vi.fn<() => void>();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  calls.length = 0;
});

function sandboxHost(
  hostId: string,
  state: "awake" | "suspended",
  overrides: Partial<HostScopeSandbox>,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: hostId,
    isLocalMachine: false,
    isActive: false,
    connectable: state === "awake",
    kind: "sandbox",
    sandbox: {
      state,
      frozen: false,
      summary: sandboxSummaryFixture({
        id: `sbx-${hostId}`,
        hostId,
        state,
        createdBy: { userId: VIEWER, displayName: "Me" },
      }),
      teamOwned: true,
      ...overrides,
    },
  });
}

function physicalTeamHost(hostId: string): HostScopeOption {
  const item: HostListItem = {
    hostId,
    displayName: hostId,
    platform: "linux-x64",
    kind: "machine",
    publicKey: "pk",
    createdAt: new Date(0).toISOString(),
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: null,
    },
    owner: TEAM_A,
  };
  return hostScopeOptionFixture({
    hostId,
    name: hostId,
    isLocalMachine: false,
    isActive: false,
    connectable: true,
    kind: "machine",
    item,
    sandbox: null,
  });
}

const LAPTOP = hostScopeOptionFixture({
  hostId: "laptop",
  name: "Laptop",
  isActive: true,
});
const AWAKE = sandboxHost("sbx-awake", "awake", {});
const SUSPENDED = sandboxHost("sbx-suspended", "suspended", {});

function composerMode(
  overrides: Partial<HostSwitcherComposerMode>,
): HostSwitcherComposerMode {
  return {
    viewerUserId: VIEWER,
    inThisTask: null,
    subLinesFor: () => [],
    tagFor: () => null,
    newRows: [
      {
        configurationKey: "personal",
        label: "New Personal sandbox",
        subLine: "2 vCPU · 4 GB · $0.12/h · uses your credits",
        configuration: { kind: "personal" },
        disabled: false,
      },
      {
        configurationKey: "team-acme",
        label: "New Acme sandbox",
        subLine: "2 vCPU · 4 GB · $0.12/h · uses your Acme credits",
        configuration: { kind: "team", teamName: "Acme" },
        disabled: false,
      },
    ],
    rememberedConfigurationKey: null,
    stagedConfigurationKey: null,
    stagedLabel: null,
    stagedBusy: false,
    onPickHost,
    onPickNew,
    onOpenShape,
    onManage,
    ...overrides,
  };
}

function renderPicker(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly selected: HostScopeOption;
  readonly composer: HostSwitcherComposerMode | null;
  readonly intent: HostPickIntent;
  readonly onAncestorKeyDown:
    | ((event: KeyboardEvent<HTMLElement>) => void)
    | null;
}): void {
  render(
    <div role="presentation" onKeyDown={input.onAncestorKeyDown ?? undefined}>
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={input.hosts}
        selected={input.selected}
        activeHostId={LAPTOP.hostId}
        onSelect={onSelect}
        action={null}
        surface="field"
        intent={input.intent}
        consequence={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        environmentLabelForHost={null}
        composer={input.composer}
      />
    </div>,
  );
  fireEvent.click(screen.getByTestId("settings-host-switcher"));
}

function renderSwitcher(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly composer: HostSwitcherComposerMode | null;
  readonly intent: HostPickIntent;
}): void {
  renderPicker({ ...input, selected: LAPTOP, onAncestorKeyDown: null });
}

function row(hostId: string): HTMLElement {
  return screen.getByTestId(`settings-host-switcher-option-${hostId}`);
}

/**
 * jsdom paints no layout. Report one label as cut off so the trigger's
 * tooltip opens, and put the prototype back for the tests that follow.
 */
function stubStagedLabelOverflow(label: string): () => void {
  const originalScrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  const originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent === label ? 240 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent === label ? 100 : 0;
    },
  });
  return () => {
    restoreMeasuredProperty("scrollWidth", originalScrollWidth);
    restoreMeasuredProperty("clientWidth", originalClientWidth);
  };
}

function restoreMeasuredProperty(
  name: "scrollWidth" | "clientWidth",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
    return;
  }
  Object.defineProperty(HTMLElement.prototype, name, descriptor);
}

describe("<HostSwitcher /> composer mode picks", () => {
  it.each(["pin", "bind"] as const)(
    "stages a suspended sandbox on a %s pick: the composer hears it, then the surface, and nothing wakes",
    (intent) => {
      renderSwitcher({
        hosts: [LAPTOP, SUSPENDED],
        composer: composerMode({}),
        intent,
      });
      fireEvent.click(
        screen.getByTestId("host-switcher-sandboxes-you-started-toggle"),
      );

      fireEvent.click(row("sbx-suspended"));

      expect(onPickHost).toHaveBeenCalledWith(SUSPENDED);
      expect(onSelect).toHaveBeenCalledWith("sbx-suspended");
      expect(calls).toEqual(["pick:sbx-suspended", "select:sbx-suspended"]);
      expect(wakeSandboxOnPick).not.toHaveBeenCalled();
    },
  );

  it("still wakes a suspended sandbox on a pin pick when there is no composer mode", () => {
    renderSwitcher({
      hosts: [LAPTOP, SUSPENDED],
      composer: null,
      intent: "pin",
    });

    fireEvent.click(row("sbx-suspended"));

    expect(wakeSandboxOnPick).toHaveBeenCalledWith(SUSPENDED, null);
    expect(onSelect).toHaveBeenCalledWith("sbx-suspended");
    expect(onPickHost).not.toHaveBeenCalled();
  });

  it("picks a personal computer through the composer too", () => {
    renderSwitcher({
      hosts: [LAPTOP, AWAKE],
      composer: composerMode({}),
      intent: "pin",
    });

    fireEvent.click(row("laptop"));

    expect(calls).toEqual(["pick:laptop", "select:laptop"]);
  });
});

describe("<HostSwitcher /> composer mode groups", () => {
  it("keeps a physical team computer in its team group and lets the composer pick it", () => {
    const teamMachine = physicalTeamHost("team-machine");
    renderSwitcher({
      hosts: [LAPTOP, AWAKE, teamMachine],
      composer: composerMode({}),
      intent: "pin",
    });

    const team = screen.getByTestId("settings-host-switcher-team-team-a");
    expect(team.contains(row("team-machine"))).toBe(true);
    expect(
      screen.getByTestId("host-switcher-yours").contains(row("team-machine")),
    ).toBe(false);
    expect(
      screen
        .getByTestId("host-switcher-sandboxes-you-started")
        .contains(row("team-machine")),
    ).toBe(false);

    fireEvent.click(row("team-machine"));
    expect(calls).toEqual(["pick:team-machine", "select:team-machine"]);
  });

  it("lists Yours, then Sandboxes you started collapsed behind `N · M awake`", () => {
    renderSwitcher({
      hosts: [LAPTOP, AWAKE, SUSPENDED],
      composer: composerMode({}),
      intent: "pin",
    });

    expect(
      within(screen.getByTestId("host-switcher-yours")).getByText("Yours"),
    ).toBeDefined();
    expect(
      screen
        .getByTestId("host-switcher-yours")
        .contains(screen.getByTestId("settings-host-switcher-option-laptop")),
    ).toBe(true);

    const started = screen.getByTestId("host-switcher-sandboxes-you-started");
    expect(started.textContent).toContain("Sandboxes you started");
    expect(started.textContent).toContain("2 · 1 awake");
    expect(
      screen.queryByTestId("settings-host-switcher-option-sbx-awake"),
    ).toBeNull();

    fireEvent.click(
      screen.getByTestId("host-switcher-sandboxes-you-started-toggle"),
    );
    expect(started.contains(row("sbx-awake"))).toBe(true);
    expect(started.contains(row("sbx-suspended"))).toBe(true);
  });

  it("leaves out a team sandbox the viewer neither started nor kept", () => {
    const strangers = sandboxHost("sbx-strangers", "awake", {});
    const summary = strangers.sandbox?.summary;
    if (
      strangers.sandbox === null ||
      summary === null ||
      summary === undefined
    ) {
      throw new Error("fixture has no summary");
    }
    const others: HostScopeOption = {
      ...strangers,
      sandbox: {
        ...strangers.sandbox,
        summary: {
          ...summary,
          createdBy: { userId: "user-ada", displayName: "Ada" },
        },
      },
    };
    renderSwitcher({
      hosts: [LAPTOP, AWAKE, others],
      composer: composerMode({}),
      intent: "pin",
    });
    fireEvent.click(
      screen.getByTestId("host-switcher-sandboxes-you-started-toggle"),
    );

    expect(
      screen.getByTestId("host-switcher-sandboxes-you-started").textContent,
    ).toContain("1 · 1 awake");
    expect(
      screen.queryByTestId("settings-host-switcher-option-sbx-strangers"),
    ).toBeNull();
  });

  it("lists the hosts the task uses first, once, under In this task", () => {
    renderSwitcher({
      hosts: [LAPTOP, AWAKE],
      composer: composerMode({ inThisTask: [AWAKE] }),
      intent: "pin",
    });

    const inTask = screen.getByTestId("host-switcher-in-this-task");
    expect(inTask.textContent).toContain("In this task");
    expect(inTask.contains(row("sbx-awake"))).toBe(true);
    expect(
      screen.queryByTestId("host-switcher-sandboxes-you-started"),
    ).toBeNull();
  });

  it("shows a host's local line under its name before any disclosure", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({
        subLinesFor: (hostId) =>
          hostId === "laptop" ? ["Local · runs its own settings"] : [],
      }),
      intent: "pin",
    });

    const option = row("laptop");
    expect(
      within(option).getByText("Local · runs its own settings"),
    ).toBeDefined();
    expect(option.querySelector("details")).toBeNull();
    expect(onPickHost).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(wakeSandboxOnPick).not.toHaveBeenCalled();
  });

  it("heads the New group with the defining line and lists a row per configuration", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({}),
      intent: "pin",
    });

    const group = screen.getByTestId("host-switcher-new-sandbox");
    expect(group.textContent).toContain(
      "New sandbox · a computer in the cloud, billed by the hour while awake",
    );
    expect(
      screen.getByTestId("host-switcher-new-sandbox-personal").textContent,
    ).toContain("New Personal sandbox");
    expect(
      screen.getByTestId("host-switcher-new-sandbox-team-acme").textContent,
    ).toContain("uses your Acme credits");
  });

  it("collapses the configurations past two behind a header that names them, the remembered one leading", () => {
    const newRows = ["personal", "team-acme", "team-globex"].map(
      (configurationKey) => ({
        configurationKey,
        label: `New ${configurationKey} sandbox`,
        subLine: "2 vCPU · 4 GB",
        configuration:
          configurationKey === "personal"
            ? ({ kind: "personal" } as const)
            : ({ kind: "team", teamName: configurationKey } as const),
        disabled: false,
      }),
    );
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({
        newRows,
        rememberedConfigurationKey: "team-globex",
      }),
      intent: "pin",
    });

    expect(
      screen.getByTestId("host-switcher-new-sandbox-team-globex"),
    ).toBeDefined();
    expect(
      screen.queryByTestId("host-switcher-new-sandbox-personal"),
    ).toBeNull();
    expect(
      screen.getByTestId("host-switcher-new-sandbox-more-toggle").textContent,
    ).toBe("Personal and 1 team: team-acme");

    fireEvent.click(
      screen.getByTestId("host-switcher-new-sandbox-more-toggle"),
    );
    expect(
      screen.getByTestId("host-switcher-new-sandbox-personal"),
    ).toBeDefined();
  });

  describe("the collapsed header", () => {
    function teamRows(
      teamNames: readonly string[],
    ): HostSwitcherComposerMode["newRows"] {
      return [
        {
          configurationKey: "personal",
          label: "New Personal sandbox",
          subLine: "2 vCPU · 4 GB",
          configuration: { kind: "personal" },
          disabled: false,
        },
        ...teamNames.map((teamName) => ({
          configurationKey: `team-${teamName}`,
          label: `New ${teamName} sandbox`,
          subLine: "2 vCPU · 4 GB",
          configuration: { kind: "team", teamName } as const,
          disabled: false,
        })),
      ];
    }

    it("counts and names the four teams behind it, with no `more`, the chevron turning down when opened", () => {
      renderSwitcher({
        hosts: [LAPTOP],
        composer: composerMode({
          newRows: teamRows([
            "e9-frozen-team",
            "pool-e2e-fixture",
            "testteam",
            "traycerai",
          ]),
          rememberedConfigurationKey: "personal",
        }),
        intent: "pin",
      });
      const header =
        "4 teams: e9-frozen-team, pool-e2e-fixture, testteam, traycerai";
      const toggle = screen.getByTestId(
        "host-switcher-new-sandbox-more-toggle",
      );

      expect(toggle.textContent).toBe(header);
      expect(toggle.textContent).not.toContain("more");
      expect(toggle.querySelector("svg.lucide-chevron-right")).not.toBeNull();
      expect(toggle.querySelector("svg.lucide-chevron-down")).toBeNull();

      fireEvent.click(toggle);

      expect(toggle.textContent).toBe(header);
      expect(toggle.querySelector("svg.lucide-chevron-down")).not.toBeNull();
      expect(toggle.querySelector("svg.lucide-chevron-right")).toBeNull();
      expect(
        screen.getByTestId("host-switcher-new-sandbox-team-testteam"),
      ).toBeDefined();
    });

    it("names the two teams behind it when Personal leads", () => {
      renderSwitcher({
        hosts: [LAPTOP],
        composer: composerMode({
          newRows: teamRows(["pool-e2e-fixture", "testteam"]),
          rememberedConfigurationKey: "personal",
        }),
        intent: "pin",
      });

      expect(
        screen.getByTestId("host-switcher-new-sandbox-more-toggle").textContent,
      ).toBe("2 teams: pool-e2e-fixture, testteam");
    });
  });
});

describe("<HostSwitcher /> composer mode New rows", () => {
  it("stages the New row it picks", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({}),
      intent: "pin",
    });

    fireEvent.click(screen.getByTestId("host-switcher-new-sandbox-team-acme"));

    expect(onPickNew).toHaveBeenCalledWith("team-acme");
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("host-switcher-new-sandbox-team-acme"),
    ).toBeNull();
  });

  it("keeps the chooser open when New could not be staged", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({}),
      intent: "pin",
    });
    onPickNew.mockImplementationOnce(() => false);

    fireEvent.click(screen.getByTestId("host-switcher-new-sandbox-team-acme"));

    expect(onPickNew).toHaveBeenCalledWith("team-acme");
    expect(
      screen.getByTestId("host-switcher-new-sandbox-team-acme"),
    ).toBeDefined();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens the shape from the gear without picking the row", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({}),
      intent: "pin",
    });

    fireEvent.click(
      screen.getByTestId("host-switcher-new-sandbox-gear-team-acme"),
    );

    expect(onOpenShape).toHaveBeenCalledWith("team-acme");
    expect(onPickNew).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(wakeSandboxOnPick).not.toHaveBeenCalled();
  });

  // Inline and field share this row. Whether the gear stays inside a
  // narrow container, and whether the label actually truncates, is layout:
  // browser-tests/host-switcher-staged-gear.spec.ts.
  it("keeps the staged shape gear beside the named trigger", async () => {
    const stagedLabel = "New Personal sandbox";
    const restore = stubStagedLabelOverflow(stagedLabel);
    try {
      render(
        <TooltipProvider delayDuration={0}>
          <HostSwitcher
            refusalByHostId={NO_HOST_OPTION_REFUSALS}
            inertExceptHostId={null}
            hosts={[LAPTOP]}
            selected={LAPTOP}
            activeHostId={LAPTOP.hostId}
            onSelect={onSelect}
            action={null}
            surface="inline"
            intent="pin"
            consequence={null}
            disabled={false}
            isLoading={false}
            listsFailed={false}
            onRetryLists={() => undefined}
            updateViewForHost={null}
            environmentLabelForHost={null}
            composer={composerMode({
              stagedConfigurationKey: "personal",
              stagedLabel,
            })}
          />
        </TooltipProvider>,
      );

      const trigger = screen.getByRole("button", {
        name: `Host: ${stagedLabel}`,
      });
      const gear = screen.getByTestId("host-switcher-staged-gear");
      const triggerWrapper = trigger.parentElement;
      const row = triggerWrapper?.parentElement ?? null;
      expect(row).not.toBeNull();
      expect(row).toBe(gear.parentElement);
      expect(triggerWrapper?.nextElementSibling).toBe(gear);
      expect(trigger.getAttribute("aria-label")).toBe(`Host: ${stagedLabel}`);
      expect(gear.getAttribute("aria-label")).toBe(
        "Change the staged sandbox's shape",
      );

      fireEvent.focus(trigger);
      expect((await screen.findByRole("tooltip")).textContent).toBe(
        stagedLabel,
      );

      fireEvent.click(gear);
      expect(onOpenShape).toHaveBeenCalledWith("personal");
      expect(onPickNew).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("marks the staged row picked", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({ stagedConfigurationKey: "personal" }),
      intent: "pin",
    });

    expect(
      screen
        .getByTestId("host-switcher-new-sandbox-personal")
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("host-switcher-new-sandbox-team-acme")
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("ends with Manage sandboxes in Settings", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({}),
      intent: "pin",
    });

    const manage = screen.getByTestId("host-switcher-manage-sandboxes");
    expect(manage.textContent).toBe("Manage sandboxes in Settings");
    fireEvent.click(manage);

    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("<HostSwitcher /> composer mode search", () => {
  const SIX_HOSTS = Array.from({ length: 6 }, (_, index) =>
    hostScopeOptionFixture({
      hostId: `computer-${index}`,
      name: `Computer ${index}`,
      isActive: index === 0,
    }),
  );

  it("says no host of the person's matches, and where the others are", () => {
    renderSwitcher({
      hosts: SIX_HOSTS,
      composer: composerMode({ newRows: [] }),
      intent: "pin",
    });

    fireEvent.change(screen.getByPlaceholderText("Search hosts"), {
      target: { value: "zzz" },
    });

    const empty = screen.getByTestId("host-switcher-composer-no-match");
    expect(empty.textContent).toContain('No host of yours matches "zzz".');
    expect(empty.textContent).toContain(
      "Other members' and agent sandboxes are in Settings.",
    );
  });

  it("opens Sandboxes you started on a search term, so a match is not hidden", () => {
    renderSwitcher({
      hosts: [...SIX_HOSTS, SUSPENDED],
      composer: composerMode({}),
      intent: "pin",
    });
    expect(
      screen.queryByTestId("settings-host-switcher-option-sbx-suspended"),
    ).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search hosts"), {
      target: { value: "suspended" },
    });

    expect(row("sbx-suspended")).toBeDefined();
  });
});

describe("<HostSwitcher /> composer mode search narrows", () => {
  const PRO = hostScopeOptionFixture({
    hostId: "pro",
    name: "Pro",
    isLocalMachine: false,
    isActive: false,
  });
  const LOCAL_COMPUTER = hostScopeOptionFixture({
    hostId: "mine",
    name: "windows-test-machine",
    isLocalMachine: true,
    isActive: true,
  });
  const P1 = sandboxHost("e2e-sbx-p1", "awake", {});
  const P2 = sandboxHost("e2e-sbx-p2", "awake", {});

  function hostRows(): string[] {
    return screen
      .queryAllByTestId(/^settings-host-switcher-option-/)
      .map((element) =>
        (element.getAttribute("data-testid") ?? "").replace(
          "settings-host-switcher-option-",
          "",
        ),
      );
  }

  function search(term: string): void {
    renderSwitcher({
      hosts: [PRO, LOCAL_COMPUTER, P1, P2],
      composer: composerMode({}),
      intent: "pin",
    });
    fireEvent.change(screen.getByPlaceholderText("Search hosts"), {
      target: { value: term },
    });
  }

  it("keeps only the host whose name contains the term, and the New group and footer", () => {
    search("p2");

    expect(hostRows()).toEqual(["e2e-sbx-p2"]);
    expect(screen.getByText("New Personal sandbox")).toBeDefined();
    expect(screen.getByText("New Acme sandbox")).toBeDefined();
    expect(
      screen.getByTestId("host-switcher-manage-sandboxes").textContent,
    ).toBe("Manage sandboxes in Settings");
    expect(screen.queryByTestId("host-switcher-composer-no-match")).toBeNull();
  });

  it("matches the local row by its real name", () => {
    search("windows-test");

    expect(hostRows()).toEqual(["mine"]);
  });

  it("lists no host for a term nothing contains, keeps the New group and footer, and says so", () => {
    search("qq");

    expect(hostRows()).toEqual([]);
    expect(screen.getByText("New Personal sandbox")).toBeDefined();
    expect(screen.getByTestId("host-switcher-manage-sandboxes")).toBeDefined();
    expect(
      screen.getByTestId("host-switcher-composer-no-match").textContent,
    ).toBe(
      'No host of yours matches "qq".Other members\' and agent sandboxes are in Settings.',
    );
  });
});

describe("<HostSwitcher /> composer mode search field", () => {
  it("is there for a single host, holds focus, and filters the rows", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({}),
      intent: "pin",
    });

    const search = screen.getByPlaceholderText("Search hosts");
    expect(document.activeElement).toBe(search);

    fireEvent.change(search, { target: { value: "lap" } });
    expect(row("laptop")).toBeDefined();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(
      screen.queryByTestId("settings-host-switcher-option-laptop"),
    ).toBeNull();
  });

  it("says no host matches, where the others are, and keeps Manage sandboxes", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({}),
      intent: "pin",
    });

    fireEvent.change(screen.getByPlaceholderText("Search hosts"), {
      target: { value: "ci-triage" },
    });

    const empty = screen.getByTestId("host-switcher-composer-no-match");
    expect(empty.textContent).toContain(
      'No host of yours matches "ci-triage".',
    );
    expect(empty.textContent).toContain(
      "Other members' and agent sandboxes are in Settings.",
    );
    expect(
      screen.getByTestId("host-switcher-manage-sandboxes").textContent,
    ).toBe("Manage sandboxes in Settings");
  });

  it("keeps the keys typed in it from an ancestor's key handler", () => {
    const onAncestorKeyDown =
      vi.fn<(event: KeyboardEvent<HTMLElement>) => void>();
    renderPicker({
      hosts: [LAPTOP],
      selected: LAPTOP,
      composer: composerMode({}),
      intent: "pin",
      onAncestorKeyDown,
    });

    // The handler is wired: a key on the trigger, which is not portalled, arrives.
    fireEvent.keyDown(screen.getByTestId("settings-host-switcher"), {
      key: "a",
    });
    expect(onAncestorKeyDown).toHaveBeenCalledTimes(1);
    onAncestorKeyDown.mockClear();

    const search = screen.getByPlaceholderText("Search hosts");
    fireEvent.keyDown(search, { key: "c" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onAncestorKeyDown).not.toHaveBeenCalled();
  });

  it("is there for the in-task picker too, focused", () => {
    renderSwitcher({
      hosts: [LAPTOP, AWAKE],
      composer: composerMode({ inThisTask: [AWAKE] }),
      intent: "pin",
    });

    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("Search hosts"),
    );
  });
});

describe("<HostSwitcher /> composer mode computers", () => {
  const WINDOWS_LOCAL = hostScopeOptionFixture({
    hostId: "local-win",
    name: "windows-test-machine",
    platform: "win32-x64",
    isLocalMachine: true,
    isActive: true,
  });

  function remoteComputer(
    overrides: Partial<HostScopeOption> & { readonly hostId: string },
  ): HostScopeOption {
    return hostScopeOptionFixture({
      isLocalMachine: false,
      isActive: false,
      entry: {
        hostId: overrides.hostId,
        label: overrides.hostId,
        kind: "remote",
        websocketUrl: "wss://relay.traycer.invalid/attach",
        version: "1.0.0",
        transportDialability: "dialable",
      },
      ...overrides,
    });
  }

  it("uses the local machine's name on the chip and row, with platform and status under the name", () => {
    renderPicker({
      hosts: [WINDOWS_LOCAL],
      selected: WINDOWS_LOCAL,
      composer: composerMode({}),
      intent: "pin",
      onAncestorKeyDown: null,
    });

    const chip = screen.getByTestId("settings-host-switcher");
    expect(chip.textContent).toBe("windows-test-machine");
    const local = row("local-win");
    expect(within(local).getByText("windows-test-machine")).toBeDefined();
    expect(within(local).getByText("Windows · Active")).toBeDefined();
    expect(local.querySelector("details")).toBeNull();
    expect(onPickHost).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(wakeSandboxOnPick).not.toHaveBeenCalled();
  });

  it("still names the machine in a list that is not the composer's", () => {
    renderPicker({
      hosts: [WINDOWS_LOCAL],
      selected: WINDOWS_LOCAL,
      composer: null,
      intent: "pin",
      onAncestorKeyDown: null,
    });

    expect(screen.getByTestId("settings-host-switcher").textContent).toContain(
      "windows-test-machine",
    );
    // The local row shows the same real name as the chip.
    expect(within(row("local-win")).queryByText("This computer")).toBeNull();
    expect(
      within(row("local-win")).getByText("windows-test-machine"),
    ).toBeDefined();
  });

  it("keeps another computer's OS and Active under its name, drawn as a monitor", () => {
    const linux = remoteComputer({
      hostId: "remote-linux",
      name: "build-box",
      platform: "linux-x64",
    });
    renderSwitcher({
      hosts: [LAPTOP, linux],
      composer: composerMode({}),
      intent: "pin",
    });

    const box = row("remote-linux");
    expect(within(box).getByText("build-box")).toBeDefined();
    expect(within(box).getByText("Linux · Active")).toBeDefined();
    expect(box.querySelector("details")).toBeNull();
    expect(box.querySelector("svg.lucide-monitor")).not.toBeNull();
    expect(box.querySelector("svg.lucide-cloud")).toBeNull();
  });

  it("says since when an offline computer was last seen, and that picking it waits", () => {
    const lastSeenAt = new Date(2026, 9, 20, 9, 12).toISOString();
    const sleeper = remoteComputer({
      hostId: "remote-mac",
      name: "studio-mac",
      platform: "darwin-arm64",
      connectable: true,
      health: {
        state: "offline",
        label: "Offline",
        detail: null,
        tone: "idle",
        live: false,
      },
      item: {
        hostId: "remote-mac",
        displayName: "studio-mac",
        platform: "darwin-arm64",
        kind: "personal",
        publicKey: "pk",
        createdAt: new Date(0).toISOString(),
        updatePolicy: "manual",
        status: {
          connectivity: "offline",
          viewerReachability: "unknown",
          clientCloud: "ok",
          updateState: "current",
          appVersion: "1.4.2",
          lastSeenAt,
        },
      },
    });
    renderSwitcher({
      hosts: [LAPTOP, sleeper],
      composer: composerMode({}),
      intent: "pin",
    });

    const mac = row("remote-mac");
    expect(mac.textContent).toMatch(/offline/i);
    expect(
      within(mac).getByText(
        "macOS · Offline since Tue 09:12 · picking it waits for it",
      ),
    ).toBeDefined();
    expect(mac.querySelector("details")).toBeNull();
  });

  it("shows an unavailable sandbox's resources, rate and refusal under the name without picking or waking", () => {
    const frozen = sandboxHost("sbx-frozen", "awake", { frozen: true });
    const resources =
      "Linux · 2 vCPU · 4 GB · $0.21 an hour while awake · paid by Acme";
    const compatibility = "Acme pays · Linux compatibility facts";
    const refusal =
      "Agents here cannot work with the agents on your hosts; the task still shares its files and chats.";
    renderSwitcher({
      hosts: [LAPTOP, frozen],
      composer: composerMode({
        inThisTask: [frozen],
        subLinesFor: (hostId) =>
          hostId === frozen.hostId ? [resources, compatibility, refusal] : [],
        tagFor: (hostId) => (hostId === frozen.hostId ? "Acme Robotics" : null),
      }),
      intent: "pin",
    });

    const option = row("sbx-frozen");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(within(option).getByText(resources)).toBeDefined();
    expect(within(option).getByText(compatibility)).toBeDefined();
    expect(within(option).getByText(refusal)).toBeDefined();
    expect(option.querySelector("details")).toBeNull();
    expect(
      within(option).getByTestId("host-option-environment-sbx-frozen")
        .textContent,
    ).toBe("Acme Robotics");

    fireEvent.click(within(option).getByText(resources));

    expect(onPickHost).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(wakeSandboxOnPick).not.toHaveBeenCalled();
  });
});

describe("<HostSwitcher /> composer facts follow search results", () => {
  it("hides a computer's supplemental facts when search removes its option", () => {
    const computer = hostScopeOptionFixture({
      hostId: "detail-computer",
      name: "Detail computer",
      platform: "win32-x64",
      isLocalMachine: true,
      isActive: true,
    });
    const otherHosts = Array.from({ length: 5 }, (_, index) =>
      hostScopeOptionFixture({
        hostId: `other-${index}`,
        name: `Other ${index}`,
      }),
    );
    renderSwitcher({
      hosts: [computer, ...otherHosts],
      composer: composerMode({}),
      intent: "pin",
    });

    expect(
      within(row("detail-computer")).getByText("Windows · Active"),
    ).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("Search hosts"), {
      target: { value: "no matching host" },
    });

    expect(
      screen.queryByTestId("settings-host-switcher-option-detail-computer"),
    ).toBeNull();
    expect(screen.queryByText("Windows · Active")).toBeNull();
  });
});

describe("<HostSwitcher /> composer mode host names truncate", () => {
  const LOCAL = hostScopeOptionFixture({
    hostId: "local-win",
    name: "windows-test-machine",
    platform: "win32-x64",
    isLocalMachine: true,
    isActive: true,
  });
  const ROW_TITLE = "A sandbox with a long name that must be read in full";
  const LONG_NAMED = sandboxHost("sbx-long", "awake", {});
  const NAMED = { ...LONG_NAMED, name: ROW_TITLE };

  // jsdom paints no layout, so assert the merged utility classes that express
  // the compact row behavior instead of trying to measure rendered geometry.
  function expectTruncates(name: HTMLElement): void {
    expect(name.classList.contains("truncate")).toBe(true);
    expect(name.classList.contains("whitespace-normal")).toBe(false);
    expect(name.classList.contains("wrap-anywhere")).toBe(false);
  }

  it("wraps the New row's label in full", () => {
    const label = "New Personal sandbox · needs credits";
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({
        newRows: [
          {
            configurationKey: "personal",
            label,
            subLine: "Linux · 2 vCPU · 4 GB · from $0.21 an hour",
            configuration: { kind: "personal" },
            disabled: false,
          },
        ],
      }),
      intent: "pin",
    });

    const title = within(
      screen.getByTestId("host-switcher-new-sandbox-personal"),
    ).getByText(label);
    expect(title.classList.contains("truncate")).toBe(false);
    expect(title.classList.contains("wrap-break-word")).toBe(true);
  });

  it("truncates the computer row's name without losing its text", () => {
    renderSwitcher({
      hosts: [LOCAL],
      composer: composerMode({}),
      intent: "pin",
    });

    const name = within(row("local-win")).getByText("windows-test-machine");
    expectTruncates(name);
    expect(name.textContent).toBe("windows-test-machine");
  });

  it("truncates a sandbox row's name", () => {
    renderSwitcher({
      hosts: [LAPTOP, NAMED],
      composer: composerMode({ inThisTask: [NAMED] }),
      intent: "pin",
    });

    expectTruncates(within(row("sbx-long")).getByText(ROW_TITLE));
  });

  it("truncates a sandbox name in a list that is not the composer's", () => {
    renderSwitcher({ hosts: [LAPTOP, NAMED], composer: null, intent: "pin" });

    const title = within(row("sbx-long")).getByText(ROW_TITLE);
    expectTruncates(title);
  });
});

describe("<HostSwitcher /> composer mode and the Automations host", () => {
  function automationHost(hostId: string, teamOwned: boolean): HostScopeOption {
    return sandboxHost(hostId, "awake", {
      teamOwned,
      summary: sandboxSummaryFixture({
        id: `sbx-${hostId}`,
        hostId,
        kind: "automation",
        createdBy: { userId: VIEWER, displayName: "Me" },
      }),
    });
  }

  it("offers no Automations row, personal or a team's", () => {
    renderSwitcher({
      hosts: [
        LAPTOP,
        AWAKE,
        automationHost("pod-personal", false),
        automationHost("pod-team", true),
      ],
      composer: composerMode({}),
      intent: "pin",
    });
    fireEvent.click(
      screen.getByTestId("host-switcher-sandboxes-you-started-toggle"),
    );

    expect(row("sbx-awake")).toBeDefined();
    expect(
      screen.queryByTestId("settings-host-switcher-option-pod-personal"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-option-pod-team"),
    ).toBeNull();
  });
});
