// Boundary mocks mirroring the sibling Overview suites (doctor-fixes,
// operation-card): this suite is about the "foreground run" degrade across
// four Overview surfaces, not host scope resolution or streaming.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

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
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
    readonly getLocalEntry: () => null;
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostLifecyclePending,
  HostLifecycleRunAdmission,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IHostManagement,
  LocalHostCapability,
} from "@traycer-clients/shared/platform/runner-host";
import type {
  HostAvailableManifest,
  HostDoctorIssue,
  HostGetInstallationInfoResponseV11,
} from "@traycer/protocol/host/maintenance/index";
import type { HostStatusUpdateOperationV2 } from "@traycer/protocol/host/status/index";
import type {
  HostInstallRecord,
  HostStagedRecord,
} from "@traycer/protocol/config/installation-records";
import type { HostRpcRegistry } from "@/lib/host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  resetHostServiceWriteLatchesForTest,
  useHostServiceWriteLatchStore,
} from "@/components/settings/panels/host-service-write-latch-store";
import * as latchStoreModule from "@/components/settings/panels/host-service-write-latch-store";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  HOST_FOREGROUND_RESTART_REASON,
  HOST_FOREGROUND_UPDATE_READY,
} from "@/lib/host/host-lifecycle-copy";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
  openHostOverviewMenu,
  selectHostOverviewTab,
  updateCheckManifest,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

const RESTART_REASON = HOST_FOREGROUND_RESTART_REASON;
const FOREGROUND_UPDATE_SENTENCE = HOST_FOREGROUND_UPDATE_READY;

const OVERVIEW_METHODS = [
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

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  resetHostServiceWriteLatchesForTest();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

const MANAGED_IDLE = { capability: "managed", pending: "none" } as const;

function lifecycleView(
  admittedAs: HostLifecycleRunAdmission | null,
  applied: {
    readonly capability: LocalHostCapability;
    readonly pending: HostLifecyclePending;
  },
): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: applied.capability,
      supervisor: admittedAs === null ? "not-running" : "enforcing",
      admittedAs,
    },
    pending: applied.pending,
  };
}

function buildLifecycleHost(initial: HostLifecycleView): IHostLifecycleHost {
  return {
    get: () => Promise.resolve(initial),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: initial,
      } satisfies HostLifecycleSetResult),
    onChange: () => ({ dispose: () => undefined }),
    quit: null,
  };
}

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
      getLocalEntry: () => null,
    },
  };
}

