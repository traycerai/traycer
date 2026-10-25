import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentPicker } from "@/components/settings/environment-picker";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

// The two per-host reads the picker draws from are queries and a manifest
// registry; they are the boundary, so the suite answers them directly.
const reads = vi.hoisted(() => ({
  statuses: new Map<string, unknown>(),
  versions: new Map<string, unknown>(),
}));
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => reads.statuses,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => reads.versions,
}));
// The team rows read the account's configuration list; this suite has none.
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: { environments: [] } }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigation.navigate,
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
  consent: { acceptedAt: 1, planHash: "hash" },
});
const running = environmentStatusFixture({ principal: { kind: "personal" } });

function renderPicker(windowHostId: string): void {
  const hosts = [
    hostScopeOptionFixture({ hostId: "mac", name: "MacBook Pro" }),
    hostScopeOptionFixture({ hostId: "dev", name: "dev-box" }),
    hostScopeOptionFixture({ hostId: "old", name: "Old laptop" }),
    hostScopeOptionFixture({ hostId: "tiny", name: "Tiny" }),
  ];
  render(
    <EnvironmentPicker
      scope={hostScopeFixture({
        hosts,
        host: hosts[0],
        activeHostId: windowHostId,
      })}
      activeSection="mcp-servers"
    />,
  );
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
  navigation.navigate.mockClear();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  useMoveSheetStore.setState({ target: null });
  useSettingsHostScopeStore.setState({ scopedHostId: null });
});

afterEach(() => {
  cleanup();
});

describe("<EnvironmentPicker />", () => {
  it("draws an awaiting_consent host as a Local row and opens the move sheet from its verb", () => {
    answer("mac", running, V11);
    answer("dev", running, V11);
    answer("old", awaiting, V11);
    renderPicker("mac");
    openMenu();

    const row = screen.getByTestId("environment-picker-local-old");
    expect(row.textContent).toContain("Old laptop");
    expect(row.textContent).toContain("Local");
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

  it("explains the Local badge on hover, in its row", async () => {
    answer("mac", running, V11);
    answer("old", awaiting, V11);
    renderPicker("mac");
    openMenu();

    const badge = within(
      screen.getByTestId("environment-picker-local-old"),
    ).getByText("Local");
    await userEvent.hover(badge);

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Settings on this computer only",
    );
  });

  it("explains the Local badge on the trigger when the pick is Local", async () => {
    answer("old", awaiting, V11);
    renderPicker("old");

    await userEvent.hover(
      within(screen.getByTestId("environment-picker-trigger")).getByText(
        "Local",
      ),
    );

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Settings on this computer only",
    );
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
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe("old");
    expect(navigation.navigate).toHaveBeenCalledWith("host");
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
    expect(grey.textContent).toContain(
      "Old laptop needs an update to show its settings here.",
    );
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
      "Old laptopLocal",
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

  it("names this window's own computer under Personal once it runs Personal, listed or not", () => {
    const hosts = [
      hostScopeOptionFixture({
        hostId: "mac",
        name: "MacBook Pro",
        isLocalMachine: true,
        registered: false,
        item: null,
      }),
    ];
    answer("mac", running, V11);
    render(
      <EnvironmentPicker
        scope={hostScopeFixture({ hosts, host: hosts[0], activeHostId: "mac" })}
        activeSection="mcp-servers"
      />,
    );
    openMenu();

    expect(screen.getByTestId("environment-picker-personal").textContent).toBe(
      "Personalyour settings · on MacBook Pro",
    );
  });

  it("says Personal is not on any computer or sandbox while none runs it", () => {
    const hosts = [
      hostScopeOptionFixture({
        hostId: "old",
        name: "Old laptop",
        isLocalMachine: true,
        registered: false,
        item: null,
      }),
    ];
    answer("old", awaiting, V11);
    render(
      <EnvironmentPicker
        scope={hostScopeFixture({ hosts, host: hosts[0], activeHostId: "old" })}
        activeSection="mcp-servers"
      />,
    );
    openMenu();

    expect(screen.getByTestId("environment-picker-personal").textContent).toBe(
      "Personalyour settings · not on any computer or sandbox",
    );
  });

  it("picking a row that hides the open page leaves it for Providers", () => {
    answer("old", awaiting, V11);
    renderPicker("mac");
    openMenu();

    act(() => {
      fireEvent.click(screen.getByTestId("environment-picker-local-old"));
    });
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "local",
      hostId: "old",
      hostName: "Old laptop",
    });
    expect(navigation.navigate).toHaveBeenCalledWith("providers");
  });
});
