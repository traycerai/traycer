// Same boundary as the sibling Overview suites: mock `useHostScope` and
// `@/lib/host`'s `useHostBinding` rather than standing up a host runtime.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return { useHostScope: () => hostScopeFixture(scopeOverrides.current) };
});

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

// The scoped TRANSPORT, stubbed at the hook the panel re-provides from. The
// real one dials a transient socket; every assertion here is about which
// binding reaches the rows, not about how it was built.
const scopedStreamMock = vi.hoisted((): { current: unknown } => ({
  current: null,
}));
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => scopedStreamMock.current,
}));

// A host RPC, faked like every other network boundary in these suites. What the
// import row does with a cold status answer is the wizard suite's subject.
vi.mock("@/hooks/session-import/use-session-import-status-query", () => ({
  useSessionImportStatus: () => ({ data: undefined }),
}));

const migrationStart = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/components/migration/migration-run-handle", () => ({
  startMigrationRun: (binding: unknown) => {
    migrationStart.fn(binding);
  },
  isMigrationRunStartReady: () => true,
  setMigrationStartHandle: () => undefined,
  getMigrationStartHandle: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { buildOverviewHostFixture } from "@/components/settings/panels/__tests__/host-overview-test-support";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import {
  useMigrationRunStore,
  type MigrationRunState,
} from "@/stores/migration/migration-run-store";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

/**
 * Data & migration moved off General and onto the Overview of the host it
 * acts on, because both rows move ONE MACHINE'S local data and General names no
 * machine.
 *
 * The rows ride the STREAM transport, not the unary one, so this suite's real
 * subject is the second re-provision `HostSettingsPanel` now performs: the
 * binding the rows read has to be the PICKED host's, and the run handle has to
 * receive that same object. The scope here is an explicit non-following pick
 * (host-b) with the ambient window on host-a, which is the only arrangement
 * where a wrong answer is visible at all.
 */

const PICKED_HOST = "host-b";
const AMBIENT_HOST = "host-a";

const ALL_OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.getInstallationInfo",
  "host.doctor",
  "host.update.check",
] as const;

const INITIAL_COUNTS = {
  taskChainsComplete: 0,
  taskChainsSkipped: 0,
  taskChainsFailed: 0,
  epicsComplete: 0,
  epicsFailed: 0,
  replaysIncomplete: 0,
};

const runningState: MigrationRunState = {
  status: "running",
  totals: { totalTaskChains: 7, totalLocalEpics: 3 },
  counts: { ...INITIAL_COUNTS, taskChainsComplete: 2 },
  finalSuccess: null,
};

/**
 * A stream binding standing in for a resolved scoped transport. Nothing calls
 * through the client: what every assertion below turns on is WHICH host the
 * binding names and whether that exact object reaches the run handle.
 */
function fakeStreamBinding(input: {
  readonly hostId: string;
  readonly scanSupport: StreamMethodSupport;
}): StreamRuntimeBinding {
  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe: () => {
      throw new Error("not exercised by this test");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => undefined,
    isClosed: () => false,
    isReady: () => false,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => input.scanSupport,
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: `fake-stream-${input.hostId}`,
  };
  return { wsStreamClient: client, hostId: input.hostId, retain: null };
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

/** Ambient window on host-a, Overview explicitly picked to host-b. */
function arrangePickedHost(): void {
  const ambient = buildOverviewHostFixture({
    hostId: AMBIENT_HOST,
    isLocalMachine: true,
    effectiveName: "Ambient Mac",
  });
  const picked = buildOverviewHostFixture({
    hostId: PICKED_HOST,
    isLocalMachine: false,
    effectiveName: "Office Linux",
  });
  recordNegotiatedHostMethods(AMBIENT_HOST, ALL_OVERVIEW_METHODS);
  recordNegotiatedHostMethods(PICKED_HOST, ALL_OVERVIEW_METHODS);
  hostBindingMock.current = { hostClient: ambient.client };
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: PICKED_HOST,
      name: "Office Linux",
      isLocalMachine: false,
      connectable: true,
    }),
    hostId: PICKED_HOST,
    hostLabel: "Office Linux",
    status: "ready",
    client: picked.client,
    isViewingActive: false,
    activeHostId: AMBIENT_HOST,
  };
}

