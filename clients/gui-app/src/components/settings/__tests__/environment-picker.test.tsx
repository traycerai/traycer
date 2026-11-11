import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentPicker } from "@/components/settings/environment-picker";
import type {
  HostsRunningConfiguration,
  RunningHost,
} from "@/components/settings/environment/hosts-running-configuration-model";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

// The two per-host reads the picker draws from are queries and a manifest
// registry; they are the boundary, so the suite answers them directly.
const reads = vi.hoisted(
  (): {
    readonly statuses: Map<string, unknown>;
    readonly versions: Map<string, unknown>;
    running: HostsRunningConfiguration | null;
    invitations: Array<{
      environmentId: string;
      teamName: string;
      role: "admin" | "editor" | "viewer";
      paidPlan: boolean;
    }>;
    acceptOutcome: "accepted" | "not_found";
    accepted: string[];
    /** The account's configurations, as `environment.list` answers them. */
    environments: Array<{
      environmentId: string;
      ownerKind: "user" | "organization";
      label: string;
    }>;
    /** How many times anything asked for the invitations read. */
    invitationReads: number;
  } => ({
    statuses: new Map<string, unknown>(),
    versions: new Map<string, unknown>(),
    running: null,
    invitations: [],
    acceptOutcome: "accepted",
    accepted: [],
    environments: [],
    invitationReads: 0,
  }),
);
// The hosts running Personal come from one hook (its list is tested on its
// own); the picker draws whatever it answers.
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => reads.running,
  }),
);
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => reads.statuses,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => reads.versions,
}));
// The invited rows and the Accept behind Review are the host's; this suite
// answers them directly.
vi.mock("@/hooks/environment/use-environment-invitations", () => ({
  useEnvironmentInvitationsQuery: () => {
    reads.invitationReads += 1;
    return { data: { invitations: reads.invitations } };
  },
  useEnvironmentInvitationsEntryHash: () => "invitations-entry",
  useEnvironmentInvitationAcceptMutation: () => ({
    isPending: false,
    mutate: (
      variables: { environmentId: string },
      options: {
        onSuccess: (response: { outcome: "accepted" | "not_found" }) => void;
      },
    ) => {
      reads.accepted.push(variables.environmentId);
      options.onSuccess({ outcome: reads.acceptOutcome });
    },
  }),
}));
// The team rows read the account's configuration list; this suite has none.
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: reads.environments },
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
/**
 * The press arm of the surface move, asserted as the command it issues rather
 * than as a call to the helper that issues it: the removal gate deliberately
 * takes a non-activating path, so which path a PRESS takes is a claim worth
 * holding here. `navigateToSettingsSection` is real and reaches this bridge.
 */
const surface = vi.hoisted(() => ({
  openSettings: vi.fn(),
  setSection: vi.fn(),
}));
vi.mock("@/stores/tabs/system-tab-modal-bridge", () => ({
  getSystemTabModalApi: () => ({
    isOverlayActive: () => false,
    openSettings: surface.openSettings,
    setSection: surface.setSection,
    active: null,
    close: () => undefined,
  }),
}));

const V11 = { major: 1, minor: 1 } as const;
const V10 = { major: 1, minor: 0 } as const;

function answer(
  hostId: string,
  status: EnvironmentStatusResponseV11 | null,
  version: NegotiatedMethodVersion,
): void {
  reads.statuses.set(hostId, status);
  reads.versions.set(hostId, version);
}

const awaiting = environmentStatusFixture({
  principal: null,
  planes: { records: "local", broker: "local", room: "local" },
  setup: { stage: "moving_settings", state: "awaiting_consent" },
});
const partlyMoved = environmentStatusFixture({
  principal: null,
  planes: { records: "moved", broker: "local", room: "local" },
  pendingUploads: [
    {
      uploadId: "u1",
      kind: "secret",
      key: "k",
      os: "macos",
      queuedAt: 1,
      receipt: "accepted",
      code: null,
    },
  ],
  setup: { stage: "moving_settings", state: "running" },
  // No consent while a move runs: the status serves the migration
  // MARKER's consent and the host writes that marker only once the upload
  // has finished (`traycer-host/.../migration/migrator.ts`, step 5). A
  // fixture that sets it here invites a reader to key on it.
});
const applyingStalled = environmentStatusFixture({
  principal: null,
  planes: { records: "moved", broker: "moved", room: "moved" },
  setup: { stage: "applying", state: "stalled" },
});
const running = environmentStatusFixture({ principal: { kind: "personal" } });