function renderOverview(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly admittedAs: HostLifecycleRunAdmission | null;
  readonly hostVersion?: string;
  readonly installation?: HostGetInstallationInfoResponseV11;
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
  readonly management?: IHostManagement | null;
}): {
  readonly fixture: OverviewHostFixture;
  readonly queryClient: QueryClient;
} {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
    hostVersion: options.hostVersion,
    installation: options.installation,
    overrideHandlers: options.overrideHandlers,
  });
  recordNegotiatedHostMethods(options.hostId, OVERVIEW_METHODS);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);
  const runnerHost = createFakeRunnerHost({
    hostLifecycle: buildLifecycleHost(
      lifecycleView(options.admittedAs, MANAGED_IDLE),
    ),
    hostManagement: options.management ?? null,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { fixture, queryClient };
}

// ---------------------------------------------------------------------------
// The header "..." menu's Restart item
// ---------------------------------------------------------------------------

describe("the header menu's Restart during a foreground run", () => {
  it("RED: degrades Restart and dispatches nothing on the local host", async () => {
    const { fixture } = renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
    });

    await openHostOverviewMenu();

    // Positive assertion via `waitFor` first — this can only become true once
    // the lifecycle query has actually resolved, so it doubles as the settle
    // point for everything checked synchronously right after it.
    await waitFor(() => {
      expect(
        screen
          .getByTestId("host-overview-restart")
          .getAttribute("data-degraded"),
      ).toBe("terminal-run");
    });
    const item = screen.getByTestId("host-overview-restart");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(RESTART_REASON);

    fireEvent.click(item);
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(fixture.restartCalls()).toBe(0);
  });

  it("GREEN control: admittedAs null — no data-degraded, and selecting opens the confirm", async () => {
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: null,
    });

    await openHostOverviewMenu();
    const item = await screen.findByTestId("host-overview-restart");
    expect(item.getAttribute("data-degraded")).toBeNull();

    fireEvent.click(item);
    await screen.findByTestId("confirm-destructive-dialog");
  });

  it("GREEN control: a remote host stays undegraded even though THIS machine is foreground", async () => {
    renderOverview({
      hostId: "host-remote",
      isLocalMachine: false,
      admittedAs: "foreground",
    });

    await openHostOverviewMenu();
    const item = await screen.findByTestId("host-overview-restart");
    // No positive signal to settle on here (the remote host never degrades),
    // so wait for the menu's OTHER item (Run doctor) to be present, which
    // mounts from the same render pass, before reading the negative.
    await screen.findByTestId("host-overview-run-doctor");
    expect(item.getAttribute("data-degraded")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The answer card's "Update now"
// ---------------------------------------------------------------------------

function updatableManifestHandlers(): MockHandlerMap<HostRpcRegistry> {
  return {
    "host.update.check": () => ({
      outcome: "ok" as const,
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: updateCheckManifest("1.6.0"),
    }),
  };
}

/**
 * A catalog whose only (newer) version is yanked: the answer is
 * `not-installable` — a card with a sentence and nothing to install.
 */
function unofferableManifestHandlers(): MockHandlerMap<HostRpcRegistry> {
  const manifest = updateCheckManifest("1.6.0");
  return {
    "host.update.check": () => ({
      outcome: "ok" as const,
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: {
        ...manifest,
        versions: manifest.versions.map((entry) => ({
          ...entry,
          yanked: true,
        })),
      },
    }),
  };
}

describe("the answer card's Update now during a foreground run", () => {
  it("RED: hides Update now and shows the foreground reason when a newer version exists", async () => {
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      hostVersion: "1.5.0",
      overrideHandlers: updatableManifestHandlers(),
    });
    await selectHostOverviewTab("updates");

    // Positive first: only true once the update-check + lifecycle queries
    // have both resolved, which settles the render for the negative below.
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-update-foreground").textContent,
      ).toBe(FOREGROUND_UPDATE_SENTENCE);
    });
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
  });

  it("GREEN control: admittedAs null — Update now present and no reason", async () => {
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: null,
      hostVersion: "1.5.0",
      overrideHandlers: updatableManifestHandlers(),
    });
    await selectHostOverviewTab("updates");

    await screen.findByTestId("host-overview-update-now");
    expect(screen.queryByTestId("host-overview-update-foreground")).toBeNull();
  });

  it("GREEN control: foreground with nothing to install — the card draws, but no reason and no Update now", async () => {
    // A card that DRAWS with nothing to install: the one newer version in the
    // catalog is yanked, so the answer is `not-installable`. That reaches the
    // foreground sentence's own guard (`updatableVersion !== null`), which a
    // current host never does (its card is null before getting there).
    const { queryClient } = renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      hostVersion: "1.5.0",
      overrideHandlers: unofferableManifestHandlers(),
    });

    await screen.findByTestId("host-identity-name-row");
    await selectHostOverviewTab("updates");
    // The card is the positive to settle on; then wait for every query this
    // render started (the lifecycle read that feeds the foreground sentence
    // included) to finish before asserting the negatives.
    const card = await screen.findByTestId("host-overview-answer-card");
    expect(card.getAttribute("data-answer")).toBe("not-installable");
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByTestId("host-overview-update-foreground")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
  });

  it("GREEN control: foreground with no newer version — no card and no reason anywhere", async () => {
    const { queryClient } = renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      hostVersion: "1.5.0",
      // No override: the fixture's default `host.update.check` answers with
      // `latest === hostVersion`, i.e. nothing to offer.
    });

    // Nothing here is expected to ever appear, so the one positive to settle
    // on is the version list's empty state, which reads only once the check
    // has answered (the fixture's manifest lists no versions) — then wait for
    // every query this render started to finish, and assert the negatives.
    await screen.findByTestId("host-identity-name-row");
    await selectHostOverviewTab("updates");
    await screen.findByText("No versions available.");
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByTestId("host-overview-update-foreground")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
    // A current host has no answer to give: the card draws nothing at all.
    expect(screen.queryByTestId("host-overview-answer-card")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The operation card's update-finishing controls
// ---------------------------------------------------------------------------

function activationDebtInstallation(): HostGetInstallationInfoResponseV11 {
  const install: HostInstallRecord = {
    installId: "install-1",
    version: "1.3.0-rc.3",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-08-10T00:00:00Z",
    source: { kind: "registry", value: "1.3.0-rc.3" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-08-10T00:00:00Z",
    signatureKeyId: "key-1",
    sizeBytes: 1024,
    executablePath: "/tmp/traycer/1.3.0-rc.3/host",
    executableSha256: "b".repeat(64),
  };
  return {
    status: "managed",
    installRecord: install,
    stagedRecord: null,
    cliManifest: null,
  };
}

function activationDebtStatusHandler(): MockHandlerMap<HostRpcRegistry> {
  const operation: HostStatusUpdateOperationV2 = { kind: "none" };
  return {
    "host.status": () => ({
      ready: true,
      hostVersion: "1.3.0-rc.2",
      protocolVersion: { major: 1, minor: 3 },
      busy: false,
      busySessionCount: 0,
      updateProgress: null,
      busyBreakdown: null,
      updateOperation: operation,
      updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
      storeFormats: null,
      install: null,
    }),
  };
}

describe("the operation card's update-finishing controls during a foreground run", () => {
  it("RED: withdraws Restart/force controls and shows the foreground reason", async () => {
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      hostVersion: "1.3.0-rc.2",
      installation: activationDebtInstallation(),
      overrideHandlers: activationDebtStatusHandler(),
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-foreground").textContent,
      ).toBe(FOREGROUND_UPDATE_SENTENCE);
    });
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();
  });

  it("GREEN control: admittedAs null — Restart is present", async () => {
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: null,
      hostVersion: "1.3.0-rc.2",
      installation: activationDebtInstallation(),
      overrideHandlers: activationDebtStatusHandler(),
    });

    await screen.findByTestId("host-overview-operation-restart");
  });
});