function renderPanel(): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <RunnerHostProvider runnerHost={makeRunnerHost()}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function isBefore(first: Element, second: Element): boolean {
  return (
    (first.compareDocumentPosition(second) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
    0
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useMigrationRunStore.setState({ runs: new Map(), remoteRunning: false });
  useSessionImportRunStore.setState({ runs: new Map() });
  scopedStreamMock.current = fakeStreamBinding({
    hostId: PICKED_HOST,
    scanSupport: "unknown",
  });
  arrangePickedHost();
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  scopedStreamMock.current = null;
});

describe("Host Overview · Data & migration", () => {
  it("renders both rows in a group sitting after Installation", () => {
    renderPanel();

    const group = screen.getByTestId("host-import-migration");
    expect(screen.getByTestId("settings-import-sessions")).toBeTruthy();
    expect(screen.getByTestId("settings-reattempt-migration")).toBeTruthy();
    expect(isBefore(screen.getByTestId("host-installation"), group)).toBe(true);
  });

  it("hands the picked host's own stream binding to the migration run", () => {
    renderPanel();

    fireEvent.click(screen.getByTestId("settings-reattempt-migration"));

    // The exact object, not an equal one: the transport, the host name and the
    // transport lease travel together, and the ambient window is on host-a.
    expect(migrationStart.fn).toHaveBeenCalledTimes(1);
    expect(migrationStart.fn.mock.calls[0]?.[0]).toBe(scopedStreamMock.current);
  });

  it("reports progress for this host's run and ignores another host's", () => {
    useMigrationRunStore.setState({
      runs: new Map([
        [PICKED_HOST, runningState],
        [
          AMBIENT_HOST,
          {
            ...runningState,
            totals: { totalTaskChains: 99, totalLocalEpics: 99 },
          },
        ],
      ]),
      remoteRunning: false,
    });

    renderPanel();

    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Re-attempt migration",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByTestId("settings-reattempt-migration-spinner"),
    ).toBeTruthy();
    expect(
      screen.getByText("Migrating tasks - tasks 2/7, epics 0/3"),
    ).toBeTruthy();
  });

  // A submitted run is active before the host has said how big it is, and the
  // row must not report a size it does not have yet.
  it("says the import is starting until the host confirms a total, then counts", () => {
    useSessionImportRunStore.getState().markStarting(PICKED_HOST, new Map());

    renderPanel();

    expect(screen.getByText("Starting import…")).toBeTruthy();
    expect(screen.queryByText("Importing 0 of 0…")).toBeNull();
    // Same run, same spinner - only the sentence was waiting on the total.
    expect(screen.getByTestId("settings-import-sessions-spinner")).toBeTruthy();

    cleanup();
    useSessionImportRunStore
      .getState()
      .applyStarted(PICKED_HOST, { runId: "run-1", total: 3, attached: false });

    renderPanel();

    expect(screen.getByText("Importing 0 of 3…")).toBeTruthy();
  });

  // The whole group goes, not just its contents: an empty titled card reads as
  // a page that failed to load.
  it("withholds the group while the stream still names another host", () => {
    // What a resolving pick looks like for a commit or two: the provider has
    // fallen back to the ambient stream, which is still dialing host-a.
    scopedStreamMock.current = fakeStreamBinding({
      hostId: AMBIENT_HOST,
      scanSupport: "unknown",
    });

    renderPanel();

    expect(screen.queryByTestId("host-import-migration")).toBeNull();
    expect(screen.queryByTestId("settings-reattempt-migration")).toBeNull();
    // The rest of the page is unaffected - this is a withheld group, not a
    // withheld panel.
    expect(screen.getByTestId("host-installation")).toBeTruthy();
  });

  it("withholds the group while no stream has resolved at all", () => {
    scopedStreamMock.current = null;

    renderPanel();

    expect(screen.queryByTestId("host-import-migration")).toBeNull();
  });

  it("drops only the import row on a host that never negotiated the scan", () => {
    scopedStreamMock.current = fakeStreamBinding({
      hostId: PICKED_HOST,
      scanSupport: "unsupported",
    });

    renderPanel();

    expect(screen.queryByTestId("settings-import-sessions")).toBeNull();
    expect(screen.getByTestId("settings-reattempt-migration")).toBeTruthy();
  });
});