function pickerElementForSection(
  windowHostId: string,
  activeSection: "mcp-servers" | "skills" | "sandboxes" | "storage" | "members",
) {
  const hosts = [
    hostScopeOptionFixture({ hostId: "mac", name: "MacBook Pro" }),
    hostScopeOptionFixture({ hostId: "dev", name: "dev-box" }),
    hostScopeOptionFixture({ hostId: "old", name: "Old laptop" }),
    hostScopeOptionFixture({ hostId: "tiny", name: "Tiny" }),
  ];
  return (
    <EnvironmentPicker
      scope={hostScopeFixture({
        hosts,
        host: hosts[0],
        activeHostId: windowHostId,
      })}
      activeSection={activeSection}
    />
  );
}

function pickerElement(windowHostId: string) {
  return pickerElementForSection(windowHostId, "mcp-servers");
}

function renderPicker(windowHostId: string) {
  return render(pickerElement(windowHostId));
}

function renderPickerForSection(
  windowHostId: string,
  activeSection: "mcp-servers" | "skills" | "sandboxes" | "storage" | "members",
) {
  return render(pickerElementForSection(windowHostId, activeSection));
}

function runningHost(name: string, isThisComputer: boolean): RunningHost {
  return {
    hostId: name,
    hostName: name,
    name,
    kind: "personal",
    isThisComputer,
    lastReportedAt: 1,
    applied: [],
  };
}

