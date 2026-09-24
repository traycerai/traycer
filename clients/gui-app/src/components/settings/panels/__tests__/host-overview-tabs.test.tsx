// The Overview re-provides a scoped STREAM binding beside its unary one (for
// the Data & migration group), and the real hook reads `useAuthService` -
// which this suite deliberately does not stand up. `null` keeps the panel on
// the ambient stream, the arrangement every other Overview suite already
// assumes.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

// Same boundary as every other Overview suite: mock `useHostScope` and
// `@/lib/host`'s `useHostBinding` rather than standing up a host runtime.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly getLocalEntry: () => { readonly hostId: string } | null;
    // `HostRestartSessions` (mounted inside `RestartHostConfirmDialog`) calls
    // `useFocusModel()` -> `useConnectableHostIds()` -> `useHostDirectoryList()`,
    // which reads `directory.list()` for its query and subscribes via
    // `directory.onChange()` the moment the dialog opens. Neither answer
    // matters to this suite; they just need to exist.
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

// The chat tile's host-update link is driven for real below, beside the page.
// Its tile host and directory row are the only things it reads from outside
// this page, and its `openSettings` arms the same one-shot intent the real
// modal action arms first (`use-system-tab-modal.ts`); the navigation after
// that is not this suite's subject.
const tabHostIdRef = vi.hoisted((): { current: string } => ({
  current: "host-a",
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => tabHostIdRef.current,
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/tabs/use-system-tab-modal")>();
  const { armSettingsOpenIntent: arm } =
    await import("@/stores/tabs/settings-open-intent-store");
  return {
    ...actual,
    useSystemTabModalActions: () => ({ openSettings: arm }),
  };
});

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactVersionSettingsGetResponse } from "@traycer/protocol/host/epic/artifact-versions";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { useChatTileHostUpdate } from "@/components/epic-canvas/renderers/use-chat-tile-host-update";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { HOST_OVERVIEW_TABS } from "@/components/settings/panels/host-overview.definitions";
import {
  buildOverviewHostFixture,
  openHostOverviewMenu,
  selectHostOverviewTab,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import {
  armSettingsOpenIntent,
  resetSettingsOpenIntentForTests,
  useSettingsOpenIntentStore,
} from "@/stores/tabs/settings-open-intent-store";

const ALL_OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;

const ARTIFACT_VERSION_METHODS = [
  "epic.artifactVersionSettings.get",
  "epic.artifactVersionSettings.setEnabled",
  "epic.artifactVersionSettings.setRetentionPolicy",
  "epic.artifactVersionSettings.clearHistory",
] as const;

const ARTIFACT_VERSION_SNAPSHOT: ArtifactVersionSettingsGetResponse = {
  settings: {
    enabled: true,
    retentionDays: 30,
    maxVersionsPerArtifact: 100,
    maxBytesPerArtifact: 16 * 1024 * 1024,
  },
};

const LONG_NAME = "build-worker-with-a-very-long-name-that-cannot-fit-a-phone";

/**
 * A host that reported a download in progress (`host.status@1.3`'s attempt),
 * so the page has update progress to retain once the scope stops being usable.
 */
const DOWNLOADING_STATUS: ResponseOfMethod<HostRpcRegistry, "host.status"> = {
  ready: true,
  hostVersion: "1.5.0",
  protocolVersion: { major: 1, minor: 3 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
  updateOperation: {
    kind: "attempt",
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    targetVersion: "2.1.0",
    trigger: "manual",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    liveness: "active",
    livenessCause: null,
    busySessionCount: null,
    busyBreakdown: null,
    error: null,
  },
  updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
  storeFormats: null,
  install: null,
};

function scopeFrom(
  hostId: string,
  fixture: OverviewHostFixture,
): Record<string, unknown> {
  return {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: true,
      connectable: true,
      isActive: true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
}

/** A known remote host still connecting: no client, nothing cached. */
function coldConnectingScope(): Record<string, unknown> {
  return {
    host: hostScopeOptionFixture({
      hostId: "host-a",
      isLocalMachine: false,
      connectable: false,
    }),
    hostId: "host-a",
    status: "connecting",
    client: null,
  };
}

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      getLocalEntry: () => null,
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function makeRunnerHost(): IRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function buildFixture(hostId: string): OverviewHostFixture {
  return buildOverviewHostFixture({
    hostId,
    isLocalMachine: true,
    overrideHandlers: {
      "epic.artifactVersionSettings.get": () => ARTIFACT_VERSION_SNAPSHOT,
    },
  });
}

function renderPanel(): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={makeRunnerHost()}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/**
 * Mounts the page and returns a `rerender` that re-reads the mocked scope. A
 * fresh element per call: React skips a subtree handed the SAME element twice,
 * so a reused one would never call `useHostScope()` again.
 */
function renderPanelPersistent(extra: ReactNode): { rerender: () => void } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const runnerHost = makeRunnerHost();
  const buildTree = (): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
        {extra}
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(buildTree());
  return { rerender: () => rerender(buildTree()) };
}

/** The chat tile's "update this host" link, as a tile renders it. */
function HostUpdateLink(): ReactNode {
  const { openHostUpdate } = useChatTileHostUpdate();
  return (
    <button type="button" onClick={openHostUpdate}>
      Open host update
    </button>
  );
}

/** The test id of whichever desktop tab trigger currently reads `data-state="active"`. */
function activeTabTestId(): string | null {
  const active = screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("data-state") === "active");
  return active?.getAttribute("data-testid") ?? null;
}

const initialInnerWidth = window.innerWidth;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  resetSettingsOpenIntentForTests();
  useSettingsSearchStore.setState({ pendingReveal: null });
  useSettingsHostScopeStore.setState({ scopedHostId: null });
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  tabHostIdRef.current = "host-a";
  window.innerWidth = initialInnerWidth;
});

