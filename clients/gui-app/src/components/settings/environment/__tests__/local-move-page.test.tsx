import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import { LocalMovePageOr } from "@/components/settings/environment/local-move-page";
import { EnvironmentPickUpkeep } from "@/components/settings/environment-picker";
import { environmentPickerModel } from "@/components/settings/environment/environment-picker-model";
import type { EnvironmentPickerModel } from "@/components/settings/environment/environment-picker-model";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const HOST_ID = "local-host";
const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => clientMock.current,
}));
const pickerModelMock = vi.hoisted(
  (): {
    current: EnvironmentPickerModel | null;
    statuses: Map<string, EnvironmentStatusResponseV12>;
  } => ({ current: null, statuses: new Map() }),
);
vi.mock(
  "@/components/settings/environment/use-environment-status-model",
  () => ({
    useEnvironmentStatusModel: () => ({
      picker: pickerModelMock.current,
      statuses: pickerModelMock.statuses,
    }),
  }),
);
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/host-scope/use-host-scope")
      >();
    const { hostScopeFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return { ...actual, useHostScopeFor: () => hostScopeFixture({}) };
  },
);

function renderPage(
  section: "mcp-servers" | "skills" | "sandboxes" | "storage",
  status: EnvironmentStatusResponseV12,
): void {
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: { "environment.status": () => status },
  });
  clientMock.current = client;
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LocalMovePageOr section={section}>
        <p data-testid="normal-settings-panel">Real section panel</p>
      </LocalMovePageOr>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useMoveSheetStore.setState({ target: null });
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: HOST_ID, hostName: "Old laptop" },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientMock.current = null;
  pickerModelMock.current = null;
  pickerModelMock.statuses.clear();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("LocalMovePageOr", () => {
  it.each([
    [
      "mcp-servers",
      "MCP servers",
      "Add an MCP server once and every coding agent can use it, on this computer, your other computers and your sandboxes.",
      "Move Old laptop to Personal to add and use them here.",
    ],
    [
      "skills",
      "Skills",
      "Add a skill once and every coding agent can use it, on this computer, your other computers and your sandboxes.",
      "Move Old laptop to Personal to add and use them here.",
    ],
    [
      "sandboxes",
      "Sandboxes",
      "You can start a sandbox from any task now.",
      "Move Old laptop to Personal and your sandboxes get the settings you set up here, and agents on Old laptop can start sandboxes too.",
    ],
    [
      "storage",
      "Storage",
      "Keep chats in the cloud instead of on disk, and clear out tasks nobody has used.",
      "Move Old laptop to Personal to choose this once for every computer you use.",
    ],
  ] as const)(
    "offers the move on the Local %s page",
    (section, title, gain, afterMove) => {
      renderPage(
        section,
        environmentStatusFixture({
          principal: null,
          planes: { records: "local", broker: "local", room: "local" },
          setup: { stage: "moving_settings", state: "awaiting_consent" },
        }),
      );

      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
      const page = screen.getByTestId("local-move-page");
      expect(page.textContent).toContain(gain);
      expect(page.textContent).toContain(afterMove);
      expect(within(page).getAllByRole("button")).toHaveLength(1);
      fireEvent.click(screen.getByTestId("local-move-page-move"));
      expect(useMoveSheetStore.getState().target).toEqual({
        hostId: HOST_ID,
        hostName: "Old laptop",
      });
    },
  );

  it("shows move progress in place of the offer while a move runs", async () => {
    renderPage(
      "skills",
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "running" },
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
        ],
      }),
    );

    expect(
      await screen.findByTestId("host-settings-card-progress"),
    ).toBeTruthy();
    expect(screen.queryByTestId("local-move-page-move")).toBeNull();
  });

  it("shows no count while the move has registered no item", async () => {
    renderPage(
      "mcp-servers",
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "running" },
      }),
    );

    await screen.findByTestId("host-settings-card-progress");
    const page = screen.getByTestId("local-move-page");
    expect(
      within(page).getByTestId("host-settings-card-progress").textContent,
    ).toBe("Moving this computer's settings to Personal");
  });

  it("says the move stopped, and not Move to Personal, once it stalled", async () => {
    renderPage(
      "mcp-servers",
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "stalled" },
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "pending" }),
        ],
      }),
    );

    await screen.findByTestId("host-settings-card-move-stopped");
    const page = screen.getByTestId("local-move-page");
    expect(
      within(page).getByTestId("host-settings-card-move-stopped").textContent,
    ).toBe("Moving stopped: it timed out. 1 item left.");
    expect(
      within(page).queryByRole("button", { name: "Move to Personal" }),
    ).toBeNull();
  });

  it("keeps the real panel for a non-Local pick and an unrelated section", () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LocalMovePageOr section="skills">
          <p data-testid="normal-settings-panel">Real section panel</p>
        </LocalMovePageOr>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("normal-settings-panel")).toBeTruthy();
    cleanup();
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: HOST_ID, hostName: "Old laptop" },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LocalMovePageOr section="providers">
          <p data-testid="normal-settings-panel">Real section panel</p>
        </LocalMovePageOr>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("normal-settings-panel")).toBeTruthy();
  });

  it.each([
    ["moved", environmentStatusFixture({ principal: { kind: "personal" } })],
    [
      "team-owned",
      environmentStatusFixture({
        principal: { kind: "team", teamName: "Designers" },
        planes: { records: "local", broker: "local", room: "local" },
      }),
    ],
  ] as const)(
    "drops a stale Local pick for a %s computer without a picker",
    async (_label, status) => {
      pickerModelMock.statuses = new Map([[HOST_ID, status]]);
      pickerModelMock.current = environmentPickerModel({
        hosts: [{ hostId: HOST_ID, name: "Old laptop" }],
        statuses: new Map([[HOST_ID, status]]),
        versions: new Map([[HOST_ID, { major: 1, minor: 1 }]]),
        windowHostId: null,
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <EnvironmentPickUpkeep />
          <LocalMovePageOr section="skills">
            <p data-testid="real-skills-panel">Skills settings panel</p>
          </LocalMovePageOr>
        </QueryClientProvider>,
      );

      expect(await screen.findByTestId("real-skills-panel")).toBeTruthy();
      expect(screen.queryByTestId("local-move-page")).toBeNull();
      expect(useSettingsEnvironmentPickStore.getState().pick).toBeNull();
    },
  );
});
