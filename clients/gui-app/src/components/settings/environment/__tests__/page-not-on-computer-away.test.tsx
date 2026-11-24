// A Local pick of a computer this app cannot reach answers every page it lacks
// with "Can't reach {name} from here", never with Update: nothing on it can be
// updated until it is back. A computer that is reachable and merely below the
// minimum version keeps the update. The scope is the real one over a stood-in
// host list, so the status comes from the host's own facts.
vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-client/minimum-host-version")
    >()),
    MINIMUM_HOST_VERSION: "2.0.0",
  }),
);

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  /** The host lists' own state: still loading, or failed before any row. */
  listsResolved: true,
  listsFailed: false,
  isLoading: false,
  retryLists: vi.fn(),
  /** Whether Host Overview would offer Update now on the picked computer. */
  updateApplies: true,
  startUpdate: vi.fn(),
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: harness.hosts,
        activeHostId: harness.activeHostId,
        listsResolved: harness.listsResolved,
        listsFailed: harness.listsFailed,
        isLoading: harness.isLoading,
        retryLists: harness.retryLists,
      }),
  };
});
// The skew action under a below-minimum computer is the real button over this
// update; Host Overview's own Update now is the card's, so it is answered here.
vi.mock("@/hooks/host/use-older-host-update", () => ({
  useOlderHostUpdate: () => ({
    update: harness.startUpdate,
    pending: false,
    remotePending: false,
    failure: null,
  }),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-provisioning-progress", () => ({
  useHostProvisioningProgress: () => null,
}));
vi.mock(
  "@/components/settings/panels/host-update-now-action",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/panels/host-update-now-action")
    >()),
    useHostUpdateNow: () => ({
      applies: harness.updateApplies,
      action: <button type="button">Host Overview update</button>,
    }),
  }),
);
vi.mock("@/providers/use-runner-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/use-runner-host")>()),
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
    hostManagement: null,
  }),
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";
import { PageOrNotOnComputer } from "@/components/settings/environment/page-not-on-computer";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { pickOldHostLocal } from "@/components/settings/__tests__/old-host-pick-fixture";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { HOST_UPDATE_SKEW_COPY } from "@/lib/host/version-skew-copy";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { SettingsSectionId } from "@/lib/settings-sections";
import type { ReactNode } from "react";

/** A computer whose app is older than the minimum the Settings pages need. */
function belowMinimumEntry(hostId: string): RemoteHostDirectoryEntry {
  const base = remoteEntry(hostId, null);
  return {
    ...base,
    version: "1.5.4",
    remoteStatus: { ...base.remoteStatus, appVersion: "1.5.4" },
  };
}

function listOldHost(overrides: Partial<HostScopeOption>): void {
  harness.hosts = [
    hostScopeOptionFixture({
      hostId: "host-old",
      name: "Old laptop",
      isLocalMachine: false,
      isActive: false,
      ...overrides,
    }),
  ];
}

/** Concealed or absent: the page stays mounted beneath the notice, out of view. */
function expectHiddenFromView(node: Element | null): void {
  expect(node === null || isConcealed(node)).toBe(true);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function pageElement(section: SettingsSectionId): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <PageOrNotOnComputer section={section}>
        <input data-testid="draft" />
      </PageOrNotOnComputer>
    </QueryClientProvider>
  );
}

