import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { EnvironmentPicker } from "@/components/settings/environment-picker";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { HostOverviewSettingsCard } from "@/components/settings/panels/host-overview-settings-card";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const reads = vi.hoisted(() => ({
  statuses: new Map<string, EnvironmentStatusResponseV11 | null>(),
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
      reread: () => undefined,
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

function mount(status: EnvironmentStatusResponseV11): void {
  reads.statuses.set("old", status);
  recordNegotiatedHostManifest("old", {
    "environment.status": { major: 1, minor: 1 },
  });
  const { client } = buildEnvironmentClient({ hostId: "old", handlers: {} });
  const host = hostScopeOptionFixture({ hostId: "old", name: "Old laptop" });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <EnvironmentPicker
        scope={hostScopeFixture({
          hosts: [host],
          host,
          activeHostId: "old",
        })}
        activeSection="mcp-servers"
      />
      <HostOverviewSettingsCard
        client={client}
        hostId="old"
        hostName="Old laptop"
        status={status}
        binding={BINDING}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  reads.statuses.clear();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("the Overview row and the Environment dropdown on a stopped move", () => {
  it("leaves the rail alone when the stopped move has no Local row", async () => {
    const picks: string[] = [];
    const unsubscribe = useSettingsEnvironmentPickStore.subscribe(
      (state, previous) => {
        if (state.pick === previous.pick) return;
        picks.push(state.pick === null ? "cleared" : state.pick.kind);
      },
    );
    mount(
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "stalled" },
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useSettingsEnvironmentPickStore.getState().pick).toBeNull();
    expect(picks).not.toContain("local");
    expect(
      screen.getByTestId("environment-picker-trigger").textContent,
    ).toContain("Personal");
    expect(
      within(screen.getByRole("combobox", { name: "Environment" })).getByText(
        "Old laptop",
      ),
    ).toBeTruthy();
    unsubscribe();
  });

  it("settles on the computer when the stopped move still has a Local row", async () => {
    const picks: string[] = [];
    const unsubscribe = useSettingsEnvironmentPickStore.subscribe(
      (state, previous) => {
        if (state.pick === previous.pick) return;
        picks.push(state.pick === null ? "cleared" : state.pick.kind);
      },
    );
    mount(
      environmentStatusFixture({
        principal: null,
        planes: { records: "stopped", broker: "stopped", room: "stopped" },
        setup: { stage: "moving_settings", state: "stalled" },
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "local",
      hostId: "old",
      hostName: "Old laptop",
    });
    expect(picks).not.toContain("cleared");
    expect(
      screen.getByTestId("environment-picker-trigger").textContent,
    ).toContain("Old laptop");
    unsubscribe();
  });
});
