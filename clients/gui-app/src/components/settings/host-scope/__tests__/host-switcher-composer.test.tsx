import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import type { HostSwitcherComposerMode } from "@/components/settings/host-scope/host-switcher";
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

/** Calls in the order they happened, across the composer and the surface. */
const calls: string[] = [];
const onSelect = vi.fn<(hostId: string) => void>((hostId) => {
  calls.push(`select:${hostId}`);
});
const onPickHost = vi.fn<(host: HostScopeOption) => void>((host) => {
  calls.push(`pick:${host.hostId}`);
});
const onPickNew = vi.fn<(configurationKey: string) => void>();
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
    newRows: [
      {
        configurationKey: "personal",
        label: "New Personal sandbox",
        subLine: "2 vCPU · 4 GB · $0.12/h · uses your credits",
        configurationName: "Personal",
      },
      {
        configurationKey: "team-acme",
        label: "New Acme sandbox",
        subLine: "2 vCPU · 4 GB · $0.12/h · uses your Acme credits",
        configurationName: "Acme",
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

function renderSwitcher(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly composer: HostSwitcherComposerMode | null;
  readonly intent: HostPickIntent;
}): void {
  render(
    <HostSwitcher
      refusalByHostId={NO_HOST_OPTION_REFUSALS}
      inertExceptHostId={null}
      hosts={input.hosts}
      selected={LAPTOP}
      activeHostId={LAPTOP.hostId}
      onSelect={onSelect}
      action={null}
      surface="field"
      intent={input.intent}
      disabled={false}
      isLoading={false}
      listsFailed={false}
      onRetryLists={() => undefined}
      updateViewForHost={null}
      environmentLabelForHost={null}
      composer={input.composer}
    />,
  );
  fireEvent.click(screen.getByTestId("settings-host-switcher"));
}

function row(hostId: string): HTMLElement {
  return screen.getByTestId(`settings-host-switcher-option-${hostId}`);
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

    expect(wakeSandboxOnPick).toHaveBeenCalledWith(SUSPENDED);
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

  it("shows a host's sub-lines under its row", () => {
    renderSwitcher({
      hosts: [LAPTOP],
      composer: composerMode({
        subLinesFor: (hostId) =>
          hostId === "laptop" ? ["Local · runs its own settings"] : [],
      }),
      intent: "pin",
    });

    expect(row("laptop").textContent).toContain(
      "Local · runs its own settings",
    );
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

  it("collapses the configurations past two behind `N more`, the remembered one leading", () => {
    const newRows = ["personal", "team-acme", "team-globex"].map(
      (configurationKey) => ({
        configurationKey,
        label: `New ${configurationKey} sandbox`,
        subLine: "2 vCPU · 4 GB",
        configurationName: configurationKey,
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
    const more = screen.getByTestId("host-switcher-new-sandbox-more");
    expect(more.textContent).toContain("2 more");

    fireEvent.click(
      screen.getByTestId("host-switcher-new-sandbox-more-toggle"),
    );
    expect(
      screen.getByTestId("host-switcher-new-sandbox-personal"),
    ).toBeDefined();
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

    fireEvent.change(screen.getByPlaceholderText("Search hosts…"), {
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

    fireEvent.change(screen.getByPlaceholderText("Search hosts…"), {
      target: { value: "suspended" },
    });

    expect(row("sbx-suspended")).toBeDefined();
  });
});