function renderSecrets(): void {
  render(pageElement("secrets"));
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  harness.hosts = [];
  harness.activeHostId = null;
  harness.listsResolved = true;
  harness.listsFailed = false;
  harness.isLoading = false;
  harness.updateApplies = true;
  harness.retryLists.mockReset();
  harness.startUpdate.mockReset();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

describe("Secrets under a Local pick of an old computer", () => {
  it("shows Can't reach, not Update, when the computer has no connection to this app", () => {
    pickOldHostLocal();
    listOldHost({ connectable: false });

    renderSecrets();

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("page-not-on-computer-update"));
  });

  it("shows Can't reach, not Update, when the computer is below the minimum version and has no connection", () => {
    pickOldHostLocal();
    listOldHost({
      connectable: false,
      entry: belowMinimumEntry("host-old"),
    });

    renderSecrets();

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("page-not-on-computer-update"));
  });

  // Secrets has no update to keep (no host update serves it), so the page an
  // update gives is MCP servers.
  it("keeps the update on a page an update gives when the computer is connected and merely below the minimum version", () => {
    pickOldHostLocal();
    listOldHost({
      connectable: true,
      entry: belowMinimumEntry("host-old"),
    });

    render(pageElement("mcp-servers"));

    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(
      screen.getByTestId("page-not-on-computer-update").textContent,
    ).toContain("Update Old laptop to use MCP servers.");
    fireEvent.click(
      screen.getByRole("button", { name: HOST_UPDATE_SKEW_COPY.action }),
    );
    expect(harness.startUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("A page an old computer has, under a Local pick that goes out of reach and comes back", () => {
  it("shows only the notice while it is out of reach, and gives back the draft typed before", () => {
    pickOldHostLocal();
    harness.activeHostId = "host-old";
    listOldHost({ connectable: true, isActive: true });
    const view = render(pageElement("providers"));
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    fireEvent.change(screen.getByTestId("draft"), {
      target: { value: "keep this draft" },
    });

    listOldHost({ connectable: false, isActive: true });
    view.rerender(pageElement("providers"));

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("draft"));

    listOldHost({ connectable: true, isActive: true });
    view.rerender(pageElement("providers"));

    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(screen.getByTestId("draft")).toHaveProperty(
      "value",
      "keep this draft",
    );
  });
});

const WINDOW_HOST = hostScopeOptionFixture({
  hostId: "host-win",
  name: "Window laptop",
  isLocalMachine: true,
  isActive: true,
});

/** The window's host is named and listed, and has answered nothing yet. */
function pickPersonalOnUnansweredWindowHost(): void {
  useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
  harness.hosts = [WINDOW_HOST];
  harness.activeHostId = "host-win";
}

function railLabel(section: SettingsSectionId): string {
  const entry = SETTINGS_SECTIONS.find((item) => item.id === section);
  if (entry === undefined) throw new Error(`no section ${section}`);
  return entry.label;
}

describe("An Environment page under a Personal pick whose window host has not answered", () => {
  it.each([
    "providers",
    "mcp-servers",
    "skills",
    "agent-memories",
    "sandboxes",
    "storage",
  ] as const)(
    "shows %s under its own heading with Connecting, not the page",
    (section) => {
      pickPersonalOnUnansweredWindowHost();

      render(pageElement(section));

      expect(
        screen.getByRole("heading", { name: railLabel(section) }),
      ).toBeTruthy();
      expect(screen.getByTestId("host-scope-connecting").textContent).toContain(
        "Connecting to Window laptop",
      );
      expect(screen.queryByTestId("draft")).toBeNull();
    },
  );

  it("shows Secrets as Connecting, not the cloud page, while the host row the authority names has not arrived", () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    harness.activeHostId = "host-win";
    harness.listsResolved = false;
    harness.isLoading = true;

    renderSecrets();

    expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
    expect(screen.queryByTestId("draft")).toBeNull();
  });
});

describe("Personal's Secrets while the window host's row is missing and another computer is listed", () => {
  beforeEach(() => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    harness.activeHostId = "host-win";
    // Not connectable, so a scope reading it would put Personal on the cloud.
    harness.hosts = [
      hostScopeOptionFixture({
        hostId: "host-other",
        name: "Other laptop",
        isLocalMachine: false,
        isActive: false,
        connectable: false,
      }),
    ];
  });

  it.each([
    { lists: "loading", isLoading: true },
    { lists: "neither answered nor loading", isLoading: false },
  ])(
    "waits under its heading while the lists are $lists, rather than read the other computer",
    ({ isLoading }) => {
      harness.listsResolved = false;
      harness.isLoading = isLoading;

      renderSecrets();

      expect(screen.getByRole("heading", { name: "Secrets" })).toBeTruthy();
      expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
      expect(screen.queryByText(/Other laptop/)).toBeNull();
      expect(screen.queryByTestId("draft")).toBeNull();
    },
  );

  it("offers the lists' retry when they failed, rather than read the other computer", () => {
    harness.listsFailed = true;

    renderSecrets();

    expect(screen.getByTestId("host-scope-lists-failed")).toBeTruthy();
    expect(screen.queryByTestId("draft")).toBeNull();
  });
});

describe("A Local pick whose computer's row is missing while a host list has neither answered nor started loading", () => {
  it("waits with Connecting, never that the computer is unlisted", () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
    });
    harness.listsResolved = false;

    renderSecrets();

    expect(screen.queryByTestId("page-not-on-computer-unlisted")).toBeNull();
    expect(screen.getByTestId("host-scope-connecting").textContent).toContain(
      "Connecting to Old laptop",
    );
  });
});