function runningOn(
  names: readonly string[],
  overrides: Partial<HostsRunningConfiguration>,
): void {
  reads.running = {
    hosts: names.map((name) => runningHost(name, false)),
    state: "ready",
    thisComputerUnread: false,
    collisions: [],
    retry: () => undefined,
    reread: () => undefined,
    ...overrides,
  };
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByTestId("environment-picker-trigger"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

beforeEach(() => {
  reads.statuses.clear();
  reads.versions.clear();
  reads.invitations = [];
  reads.acceptOutcome = "accepted";
  reads.accepted = [];
  reads.environments = [];
  reads.invitationReads = 0;
  runningOn([], {});
  surface.openSettings.mockClear();
  surface.setSection.mockClear();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  useMoveSheetStore.setState({ target: null });
  useSettingsHostScopeStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("<EnvironmentPicker />", () => {
  it("draws an awaiting_consent host under its own-settings group and opens the move sheet", () => {
    answer("mac", running, V11);
    answer("dev", running, V11);
    answer("old", awaiting, V11);
    runningOn(["MacBook Pro", "dev-box"], {});
    renderPicker("mac");
    openMenu();

    const row = screen.getByTestId("environment-picker-local-old");
    expect(row.textContent).toContain("Old laptop");
    expect(row.textContent).toContain("its own settings, not in Personal yet");
    expect(screen.getByTestId("environment-picker-personal").textContent).toBe(
      "Personalyour settings · on MacBook Pro, dev-box",
    );

    fireEvent.click(screen.getByTestId("environment-picker-move-old"));
    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: "old",
      hostName: "Old laptop",
    });
  });

  it("draws the Move to Personal verb after the row's subtitle, still its own menu item", () => {
    answer("mac", running, V11);
    answer("old", awaiting, V11);
    renderPicker("mac");
    openMenu();

    const verb = screen.getByRole("menuitem", { name: "Move to Personal" });
    expect(verb).toBe(screen.getByTestId("environment-picker-move-old"));
    expect(verb.textContent).toBe("· Move to Personal");
    expect(verb.querySelector("[aria-hidden]")?.textContent).toContain("·");
  });

  it("groups its own-settings computer as an unindented row without a badge", () => {
    answer("mac", running, V11);
    answer("old", awaiting, V11);
    renderPicker("mac");
    openMenu();

    const row = screen.getByTestId("environment-picker-local-old");
    expect(screen.getByText("Runs its own settings")).toBeTruthy();
    expect(row.getAttribute("data-inset")).not.toBe("true");
    expect(row.textContent).not.toContain("Local");
  });

  it("labels the trigger with the own-settings badge when the pick is local", async () => {
    answer("old", awaiting, V11);
    renderPicker("old");

    await userEvent.hover(
      within(screen.getByTestId("environment-picker-trigger")).getByText(
        "Runs its own settings",
      ),
    );

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Settings on this computer only",
    );
  });

  it("shows the full name in a tooltip on the closed trigger", async () => {
    const user = userEvent.setup();
    answer("mac", running, V11);
    renderPicker("mac");
    await user.hover(
      within(screen.getByTestId("environment-picker-trigger")).getByText(
        "Personal",
      ),
    );
    expect((await screen.findByRole("tooltip")).textContent).toBe("Personal");
    cleanup();

    answer("old", awaiting, V11);
    renderPicker("old");
    await user.hover(
      within(screen.getByTestId("environment-picker-trigger")).getByText(
        "Old laptop",
      ),
    );
    expect((await screen.findByRole("tooltip")).textContent).toBe("Old laptop");
    cleanup();

    reads.environments = [
      { environmentId: "env-a", ownerKind: "organization", label: "Acme" },
    ];
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    answer("mac", running, V11);
    renderPicker("mac");
    await user.hover(
      within(screen.getByTestId("environment-picker-trigger")).getByText(
        "Acme",
      ),
    );
    expect((await screen.findByRole("tooltip")).textContent).toBe("Acme");
  });

  it("draws a host whose consent is recorded as partly moved, and finish moving opens its Overview", () => {
    answer("old", partlyMoved, V11);
    renderPicker("mac");
    openMenu();

    expect(
      screen.getByTestId("environment-picker-local-old").textContent,
    ).toContain("partly in Personal");
    expect(screen.queryByTestId("environment-picker-move-old")).toBeNull();

    fireEvent.click(screen.getByTestId("environment-picker-finish-old"));
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe("old");
    expect(surface.openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ section: "host" }),
    );
  });

  it("greys a host that cannot show its settings, and gives an applied 1.0 host no row", () => {
    answer(
      "old",
      environmentStatusFixture({ principal: null, setup: null }),
      V10,
    );
    answer(
      "tiny",
      environmentStatusFixture({
        setup: { stage: "applying", state: "running" },
      }),
      V10,
    );
    renderPicker("mac");
    openMenu();

    const grey = screen.getByTestId("environment-picker-local-old");
    expect(
      within(grey).getByText("Update to view these settings."),
    ).toBeTruthy();
    expect(grey.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("environment-picker-local-tiny")).toBeNull();
  });

  it("makes the Local row the default pick for this window's own host only", () => {
    answer("old", awaiting, V11);
    renderPicker("old");
    expect(useSettingsEnvironmentPickStore.getState().defaultPick).toEqual({
      kind: "local",
      hostId: "old",
      hostName: "Old laptop",
    });
    expect(screen.getByTestId("environment-picker-trigger").textContent).toBe(
      "Old laptopRuns its own settings",
    );
    cleanup();

    useSettingsEnvironmentPickStore.setState({ defaultPick: PERSONAL_PICK });
    renderPicker("mac");
    expect(useSettingsEnvironmentPickStore.getState().defaultPick).toEqual(
      PERSONAL_PICK,
    );
    expect(screen.getByTestId("environment-picker-trigger").textContent).toBe(
      "Personal",
    );
  });

  it("drops a Local pick only once that host has answered and moved", () => {
    const pick = {
      kind: "local",
      hostId: "old",
      hostName: "Old laptop",
    } as const;
    useSettingsEnvironmentPickStore.setState({ pick });
    answer("old", null, V11);
    renderPicker("mac");
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(pick);
    cleanup();

    answer("old", running, V11);
    renderPicker("mac");
    expect(useSettingsEnvironmentPickStore.getState().pick).toBeNull();
  });

  it("keeps an unresolved setup computer selected until it reports Personal", async () => {
    answer("mac", applyingStalled, V11);
    const view = renderPicker("mac");

    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().defaultPick).toEqual({
        kind: "local",
        hostId: "mac",
        hostName: "MacBook Pro",
      });
    });
    const trigger = screen.getByTestId("environment-picker-trigger");
    expect(within(trigger).getByText("MacBook Pro")).toBeTruthy();
    expect(within(trigger).getByText("Setup")).toBeTruthy();
    expect(within(trigger).queryByText("Runs its own settings")).toBeNull();

    openMenu();
    const row = screen.getByTestId("environment-picker-local-mac");
    expect(screen.getByText("Computers")).toBeTruthy();
    expect(
      within(row).getByText("Setup stopped while applying your settings."),
    ).toBeTruthy();
    expect(row.textContent).not.toContain("Runs its own settings");
    fireEvent.click(row);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "local",
      hostId: "mac",
      hostName: "MacBook Pro",
    });

    answer("mac", running, V11);
    view.rerender(pickerElement("mac"));
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toBeNull();
      expect(useSettingsEnvironmentPickStore.getState().defaultPick).toEqual(
        PERSONAL_PICK,
      );
    });
    openMenu();
    expect(screen.queryByTestId("environment-picker-local-mac")).toBeNull();
  });

  it("gives this window's own computer its Local row while the account's host list leaves it out, and no other unlisted computer", () => {
    // A new computer registers with remote access off, and the account's host
    // list omits it until remote access is on.
    const hosts = [
      hostScopeOptionFixture({
        hostId: "mac",
        name: "MacBook Pro",
        isLocalMachine: true,
        registered: false,
        item: null,
      }),
      hostScopeOptionFixture({
        hostId: "dev",
        name: "dev-box",
        isLocalMachine: false,
        registered: false,
        item: null,
      }),
    ];
    answer("mac", awaiting, V11);
    answer("dev", awaiting, V11);
    render(
      <EnvironmentPicker
        scope={hostScopeFixture({ hosts, host: hosts[0], activeHostId: "mac" })}
        activeSection="mcp-servers"
      />,
    );
    openMenu();

    expect(
      screen.getByTestId("environment-picker-local-mac").textContent,
    ).toContain("its own settings, not in Personal yet");
    expect(screen.queryByTestId("environment-picker-local-dev")).toBeNull();
    fireEvent.click(screen.getByTestId("environment-picker-move-mac"));
    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: "mac",
      hostName: "MacBook Pro",
    });
  });

  it("names the hosts the hook reports under Personal, and claims none while the list is unread", () => {
    const cases: readonly [
      readonly string[],
      Partial<HostsRunningConfiguration>,
      string,
    ][] = [
      [
        ["MacBook Pro", "dev-box", "ci-box"],
        {},
        "Personalyour settings · on MacBook Pro, dev-box and 1 more",
      ],
      [[], {}, "Personalyour settings · not on any computer or sandbox"],
      [["MacBook Pro"], { state: "loading" }, "Personalyour settings"],
      [[], { state: "failed" }, "Personalyour settings"],
    ];
    for (const [names, overrides, text] of cases) {
      runningOn(names, overrides);
      renderPicker("mac");
      openMenu();
      expect(
        screen.getByTestId("environment-picker-personal").textContent,
      ).toBe(text);
      cleanup();
    }
  });

  it("offers Rename for two computers sharing a name, on this computer's Overview when it is one of them", () => {
    reads.running = {
      hosts: [runningHost("other", false), runningHost("mac", true)],
      state: "ready",
      thisComputerUnread: false,
      collisions: [
        { hostName: "windows-test-machine", hostIds: ["other", "mac"] },
      ],
      retry: () => undefined,
      reread: () => undefined,
    };
    renderPicker("mac");
    openMenu();

    const line = screen.getByTestId("environment-picker-name-collision");
    expect(line.textContent).toBe(
      "Two computers are named windows-test-machine · Rename",
    );
    fireEvent.click(line);
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe("mac");
    expect(surface.openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ section: "host" }),
    );
    cleanup();

    useSettingsHostScopeStore.getState().reset();
    reads.running = {
      hosts: [runningHost("other", false), runningHost("third", false)],
      state: "ready",
      thisComputerUnread: false,
      collisions: [
        { hostName: "windows-test-machine", hostIds: ["other", "third"] },
      ],
      retry: () => undefined,
      reread: () => undefined,
    };
    renderPicker("mac");
    openMenu();
    fireEvent.click(screen.getByTestId("environment-picker-name-collision"));
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe("other");
  });

  it.each(["mcp-servers", "skills", "sandboxes", "storage"] as const)(
    "keeps the selected %s page when a Local row is picked",
    (section) => {
      answer("old", awaiting, V11);
      renderPickerForSection("mac", section);
      openMenu();

      act(() => {
        fireEvent.click(screen.getByTestId("environment-picker-local-old"));
      });
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "local",
        hostId: "old",
        hostName: "Old laptop",
      });
      expect(surface.openSettings).not.toHaveBeenCalled();
      expect(surface.setSection).not.toHaveBeenCalled();
    },
  );

  it("moves from Members to Providers when a Local row is picked", () => {
    answer("old", awaiting, V11);
    renderPickerForSection("mac", "members");
    openMenu();

    act(() => {
      fireEvent.click(screen.getByTestId("environment-picker-local-old"));
    });

    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "local",
      hostId: "old",
      hostName: "Old laptop",
    });
    expect(surface.openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ section: "providers" }),
    );
  });

  // The invitations read is account-wide. The only thing that needs it before
  // the dropdown opens is the trigger with a pick no membership can name, so
  // a trigger naming a team the person is in must not ask for it: otherwise
  // every Settings visit carries that request, for everyone, invited or not.
  it("asks for no invitations while the membership list names the pick", () => {
    reads.environments = [
      { environmentId: "env-a", ownerKind: "organization", label: "Acme" },
    ];
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    answer("mac", running, V11);
    renderPicker("mac");

    expect(
      screen.getByTestId("environment-picker-trigger").textContent,
    ).toContain("Acme");
    expect(reads.invitationReads).toBe(0);
  });

  // And where no membership can name it — the pick the person was removed
  // from and invited back to — the invitation still names it, which is the
  // whole reason that read is reachable from here.
  it("names a team only an invitation can name", () => {
    reads.invitations = [
      {
        environmentId: "env-beta",
        teamName: "Beta",
        role: "editor",
        paidPlan: true,
      },
    ];
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-beta" },
    });
    answer("mac", running, V11);
    renderPicker("mac");

    expect(
      screen.getByTestId("environment-picker-trigger").textContent,
    ).toContain("Beta");
  });

  describe("an invited team", () => {
    function inviteTo(environmentId: string, teamName: string): void {
      reads.invitations = [
        { environmentId, teamName, role: "editor", paidPlan: true },
      ];
      answer("mac", running, V11);
      renderPicker("mac");
      openMenu();
    }

    it("shows the invitation subtitle and Review as a separate action", () => {
      inviteTo("env-beta", "Beta");

      const row = screen.getByTestId("environment-invitation-env-beta");
      expect(row.textContent).toContain("Beta");
      expect(row.textContent).toContain(
        "Invited you · not yours to edit until you accept",
      );
      expect(row.getAttribute("aria-disabled")).toBeNull();
      expect(
        screen.getByTestId("environment-invitation-review-env-beta"),
      ).toBeTruthy();
    });

    it("opens the grant from Review, and picks the team once Accept joins it", async () => {
      inviteTo("env-beta", "Beta");

      fireEvent.click(
        screen.getByTestId("environment-invitation-review-env-beta"),
      );
      expect(
        await screen.findByRole("heading", { name: "You're invited to Beta" }),
      ).toBeTruthy();
      expect(reads.accepted).toEqual([]);

      fireEvent.click(screen.getByTestId("invite-accept"));

      expect(reads.accepted).toEqual(["env-beta"]);
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "team",
        environmentId: "env-beta",
      });
      expect(screen.queryByTestId("invite-accept-dialog")).toBeNull();
    });

    it("says the invitation is gone, and keeps the pick, when it was withdrawn", async () => {
      reads.acceptOutcome = "not_found";
      inviteTo("env-beta", "Beta");

      fireEvent.click(
        screen.getByTestId("environment-invitation-review-env-beta"),
      );
      fireEvent.click(await screen.findByTestId("invite-accept"));

      expect(
        (await screen.findByTestId("invite-accept-gone")).textContent,
      ).toBe("This invitation is no longer open.");
      expect(useSettingsEnvironmentPickStore.getState().pick).toBeNull();
    });
  });
});
