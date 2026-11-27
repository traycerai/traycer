import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { EnvironmentPicker } from "@/components/settings/environment-picker";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { HostOverviewSettingsCardSlot } from "@/components/settings/panels/host-overview-settings-card";
import { NO_RECEIPT } from "@/components/settings/panels/__tests__/ownership-receipt-fixture";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const reads = vi.hoisted(() => ({
  statuses: new Map<string, EnvironmentStatusResponseV11 | null>(),
  old: {
    data: null as EnvironmentStatusResponseV11 | null,
    supported: true,
    isError: false,
  },
  binding: null as EnvironmentHostBinding | null,
}));

vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => reads.old,
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => ({
    kind: "binding" as const,
    query: { data: reads.binding, isError: false },
  }),
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  readsHostBindingsFromPool: () => false,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostMethodSchemaVersion: () => null,
}));
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready" as const,
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
    }),
  }),
);
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => reads.statuses,
}));
vi.mock("@/hooks/environment/use-environment-invitations", () => ({
  useEnvironmentInvitationsQuery: () => ({
    data: { invitations: [] },
    isError: false,
    isPending: false,
    isEnabled: false,
  }),
  useEnvironmentInvitationsEntryHash: () => "invitations-entry",
  useEnvironmentInvitationAcceptMutation: () => ({
    isPending: false,
    mutate: () => undefined,
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: [] },
    isError: false,
    isPending: false,
    isEnabled: false,
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/components/settings/details/settings-details-button", () => ({
  SettingsDetailsButton: () => null,
  SettingsDetailsDialog: () => null,
}));
vi.mock(
  "@/components/settings/details/use-host-settings-details-subject",
  () => ({
    useHostSettingsDetailsSubject: () => null,
  }),
);

const BINDING: EnvironmentHostBinding = {
  hostId: "old",
  environment: {
    environmentId: "personal",
    ownerKind: "user",
    ownerId: "user-a",
    roomId: "room-a",
    label: "Personal",
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

const TEAM_BINDING: EnvironmentHostBinding = {
  hostId: "old",
  environment: {
    environmentId: "env-team",
    ownerKind: "organization",
    ownerId: "team-a",
    roomId: "room-team",
    label: "Team A",
  },
  explicit: true,
  enrolledByUserId: null,
  canUnbind: false,
};

/** Moved into Personal: "old" has no Local row any more. */
const OLD_MOVED = environmentStatusFixture({});

const OLD_OWN_SETTINGS = environmentStatusFixture({
  principal: null,
  planes: { records: "local", broker: "local", room: "local" },
});
const SPARE_UNMOVED = environmentStatusFixture({
  principal: null,
  planes: { records: "local", broker: "local", room: "local" },
  setup: { stage: "moving_settings", state: "awaiting_consent" },
});

const OLD_LAPTOP = { kind: "local", hostId: "old", hostName: "Old laptop" };
const OTHER_DESKTOP = {
  kind: "local",
  hostId: "other",
  hostName: "Other desktop",
};
const SPARE_DESKTOP = {
  kind: "local",
  hostId: "spare",
  hostName: "Spare desktop",
};

/**
 * The sidebar picker with the Overview of the host it is given beside it
 * (null: no Overview is open). Returns the call that sets the Overview's host.
 */
function mountOverview(
  initialHostId: string | null,
): (hostId: string | null) => void {
  recordNegotiatedHostManifest("old", {
    "environment.status": { major: 1, minor: 1 },
  });
  const { client } = buildEnvironmentClient({ hostId: "old", handlers: {} });
  const old = hostScopeOptionFixture({ hostId: "old", name: "Old laptop" });
  const spare = hostScopeOptionFixture({
    hostId: "spare",
    name: "Spare desktop",
  });
  const other = hostScopeOptionFixture({
    hostId: "other",
    name: "Other desktop",
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (hostId: string | null): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <EnvironmentPicker
        scope={hostScopeFixture({
          hosts: [old, spare, other],
          host: old,
          activeHostId: "old",
        })}
      />
      <HostOverviewSettingsCardSlot
        client={client}
        hostId={hostId}
        hostName="Old laptop"
        usable
        owner={null}
        isLocalMachine={false}
        receipt={NO_RECEIPT}
        onReturn={() => undefined}
      />
    </QueryClientProvider>
  );
  const view = render(tree(initialHostId));
  return (hostId) => view.rerender(tree(hostId));
}

/** The Overview of "old" beside the sidebar picker, both reading `old`'s answer. */
function mount(): () => void {
  const setOverviewHost = mountOverview("old");
  return () => setOverviewHost("old");
}

/** "old" answers (or fails) in the card's read and in the picker's, together. */
function oldAnswers(
  status: EnvironmentStatusResponseV11 | null,
  isError: boolean,
): void {
  reads.old = { data: status, supported: true, isError };
  reads.statuses.set("old", status);
}

function pickInSidebar(hostId: string): void {
  fireEvent.pointerDown(screen.getByTestId("environment-picker-trigger"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByTestId(`environment-picker-local-${hostId}`));
}

function pickSpareInSidebar(): void {
  pickInSidebar("spare");
}

beforeEach(() => {
  reads.statuses.clear();
  reads.statuses.set("spare", SPARE_UNMOVED);
  reads.statuses.set("other", SPARE_UNMOVED);
  reads.binding = BINDING;
  oldAnswers(null, false);
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("the Overview row after a pick made in the sidebar", () => {
  it("keeps a pick made in the sidebar while the overview's computer has not answered", async () => {
    const rerender = mount();

    pickSpareInSidebar();
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      SPARE_DESKTOP,
    );

    oldAnswers(OLD_OWN_SETTINGS, false);
    rerender();

    await waitFor(() => {
      expect(
        within(screen.getByRole("combobox", { name: "Environment" })).getByText(
          "Old laptop",
        ),
      ).toBeTruthy();
    });
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      SPARE_DESKTOP,
    );
    expect(
      screen.getByTestId("environment-picker-trigger").textContent,
    ).toContain("Spare desktop");
  });

  it("keeps a pick made in the sidebar while the overview's computer was unreachable", async () => {
    oldAnswers(OLD_OWN_SETTINGS, false);
    const rerender = mount();
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        OLD_LAPTOP,
      );
    });

    oldAnswers(null, true);
    rerender();
    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();

    pickSpareInSidebar();
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      SPARE_DESKTOP,
    );

    oldAnswers(OLD_OWN_SETTINGS, false);
    rerender();
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Environment" }),
      ).toBeTruthy();
    });

    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      SPARE_DESKTOP,
    );
    expect(
      screen.getByTestId("environment-picker-trigger").textContent,
    ).toContain("Spare desktop");
  });
});