describe("A page under a pick while the host lists failed before supplying a row", () => {
  beforeEach(() => {
    harness.listsResolved = false;
    harness.listsFailed = true;
  });

  it("answers a Local pick with the list failure and its retry, never that the computer is unlisted", () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
    });

    renderSecrets();

    expect(screen.queryByTestId("page-not-on-computer-unlisted")).toBeNull();
    expect(screen.getByTestId("host-scope-lists-failed").textContent).toContain(
      "Couldn't load your hosts",
    );
    fireEvent.click(screen.getByTestId("host-scope-retry-lists"));
    expect(harness.retryLists).toHaveBeenCalledTimes(1);
  });

  it("answers Personal's Secrets, whose window host row is missing, with the list failure and its retry", () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    harness.activeHostId = "host-win";

    renderSecrets();

    expect(screen.queryByTestId("draft")).toBeNull();
    expect(screen.getByTestId("host-scope-lists-failed")).toBeTruthy();
    fireEvent.click(screen.getByTestId("host-scope-retry-lists"));
    expect(harness.retryLists).toHaveBeenCalledTimes(1);
  });
});

describe("The away notice on a page an old computer lacks", () => {
  it("sits under the section's own heading", () => {
    pickOldHostLocal();
    listOldHost({ connectable: false });

    renderSecrets();

    expect(screen.getByTestId("host-scope-unreachable")).toBeTruthy();
    // The hidden page beneath keeps its own heading; one is in view.
    const shown = screen
      .getAllByRole("heading", { name: "Secrets", hidden: true })
      .filter((heading) => !isConcealed(heading));
    expect(shown).toHaveLength(1);
  });

  it("offers no way back to the active computer, and claims no status above it", () => {
    pickOldHostLocal();
    listOldHost({ connectable: false });

    renderSecrets();

    const notice = screen.getByTestId("host-scope-unreachable");
    expect(screen.queryByTestId("host-scope-return-to-active")).toBeNull();
    expect(notice.textContent).not.toContain(
      "Its status above is from your account, not a live link.",
    );
  });
});

describe("The update line on a page a picked computer lacks", () => {
  const updateLine = (name: string, label: string): string =>
    `Update ${name} to use ${label}.`;

  // The window's own computer, so the scope reaches it and no away notice
  // stands in for the page.
  function listActive(hostId: string, name: string): void {
    harness.activeHostId = hostId;
    harness.hosts = [
      hostScopeOptionFixture({
        hostId,
        name,
        isLocalMachine: false,
        isActive: true,
      }),
    ];
  }

  it("is absent where updating cannot give the page: a current computer without the secrets list", () => {
    recordNegotiatedHostManifest("host-new", {
      "environment.status": { major: 1, minor: 3 },
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-new", hostName: "New laptop" },
    });
    listActive("host-new", "New laptop");
    harness.updateApplies = true;

    renderSecrets();

    expect(screen.getByText("Not on New laptop")).toBeTruthy();
    expect(screen.queryByText(updateLine("New laptop", "Secrets"))).toBeNull();
    expect(
      within(screen.getByTestId("page-not-on-computer")).queryByRole("button"),
    ).toBeNull();
  });

  it("shows with Host Overview's action on an old computer's MCP servers when an update applies", () => {
    pickOldHostLocal();
    listActive("host-old", "Old laptop");
    harness.updateApplies = true;

    render(pageElement("mcp-servers"));

    expect(
      screen.getByText(updateLine("Old laptop", "MCP servers")),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Host Overview update" }),
    ).toBeTruthy();
  });

  it("is absent on an old computer's MCP servers when no update applies", () => {
    pickOldHostLocal();
    listActive("host-old", "Old laptop");
    harness.updateApplies = false;

    render(pageElement("mcp-servers"));

    expect(screen.getByText("Not on Old laptop")).toBeTruthy();
    expect(
      screen.queryByText(updateLine("Old laptop", "MCP servers")),
    ).toBeNull();
  });

  it("is absent on an old computer's Secrets, which no update gives", () => {
    pickOldHostLocal();
    listActive("host-old", "Old laptop");
    harness.updateApplies = true;

    renderSecrets();

    expect(screen.getByText("Not on Old laptop")).toBeTruthy();
    expect(screen.queryByText(updateLine("Old laptop", "Secrets"))).toBeNull();
  });
});