// ---------------------------------------------------------------------------
// The Doctor sheet's restart fixes
// ---------------------------------------------------------------------------

const CLI_UPGRADE_PENDING: HostDoctorIssue = {
  code: "CLI_UPGRADE_PENDING",
  severity: "warning",
  title: "CLI upgrade pending (2.0.0)",
  message: "Restart the host service to finalise the swap.",
  fixAction: "host-restart",
  terminalCommand: "traycer host restart --channel prod",
  details: null,
};

const FREE_PORT_ISSUE: HostDoctorIssue = {
  code: "PORT_CONFLICT",
  severity: "error",
  title: "Port 8765 is in use",
  message: "Another process is holding the host's configured port.",
  fixAction: "host-free-port-and-restart",
  terminalCommand: "traycer host restart --free-port 8765",
  details: { port: 8765, conflictingPid: 4242, conflictingProcess: "node" },
};

const RECENT_CRASH_MARKERS: HostDoctorIssue = {
  code: "RECENT_CRASH_MARKERS",
  severity: "warning",
  title: "Recent crash markers",
  message: "The host log contains recent crash markers.",
  fixAction: "host-logs",
  terminalCommand: null,
  details: null,
};

function doctorHandlerFor(
  issue: HostDoctorIssue,
): MockHandlerMap<HostRpcRegistry> {
  return {
    "host.doctor": () => ({
      status: "ok" as const,
      issues: [issue],
      triviallyGreenIssueCodes: [],
    }),
  };
}

async function openDoctorSheet(): Promise<void> {
  await openHostOverviewMenu();
  fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
}

function describedReasonText(button: HTMLElement): string | null {
  const describedBy = button.getAttribute("aria-describedby");
  if (describedBy === null) return null;
  const reasonEl = document.getElementById(describedBy);
  return reasonEl?.textContent ?? null;
}