async function overviewShowsOldLaptop(): Promise<void> {
  await waitFor(() => {
    expect(
      within(screen.getByRole("combobox", { name: "Environment" })).getByText(
        "Old laptop",
      ),
    ).toBeTruthy();
  });
}

describe("the Overview row follows only while the person has done nothing later", () => {
  it("plain follow: writes the computer's own settings into the rail when nothing else happens", async () => {
    oldAnswers(OLD_OWN_SETTINGS, false);
    mount();

    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        OLD_LAPTOP,
      );
    });
    expect(
      screen.getByTestId("environment-picker-trigger").textContent,
    ).toContain("Old laptop");
  });

  it.each([
    { name: "reselect the same row", between: [] as readonly string[] },
    { name: "pick another row, then the same row", between: ["other"] },
  ])(
    "reselect E: keeps the row picked again after the Overview opened ($name)",
    async ({ between }) => {
      const setOverviewHost = mountOverview(null);
      pickSpareInSidebar();
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        SPARE_DESKTOP,
      );

      setOverviewHost("old");
      for (const hostId of between) {
        pickInSidebar(hostId);
        expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
          OTHER_DESKTOP,
        );
      }
      pickSpareInSidebar();

      oldAnswers(OLD_OWN_SETTINGS, false);
      setOverviewHost("old");
      await overviewShowsOldLaptop();

      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        SPARE_DESKTOP,
      );
      expect(
        screen.getByTestId("environment-picker-trigger").textContent,
      ).toContain("Spare desktop");
    },
  );

  it("null gap then the same host: keeps a pick made while the Overview's card was gone", async () => {
    oldAnswers(OLD_OWN_SETTINGS, false);
    const setOverviewHost = mountOverview("old");
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        OLD_LAPTOP,
      );
    });

    setOverviewHost(null);
    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
    pickSpareInSidebar();
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      SPARE_DESKTOP,
    );

    setOverviewHost("old");
    await overviewShowsOldLaptop();

    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      SPARE_DESKTOP,
    );
    expect(
      screen.getByTestId("environment-picker-trigger").textContent,
    ).toContain("Spare desktop");
  });

  it("upkeep writes Personal and F's later source change still follows", async () => {
    oldAnswers(OLD_OWN_SETTINGS, false);
    const setOverviewHost = mountOverview("old");
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        OLD_LAPTOP,
      );
    });

    // "old" moved into Personal as the picker reads it; the card's own read
    // has not answered again.
    reads.old = { data: null, supported: true, isError: false };
    reads.statuses.set("old", OLD_MOVED);
    setOverviewHost("old");
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        PERSONAL_PICK,
      );
    });

    reads.old = { data: OLD_MOVED, supported: true, isError: false };
    reads.binding = TEAM_BINDING;
    setOverviewHost("old");
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "team",
        environmentId: "env-team",
      });
    });
  });
});