describe("<HostSettingsPanel /> Overview — tabbed shell", () => {
  it("opens on Status", () => {
    const fixture = buildFixture("host-a");
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    expect(activeTabTestId()).toBe("host-overview-tab-status");
  });

  it("a tab named in the open intent opens that tab, and spends the intent", () => {
    const fixture = buildFixture("host-a");
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture);
    armSettingsOpenIntent({
      section: "host",
      resetToGeneral: false,
      tab: "installation",
      draft: null,
      hostId: null,
    });
    renderPanel();

    expect(activeTabTestId()).toBe("host-overview-tab-installation");
    expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
  });

  describe("a link into the Overview", () => {
    it("brings a page open on another tab back to Status", async () => {
      const fixture = buildFixture("host-a");
      recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
      hostBindingMock.current = bindingWith(fixture.client);
      scopeOverrides.current = scopeFrom("host-a", fixture);
      renderPanelPersistent(<HostUpdateLink />);
      await selectHostOverviewTab("data");

      fireEvent.click(screen.getByRole("button", { name: "Open host update" }));

      expect(activeTabTestId()).toBe("host-overview-tab-status");
      expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
    });

    it("brings it back to Status when it moves the page to another host", async () => {
      const fixtureA = buildFixture("host-a");
      const fixtureB = buildFixture("host-b");
      recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
      recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
      hostBindingMock.current = bindingWith(fixtureA.client);
      scopeOverrides.current = scopeFrom("host-a", fixtureA);
      // The tile is on host-b while Settings shows host-a.
      tabHostIdRef.current = "host-b";
      renderPanelPersistent(<HostUpdateLink />);
      await selectHostOverviewTab("data");

      // The link carries its tile's host into the Settings scope; the mocked
      // scope resolves that host from the same render the intent arrives in.
      hostBindingMock.current = bindingWith(fixtureB.client);
      scopeOverrides.current = scopeFrom("host-b", fixtureB);
      fireEvent.click(screen.getByRole("button", { name: "Open host update" }));

      expect(useSettingsHostScopeStore.getState().scopedHostId).toBe("host-b");
      expect(activeTabTestId()).toBe("host-overview-tab-status");
    });
  });

  it("ignores a tab name the page does not have, and stays on Status", () => {
    const fixture = buildFixture("host-a");
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture);
    armSettingsOpenIntent({
      section: "host",
      resetToGeneral: false,
      tab: "nonexistent-tab",
      draft: null,
      hostId: null,
    });
    renderPanel();

    expect(activeTabTestId()).toBe("host-overview-tab-status");
    expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
  });

  describe("a settings-search landing", () => {
    for (const tab of HOST_OVERVIEW_TABS) {
      it(`selects ${tab} for its trigger's anchor`, () => {
        const fixture = buildFixture("host-a");
        recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
        hostBindingMock.current = bindingWith(fixture.client);
        scopeOverrides.current = scopeFrom("host-a", fixture);
        useSettingsSearchStore.setState({
          pendingReveal: {
            section: "host",
            anchor: `host-overview-tab-${tab}`,
            requestedAt: 1,
          },
        });
        renderPanel();

        expect(activeTabTestId()).toBe(`host-overview-tab-${tab}`);
      });
    }
  });

  it("keeps a typed value on a visited tab across a switch away and back", async () => {
    const fixture = buildFixture("host-a");
    recordNegotiatedHostMethods("host-a", [
      ...ALL_OVERVIEW_METHODS,
      ...ARTIFACT_VERSION_METHODS,
    ]);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await selectHostOverviewTab("data");
    const retentionInput = await screen.findByLabelText("Days");
    fireEvent.change(retentionInput, { target: { value: "45" } });
    expect(retentionInput).toHaveProperty("value", "45");

    await selectHostOverviewTab("status");
    await selectHostOverviewTab("data");

    expect(screen.getByLabelText("Days")).toHaveProperty("value", "45");
  });

  it("a host switch keeps the selected tab and closes an open confirmation", async () => {
    const fixtureA = buildFixture("host-a");
    const fixtureB = buildFixture("host-b");
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixtureA.client);
    scopeOverrides.current = scopeFrom("host-a", fixtureA);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = makeRunnerHost();
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    await selectHostOverviewTab("installation");
    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    expect(
      await screen.findByRole("button", { name: "Restart host" }),
    ).not.toBeNull();

    hostBindingMock.current = bindingWith(fixtureB.client);
    scopeOverrides.current = scopeFrom("host-b", fixtureB);
    view.rerender(makeUi());

    expect(activeTabTestId()).toBe("host-overview-tab-installation");
    expect(screen.queryByRole("button", { name: "Restart host" })).toBeNull();
  });

  describe("on a phone", () => {
    it("carries the active tab's anchor on the Select, and puts Activate in the ⋯ menu", async () => {
      window.innerWidth = 500;
      const fixture = buildFixture("host-a");
      recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
      hostBindingMock.current = bindingWith(fixture.client);
      scopeOverrides.current = {
        ...scopeFrom("host-a", fixture),
        host: hostScopeOptionFixture({
          hostId: "host-a",
          isLocalMachine: true,
          connectable: true,
          isActive: false,
        }),
      };
      armSettingsOpenIntent({
        section: "host",
        resetToGeneral: false,
        tab: "data",
        draft: null,
        hostId: null,
      });
      renderPanel();

      expect(screen.queryAllByRole("tab")).toHaveLength(0);
      const select = await screen.findByRole("combobox", { name: "Section" });
      expect(select.getAttribute("data-settings-anchor")).toBe(
        "host-overview-tab-data",
      );

      // No inline Activate button - it only exists inside the ⋯ menu on a
      // phone, so the name row never wraps.
      expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();

      await openHostOverviewMenu();
      expect(await screen.findByTestId("host-make-active")).not.toBeNull();
    });

    it("keeps a long name on one line with its pencil, its tag and the ⋯ menu", async () => {
      window.innerWidth = 500;
      await renderLongNamedHost();

      const row = screen.getByTestId("host-identity-name-row");
      // jsdom lays nothing out, so the line is asserted as the classes that
      // make it one: a row that cannot wrap, and a name that can shrink below
      // its text and truncates.
      expect(row.classList.contains("flex-wrap")).toBe(false);
      const name = within(row).getByRole("heading", { name: LONG_NAME });
      expect(name.classList.contains("min-w-0")).toBe(true);
      expect(name.classList.contains("truncate")).toBe(true);
      expect(within(row).getByTestId("host-overview-edit-name")).not.toBeNull();
      expect(within(row).getByText("Local")).not.toBeNull();
      // The ⋯ menu shares the row's line: the header's one flex line holds the
      // name row and the actions side by side.
      const line = row.parentElement;
      if (line === null) throw new Error("the name row sits in no line");
      expect(within(line).getByTestId("host-overview-menu")).not.toBeNull();
    });
  });

  it("wraps the name row on desktop, where the name has room for a second line", async () => {
    await renderLongNamedHost();

    expect(
      screen
        .getByTestId("host-identity-name-row")
        .classList.contains("flex-wrap"),
    ).toBe(true);
  });

  it("renders all five tab triggers under a connecting host", async () => {
    scopeOverrides.current = coldConnectingScope();
    renderPanel();

    for (const tab of HOST_OVERVIEW_TABS) {
      expect(
        await screen.findByTestId(`host-overview-tab-${tab}`),
      ).not.toBeNull();
    }
  });

  it("shows Status's loading shape under a cold connecting host, not an empty body", async () => {
    scopeOverrides.current = coldConnectingScope();
    renderPanel();

    const status = await screen.findByTestId("host-overview-status-tab");
    expect(
      within(status).getByTestId("host-scope-connecting").textContent,
    ).toContain("Connecting to host-a");
  });

  it("keeps retained update progress on Status while the host connects, in place of the loading shape", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: { "host.status": () => DOWNLOADING_STATUS },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const panel = renderPanelPersistent(null);
    expect(
      (await screen.findByTestId("host-overview-operation-phase")).textContent,
    ).toBe("Downloading update to v2.1.0");

    // Only the scope moves: the client, and so the query key, stay put, and
    // the read the host already answered is retained.
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture),
      status: "connecting",
    };
    panel.rerender();

    const status = screen.getByTestId("host-overview-status-tab");
    await waitFor(() => {
      expect(
        within(status).getByTestId("host-overview-operation-phase").textContent,
      ).toContain("Downloading update to v2.1.0");
    });
    expect(within(status).queryByTestId("host-scope-connecting")).toBeNull();
  });
});

/** Mounts the page for a ready local host whose name is {@link LONG_NAME}. */
async function renderLongNamedHost(): Promise<void> {
  const fixture = buildOverviewHostFixture({
    hostId: "host-a",
    isLocalMachine: true,
    effectiveName: LONG_NAME,
  });
  recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
  hostBindingMock.current = bindingWith(fixture.client);
  scopeOverrides.current = {
    ...scopeFrom("host-a", fixture),
    host: hostScopeOptionFixture({
      hostId: "host-a",
      name: LONG_NAME,
      isLocalMachine: true,
      connectable: true,
      isActive: true,
    }),
  };
  renderPanel();
  // The pencil is enabled once the host has answered with its name.
  await waitFor(() => {
    expect(
      screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
    ).toBe(false);
  });
}