describe("the Doctor sheet's restart fixes during a foreground run", () => {
  it("RED: a host-restart fix is disabled, reasoned, and dispatches nothing", async () => {
    const management = buildOverviewManagement({});
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      management,
      overrideHandlers: doctorHandlerFor(CLI_UPGRADE_PENDING),
    });
    await openDoctorSheet();

    await waitFor(() => {
      const button = screen.getByTestId(
        `host-doctor-fix-${CLI_UPGRADE_PENDING.code}`,
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
    const button = screen.getByTestId(
      `host-doctor-fix-${CLI_UPGRADE_PENDING.code}`,
    ) as HTMLButtonElement;
    expect(describedReasonText(button)).toBe(RESTART_REASON);

    fireEvent.click(button);
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(management.restartHost).not.toHaveBeenCalled();
  });

  it("RED: a host-free-port-and-restart fix is disabled, reasoned, and dispatches nothing", async () => {
    const management = buildOverviewManagement({});
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      management,
      overrideHandlers: doctorHandlerFor(FREE_PORT_ISSUE),
    });
    await openDoctorSheet();

    await waitFor(() => {
      const button = screen.getByTestId(
        `host-doctor-fix-${FREE_PORT_ISSUE.code}`,
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
    const button = screen.getByTestId(
      `host-doctor-fix-${FREE_PORT_ISSUE.code}`,
    ) as HTMLButtonElement;
    expect(describedReasonText(button)).toBe(RESTART_REASON);

    fireEvent.click(button);
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(management.freePortAndRestartIfIdle).not.toHaveBeenCalled();
  });

  it("GREEN control: a non-restart fix (Show logs) stays enabled with no reason", async () => {
    const management = buildOverviewManagement({});
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      management,
      overrideHandlers: doctorHandlerFor(RECENT_CRASH_MARKERS),
    });
    await openDoctorSheet();

    const button = (await screen.findByTestId(
      `host-doctor-fix-${RECENT_CRASH_MARKERS.code}`,
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(describedReasonText(button)).toBeNull();
  });

  it("GREEN control: admittedAs null — the restart fix is enabled", async () => {
    const management = buildOverviewManagement({});
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: null,
      management,
      overrideHandlers: doctorHandlerFor(CLI_UPGRADE_PENDING),
    });
    await openDoctorSheet();

    const button = (await screen.findByTestId(
      `host-doctor-fix-${CLI_UPGRADE_PENDING.code}`,
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A bridge-route restart confirm arms at OPEN and is not closed by
// `restartDegrade` (host-overview-panel.tsx:1288-1294 closes only the
// COOPERATIVE route) - so a foreground run starting while it is open leaves
// it answerable, and Confirm still dispatches the bridge respawn.
// ---------------------------------------------------------------------------

function renderBridgeRouteOverview(): {
  readonly management: IHostManagement;
  readonly restartHostIfIdle: Mock<IHostManagement["restartHostIfIdle"]>;
  readonly pushLifecycleView: (view: HostLifecycleView) => void;
} {
  const hostId = "host-local";
  const restartHostIfIdle = vi.fn(() =>
    Promise.resolve({ kind: "restarted" as const }),
  );
  const management = buildOverviewManagement({ restartHostIfIdle });
  const fixture = buildOverviewHostFixture({ hostId, isLocalMachine: true });
  // No "host.restart" in the negotiated manifest: `restartSupport === false`
  // plus a bridge (`management !== null`) is exactly `restartViaForceFallback`
  // (`host-overview-panel.tsx:2780-2781`), so Restart routes to the bridge and
  // the confirm opens directly - no busy/force-defer detour needed.
  recordNegotiatedHostMethods(
    hostId,
    OVERVIEW_METHODS.filter((method) => method !== "host.restart"),
  );
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: true,
      connectable: true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);

  const changeHandlers: Array<(view: HostLifecycleView) => void> = [];
  const hostLifecycle: IHostLifecycleHost = {
    get: () => Promise.resolve(lifecycleView(null, MANAGED_IDLE)),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: lifecycleView(null, MANAGED_IDLE),
      } satisfies HostLifecycleSetResult),
    onChange: (handler) => {
      changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    quit: null,
  };
  const runnerHost = createFakeRunnerHost({
    hostLifecycle,
    hostManagement: management,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return {
    management,
    restartHostIfIdle,
    pushLifecycleView: (view) => {
      for (const handler of changeHandlers) handler(view);
    },
  };
}

describe("a bridge-route restart confirm during a foreground run", () => {
  it("RED: closes the open confirm and dispatches nothing once a foreground run starts under it", async () => {
    const { restartHostIfIdle, pushLifecycleView } =
      renderBridgeRouteOverview();

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-restart"));
    await screen.findByTestId("confirm-destructive-dialog");
    expect(restartHostIfIdle).not.toHaveBeenCalled();

    act(() => {
      pushLifecycleView(lifecycleView("foreground", MANAGED_IDLE));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(restartHostIfIdle).not.toHaveBeenCalled();

    // Same-test sanity check: the header item now reflects the same fact. The
    // menu closed when Restart was chosen, so it is reopened to read it.
    await openHostOverviewMenu();
    await waitFor(() => {
      expect(
        screen
          .getByTestId("host-overview-restart")
          .getAttribute("data-degraded"),
      ).toBe("terminal-run");
    });
  });

  it("GREEN control: without the push, the confirm stays open and Confirm dispatches the respawn once", async () => {
    const { restartHostIfIdle } = renderBridgeRouteOverview();

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-restart"));
    await screen.findByTestId("confirm-destructive-dialog");

    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(restartHostIfIdle).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The three busy/force/defer offers (`HostBusyForceDeferDialog`,
// testid `host-busy-force-defer-dialog`, `data-purpose` "restart" | "update")
// - each opens from live work a click discovered, arms independently of the
// restart confirm above, and is never re-checked against a foreground run
// that starts while it sits open.
// ---------------------------------------------------------------------------

function renderPushableOverview(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly hostVersion?: string;
  readonly installation?: HostGetInstallationInfoResponseV11;
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
  readonly management?: IHostManagement | null;
  readonly negotiatedMethods: readonly string[];
  /** What the lifecycle query answers with BEFORE any `pushLifecycleView`. */
  readonly initialAdmittedAs: HostLifecycleRunAdmission | null;
}): {
  readonly fixture: OverviewHostFixture;
  readonly queryClient: QueryClient;
  readonly pushLifecycleView: (view: HostLifecycleView) => void;
} {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
    hostVersion: options.hostVersion,
    installation: options.installation,
    overrideHandlers: options.overrideHandlers,
  });
  recordNegotiatedHostMethods(options.hostId, options.negotiatedMethods);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);

  const initialView = lifecycleView(options.initialAdmittedAs, MANAGED_IDLE);
  const changeHandlers: Array<(view: HostLifecycleView) => void> = [];
  const hostLifecycle: IHostLifecycleHost = {
    get: () => Promise.resolve(initialView),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: initialView,
      } satisfies HostLifecycleSetResult),
    onChange: (handler) => {
      changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    quit: null,
  };
  const runnerHost = createFakeRunnerHost({
    hostLifecycle,
    hostManagement: options.management ?? null,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return {
    fixture,
    queryClient,
    pushLifecycleView: (view) => {
      for (const handler of changeHandlers) handler(view);
    },
  };
}

function installRecord(
  version: string,
  runtimeVersion: string | null,
): HostInstallRecord {
  return {
    installId: "install-1",
    version,
    runtimeVersion,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-08-10T00:00:00Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-08-10T00:00:00Z",
    signatureKeyId: "key-1",
    sizeBytes: 1024,
    executablePath: `/tmp/traycer/${version}/host`,
    executableSha256: "b".repeat(64),
  };
}

function stagedRecord(version: string): HostStagedRecord {
  return {
    schemaVersion: 1,
    stageId: null,
    version,
    runtimeVersion: null,
    archiveSha256: "a".repeat(64),
    sizeBytes: 1024,
    source: { kind: "registry", value: version },
    signatureKeyId: "key-1",
    signatureVerifiedAt: "2026-08-10T00:00:00Z",
    executablePath: `/tmp/traycer/${version}/host`,
    platform: "darwin",
    arch: "arm64",
    executableSha256: "b".repeat(64),
  };
}

function managedInstallation(
  install: HostInstallRecord,
  staged: HostStagedRecord | null,
): HostGetInstallationInfoResponseV11 {
  return {
    status: "managed",
    installRecord: install,
    stagedRecord: staged,
    cliManifest: null,
  };
}

function statusWithBusy(
  hostVersion: string,
  operation: HostStatusUpdateOperationV2,
  busy: boolean,
  busySessionCount: number,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion,
    protocolVersion: { major: 1, minor: 3 },
    busy,
    busySessionCount,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: operation,
    updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
    storeFormats: null,
    install: null,
  };
}

function attemptOperation(
  overrides: Partial<Extract<HostStatusUpdateOperationV2, { kind: "attempt" }>>,
): HostStatusUpdateOperationV2 {
  return {
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
    ...overrides,
  };
}

function parkStatus(
  targetVersion: string,
  busySessionCount: number,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return statusWithBusy(
    "1.3.0-rc.2",
    attemptOperation({
      phase: "waiting-for-work",
      execution: "active",
      liveness: "active",
      targetVersion,
      busySessionCount,
    }),
    busySessionCount > 0,
    busySessionCount,
  );
}

function clearStagedManifest(version: string): HostAvailableManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-06T00:00:00Z",
    latest: version,
    versions: [
      {
        version,
        releasedAt: "2026-09-06T00:00:00Z",
        releaseNotesUrl: "https://example.invalid/notes",
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        platforms: {
          "darwin-arm64": {
            available: true,
            unavailableReason: null,
            url: "https://example.invalid/host.tar.gz",
            sizeBytes: 1024,
            sha256: "a".repeat(64),
            signatureUrl: "https://example.invalid/host.tar.gz.minisig",
            signatureAlgorithm: "minisign",
            publicKeyId: "key-1",
          },
        },
      },
    ],
  };
}

function floorStagedManifest(version: string): HostAvailableManifest {
  const manifest = clearStagedManifest(version);
  return {
    ...manifest,
    versions: manifest.versions.map((entry) => ({
      ...entry,
      requiredCliVersion: "1.3.0",
      platforms: {
        "darwin-arm64": {
          ...entry.platforms["darwin-arm64"],
          available: false,
          unavailableReason:
            "Needs Traycer CLI 1.3.0 or newer (this host's CLI is 1.2.0).",
        },
      },
    })),
  };
}

describe("the busy verdict's Force restart during a foreground run", () => {
  function busyRestartHandlers(): MockHandlerMap<HostRpcRegistry> {
    return {
      "host.restart": () =>
        Promise.resolve({
          outcome: "busy" as const,
          verdict: { busySessionCount: 2, blockers: null, busyBreakdown: null },
        }),
    };
  }

  it("RED: closes the offer and dispatches nothing once foreground starts under it", async () => {
    const restartHostIfIdle: Mock<IHostManagement["restartHostIfIdle"]> = vi.fn(
      () => Promise.resolve({ kind: "restarted" as const }),
    );
    const management = buildOverviewManagement({ restartHostIfIdle });
    const { pushLifecycleView } = renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      management,
      negotiatedMethods: OVERVIEW_METHODS,
      initialAdmittedAs: null,
      overrideHandlers: busyRestartHandlers(),
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-restart"));
    fireEvent.click(await screen.findByTestId("confirm-action"));

    const offer = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(offer.getAttribute("data-purpose")).toBe("restart");
    expect(restartHostIfIdle).not.toHaveBeenCalled();

    act(() => {
      pushLifecycleView(lifecycleView("foreground", MANAGED_IDLE));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    expect(restartHostIfIdle).not.toHaveBeenCalled();
  });

  it("GREEN control: without the push, Force restart calls restartHostIfIdle once", async () => {
    const restartHostIfIdle: Mock<IHostManagement["restartHostIfIdle"]> = vi.fn(
      () => Promise.resolve({ kind: "restarted" as const }),
    );
    const management = buildOverviewManagement({ restartHostIfIdle });
    renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      management,
      negotiatedMethods: OVERVIEW_METHODS,
      initialAdmittedAs: null,
      overrideHandlers: busyRestartHandlers(),
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-restart"));
    fireEvent.click(await screen.findByTestId("confirm-action"));
    await screen.findByTestId("host-busy-force-defer-dialog");

    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(restartHostIfIdle).toHaveBeenCalledTimes(1);
    });
  });
});

describe("the staged-wait Force update… offer during a foreground run", () => {
  function stagedWaitOptions(
    installCalls: Array<{ readonly version: string; readonly force: boolean }>,
  ): {
    readonly installation: HostGetInstallationInfoResponseV11;
    readonly overrideHandlers: MockHandlerMap<HostRpcRegistry>;
  } {
    return {
      installation: managedInstallation(
        installRecord("1.3.0-rc.2", "1.3.0-rc.2"),
        stagedRecord("1.3.0-rc.3"),
      ),
      overrideHandlers: {
        "host.status": () =>
          statusWithBusy("1.3.0-rc.2", { kind: "none" }, true, 2),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          manifest: clearStagedManifest("1.3.0-rc.3"),
        }),
        "host.update.install": (req) => {
          installCalls.push({ version: req.version, force: req.force });
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    };
  }

  it("RED: closes the offer and sends no install once foreground starts under it", async () => {
    const installCalls: Array<{ version: string; force: boolean }> = [];
    const { installation, overrideHandlers } = stagedWaitOptions(installCalls);
    const { pushLifecycleView } = renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation,
      negotiatedMethods: OVERVIEW_METHODS,
      initialAdmittedAs: null,
      overrideHandlers,
    });

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    const offer = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(offer.getAttribute("data-purpose")).toBe("update");

    act(() => {
      pushLifecycleView(lifecycleView("foreground", MANAGED_IDLE));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    expect(installCalls).toEqual([]);
  });

  it("GREEN control: without the push, confirming sends host.update.install with force:true once", async () => {
    const installCalls: Array<{ version: string; force: boolean }> = [];
    const { installation, overrideHandlers } = stagedWaitOptions(installCalls);
    renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation,
      negotiatedMethods: OVERVIEW_METHODS,
      initialAdmittedAs: null,
      overrideHandlers,
    });

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      expect(installCalls).toEqual([{ version: "1.3.0-rc.3", force: true }]);
    });
  });
});

describe("the bound-dispatch offer during a foreground run", () => {
  function boundParkOptions(
    continueCalls: Array<{
      readonly attemptId: string;
      readonly force: boolean;
    }>,
  ): {
    readonly installation: HostGetInstallationInfoResponseV11;
    readonly overrideHandlers: MockHandlerMap<HostRpcRegistry>;
    readonly negotiatedMethods: readonly string[];
  } {
    return {
      installation: managedInstallation(
        installRecord("1.3.0-rc.2", "1.3.0-rc.2"),
        stagedRecord("1.3.0-rc.3"),
      ),
      negotiatedMethods: [...OVERVIEW_METHODS, "host.update.continue"],
      overrideHandlers: {
        "host.status": () => parkStatus("1.3.0-rc.3", 2),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          manifest: floorStagedManifest("1.3.0-rc.3"),
        }),
        "host.update.continue": (req) => {
          continueCalls.push({ attemptId: req.attemptId, force: req.force });
          return { outcome: "accepted" as const, attemptId: req.attemptId };
        },
      },
    };
  }

  it("RED: closes the offer and sends nothing once foreground starts under it", async () => {
    const continueCalls: Array<{ attemptId: string; force: boolean }> = [];
    const { installation, overrideHandlers, negotiatedMethods } =
      boundParkOptions(continueCalls);
    const { pushLifecycleView } = renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation,
      negotiatedMethods,
      initialAdmittedAs: null,
      overrideHandlers,
    });

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    const offer = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(offer.getAttribute("data-purpose")).toBe("update");

    act(() => {
      pushLifecycleView(lifecycleView("foreground", MANAGED_IDLE));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    expect(continueCalls).toEqual([]);
  });

  it("GREEN control: without the push, Force sends host.update.continue once", async () => {
    const continueCalls: Array<{ attemptId: string; force: boolean }> = [];
    const { installation, overrideHandlers, negotiatedMethods } =
      boundParkOptions(continueCalls);
    renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation,
      negotiatedMethods,
      initialAdmittedAs: null,
      overrideHandlers,
    });

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      expect(continueCalls.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The foreground-sentence ruling (Overview half): it only holds when
// `applied.localHostCapability === "managed"` AND `pending !== "restart-app"`.
// Otherwise, during a foreground run, both surfaces must show this sentence
// instead — no constant exists yet, so the literal is asserted directly.
// ---------------------------------------------------------------------------

const FOREGROUND_UPDATE_SELF =
  "Update ready. A host you started in a terminal is running; update it yourself.";

function renderForegroundOverview(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly hostVersion?: string;
  readonly installation?: HostGetInstallationInfoResponseV11;
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
  readonly applied: {
    readonly capability: LocalHostCapability;
    readonly pending: HostLifecyclePending;
  };
}): {
  readonly fixture: OverviewHostFixture;
  readonly queryClient: QueryClient;
} {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
    hostVersion: options.hostVersion,
    installation: options.installation,
    overrideHandlers: options.overrideHandlers,
  });
  recordNegotiatedHostMethods(options.hostId, OVERVIEW_METHODS);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);
  const runnerHost = createFakeRunnerHost({
    hostLifecycle: buildLifecycleHost(
      lifecycleView("foreground", options.applied),
    ),
    hostManagement: null,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { fixture, queryClient };
}

describe("the answer card's Update now under the foreground-sentence ruling", () => {
  it("RED: capability none — the self-update sentence, not the foreground-update one, and Update now absent", async () => {
    renderForegroundOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: updatableManifestHandlers(),
      applied: { capability: "none", pending: "none" },
    });
    await selectHostOverviewTab("updates");

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-update-foreground").textContent,
      ).toBe(FOREGROUND_UPDATE_SELF);
    });
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
  });

  it("RED: managed but pending restart-app — the self-update sentence, not the foreground-update one", async () => {
    renderForegroundOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: updatableManifestHandlers(),
      applied: { capability: "managed", pending: "restart-app" },
    });
    await selectHostOverviewTab("updates");

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-update-foreground").textContent,
      ).toBe(FOREGROUND_UPDATE_SELF);
    });
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
  });

  it("GREEN control: managed and pending none — the foreground-update sentence", async () => {
    renderForegroundOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: updatableManifestHandlers(),
      applied: MANAGED_IDLE,
    });
    await selectHostOverviewTab("updates");

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-update-foreground").textContent,
      ).toBe(FOREGROUND_UPDATE_SENTENCE);
    });
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
  });
});

describe("the operation card's finishing line under the foreground-sentence ruling", () => {
  it("RED: capability none — the self-update sentence, controls still absent", async () => {
    renderForegroundOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: activationDebtInstallation(),
      overrideHandlers: activationDebtStatusHandler(),
      applied: { capability: "none", pending: "none" },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-foreground").textContent,
      ).toBe(FOREGROUND_UPDATE_SELF);
    });
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();
  });

  it("RED: managed but pending restart-app — the self-update sentence, controls still absent", async () => {
    renderForegroundOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: activationDebtInstallation(),
      overrideHandlers: activationDebtStatusHandler(),
      applied: { capability: "managed", pending: "restart-app" },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-foreground").textContent,
      ).toBe(FOREGROUND_UPDATE_SELF);
    });
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();
  });

  it("GREEN control: managed and pending none — the foreground-update sentence", async () => {
    renderForegroundOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: activationDebtInstallation(),
      overrideHandlers: activationDebtStatusHandler(),
      applied: MANAGED_IDLE,
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-foreground").textContent,
      ).toBe(FOREGROUND_UPDATE_SENTENCE);
    });
  });
});

// ---------------------------------------------------------------------------
// The RPC Doctor sheet's "Free port and restart?" prompt
// (host-doctor-rpc-card.tsx ~353-357 opens it, ~407-432 renders it, always
// with `blockedReason={null}` today) must close its Confirm the moment a
// foreground run starts under it, same class as the bridge-route confirm
// test and its busy/force/defer siblings, but rendered
// through `ConfirmDestructiveDialog`'s own `blockedReason` rather than by
// unmounting the dialog.
// ---------------------------------------------------------------------------

describe("the RPC Doctor sheet's free-port-and-restart prompt during a foreground run", () => {
  it("RED: Confirm is disabled with the restart reason and dispatches nothing once foreground starts under it", async () => {
    const freePortAndRestartIfIdle = vi.fn(() =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    );
    const management = buildOverviewManagement({ freePortAndRestartIfIdle });
    const { pushLifecycleView } = renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      management,
      negotiatedMethods: OVERVIEW_METHODS,
      initialAdmittedAs: null,
      overrideHandlers: doctorHandlerFor(FREE_PORT_ISSUE),
    });
    await openDoctorSheet();

    fireEvent.click(
      await screen.findByTestId(`host-doctor-fix-${FREE_PORT_ISSUE.code}`),
    );
    await screen.findByTestId("confirm-destructive-dialog");

    act(() => {
      pushLifecycleView(lifecycleView("foreground", MANAGED_IDLE));
    });

    await waitFor(() => {
      expect(screen.getByTestId("confirm-blocked-reason").textContent).toBe(
        RESTART_REASON,
      );
    });
    const confirm = screen.getByTestId("confirm-action") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(confirm);
    expect(freePortAndRestartIfIdle).not.toHaveBeenCalled();
  });

  it("GREEN control: without the push, confirming calls freePortAndRestartIfIdle once", async () => {
    const freePortAndRestartIfIdle = vi.fn(() =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    );
    const management = buildOverviewManagement({ freePortAndRestartIfIdle });
    renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      management,
      negotiatedMethods: OVERVIEW_METHODS,
      initialAdmittedAs: null,
      overrideHandlers: doctorHandlerFor(FREE_PORT_ISSUE),
    });
    await openDoctorSheet();

    fireEvent.click(
      await screen.findByTestId(`host-doctor-fix-${FREE_PORT_ISSUE.code}`),
    );
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(freePortAndRestartIfIdle).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The bound offer's one-shot auto-open must WAIT OUT a foreground run
// (`gateArmed: ... || restartDegrade === "terminal-run"`,
// host-overview-panel.tsx:1260) rather than fire and get closed by the
// terminal-run close rule (:1321-1333) in the same render pass, which would
// spend `autoOpenedFor` on a dialog nobody ever saw. Mirrors the
// recoverable-region-retirement one-shot test in
// host-overview-bound-dispatch.test.tsx:1908-2012 (same shape, for the
// `updates.degrade` term).
// ---------------------------------------------------------------------------

function activationAttemptStatusHandler(): MockHandlerMap<HostRpcRegistry> {
  const operation: HostStatusUpdateOperationV2 = {
    kind: "attempt",
    attemptId: "a1",
    generation: 1,
    sequence: 1,
    targetVersion: "1.6.0",
    trigger: "manual",
    phase: "waiting-to-activate",
    execution: "parked",
    continuation: null,
    progress: null,
    liveness: "active",
    livenessCause: null,
    busySessionCount: 2,
    busyBreakdown: null,
    error: null,
  };
  return {
    "host.status": () => ({
      ready: true,
      hostVersion: "1.5.0",
      protocolVersion: { major: 1, minor: 3 },
      busy: false,
      busySessionCount: 2,
      updateProgress: null,
      busyBreakdown: null,
      updateOperation: operation,
      updateTransaction: {
        recordSchemaVersion: 2 as const,
        authority: "attempt" as const,
      },
      storeFormats: null,
      install: null,
    }),
    "host.update.check": () => ({
      outcome: "ok" as const,
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: updateCheckManifest("1.6.0"),
    }),
  };
}

/** The slot's own half of "otherwise qualifying" - this page dispatched a1,
 * and the host has published it at least once (`seen`) - set up directly
 * against the store as the recoverable-region-retirement test does. */
function armOwnedActivationAttempt(hostId: string, incarnation: string): void {
  useHostServiceWriteLatchStore.getState().armUpdateDispatch(hostId, {
    attemptId: "a1",
    incarnation,
  });
  useHostServiceWriteLatchStore
    .getState()
    .observeUpdateDispatchFrame(hostId, { attemptId: "a1", terminal: false });
}

describe("the bound offer's one-shot auto-open waits out a foreground run", () => {
  // Each case spies `newOverviewIncarnation` to its own fixed value; restore it
  // so no later block inherits one.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("RED: does not fire during a foreground run, and fires exactly once after it ends", async () => {
    const FIXED_INCARNATION = "fixed-incarnation-ov11-red";
    vi.spyOn(latchStoreModule, "newOverviewIncarnation").mockReturnValue(
      FIXED_INCARNATION,
    );
    armOwnedActivationAttempt("host-local", FIXED_INCARNATION);

    const { queryClient, pushLifecycleView } = renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      negotiatedMethods: [...OVERVIEW_METHODS, "host.update.activate"],
      overrideHandlers: activationAttemptStatusHandler(),
      initialAdmittedAs: "foreground",
    });

    // The park is on screen and the run is foreground, so nothing has opened.
    await screen.findByTestId("host-overview-operation-card");
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();

    // The run ends: the one shot - held rather than spent - fires.
    act(() => {
      pushLifecycleView(lifecycleView(null, MANAGED_IDLE));
    });
    const dialog = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(dialog.textContent).toContain("Restart to finish the update");

    // EXACTLY once: Defer records the shot, and a further foreground round
    // trip plus recovery pass must not re-open it.
    fireEvent.click(screen.getByTestId("host-busy-defer"));
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    act(() => {
      pushLifecycleView(lifecycleView("foreground", MANAGED_IDLE));
    });
    act(() => {
      pushLifecycleView(lifecycleView(null, MANAGED_IDLE));
    });
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope("host-local", "host.update.check"),
      });
    });
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
  });

  it("GREEN control: a local host that was never foreground auto-opens immediately", async () => {
    const FIXED_INCARNATION = "fixed-incarnation-ov11-green-local";
    vi.spyOn(latchStoreModule, "newOverviewIncarnation").mockReturnValue(
      FIXED_INCARNATION,
    );
    armOwnedActivationAttempt("host-local", FIXED_INCARNATION);

    renderPushableOverview({
      hostId: "host-local",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      negotiatedMethods: [...OVERVIEW_METHODS, "host.update.activate"],
      overrideHandlers: activationAttemptStatusHandler(),
      initialAdmittedAs: null,
    });

    const dialog = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(dialog.textContent).toContain("Restart to finish the update");
  });

  it("GREEN control: a REMOTE host auto-opens immediately even though this machine is foreground", async () => {
    const FIXED_INCARNATION = "fixed-incarnation-ov11-green-remote";
    vi.spyOn(latchStoreModule, "newOverviewIncarnation").mockReturnValue(
      FIXED_INCARNATION,
    );
    armOwnedActivationAttempt("host-remote", FIXED_INCARNATION);

    renderPushableOverview({
      hostId: "host-remote",
      isLocalMachine: false,
      hostVersion: "1.5.0",
      negotiatedMethods: [...OVERVIEW_METHODS, "host.update.activate"],
      overrideHandlers: activationAttemptStatusHandler(),
      initialAdmittedAs: "foreground",
    });

    const dialog = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(dialog.textContent).toContain("Restart to finish the update");
  });
});
