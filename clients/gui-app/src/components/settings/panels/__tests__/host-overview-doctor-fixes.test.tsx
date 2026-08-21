// Same boundary as the sibling Overview suites: mock `useHostScope` and
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

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
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

import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import type { HostRpcRegistry } from "@/lib/host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import {
  ExternalHostRestartTrigger,
  openHostOverviewMenu,
  buildOverviewHostFixture,
  buildOverviewManagement,
  makeInstalledRecord,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

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

const DOCTOR_WITHOUT_LOGS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
] as const;

const DOCTOR_WITHOUT_RESTART = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.doctor",
  "host.update.check",
  "host.update.install",
] as const;

// Both lists above omit `diagnostics.logs.tail`; only DOCTOR_WITHOUT_RESTART
// also omits `host.restart`, which is the axis the remote-restart builder
// varies. The alias keeps that call site readable — selecting a constant
// named for what it lacks (logs) to mean "restart present" made readers check
// the list twice.
const DOCTOR_WITH_RESTART = DOCTOR_WITHOUT_LOGS;

const RECENT_CRASH_MARKERS: HostDoctorIssue = {
  code: "RECENT_CRASH_MARKERS",
  severity: "warning",
  title: "Recent crash markers",
  message: "The host log contains recent crash markers.",
  fixAction: "host-logs",
  terminalCommand: null,
  details: null,
};

const CLI_UPGRADE_PENDING: HostDoctorIssue = {
  code: "CLI_UPGRADE_PENDING",
  severity: "warning",
  title: "CLI upgrade pending (2.0.0)",
  message: "Restart the host service to finalise the swap.",
  fixAction: "host-restart",
  terminalCommand: "traycer host restart --channel prod",
  details: null,
};

/**
 * The one doctor fix that ENDS things: it asks the process holding the port to
 * exit, then restarts the host — killing in-flight work on both counts.
 */
const FREE_PORT_ISSUE: HostDoctorIssue = {
  code: "PORT_CONFLICT",
  severity: "error",
  title: "Port 8765 is in use",
  message: "Another process is holding the host's configured port.",
  fixAction: "host-free-port-and-restart",
  terminalCommand: "traycer host restart --free-port 8765",
  details: { port: 8765, conflictingPid: 4242, conflictingProcess: "node" },
};

/**
 * The one place these suites mount the panel. Everything the three scenario
 * builders used to repeat — the fixture, the negotiated-method record, the
 * scope override, the host binding, the runner host, the QueryClient and the
 * render tree — lives here exactly once; each wrapper below supplies only
 * what its scenario varies.
 */
function renderDoctorPanel(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly negotiatedMethods: readonly string[];
  readonly overrideHandlers: MockHandlerMap<HostRpcRegistry>;
  readonly management: IHostManagement | null;
  readonly extra: ReactNode | undefined;
}): {
  readonly fixture: OverviewHostFixture;
  readonly queryClient: QueryClient;
} {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
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
  hostBindingMock.current = { hostClient: fixture.client };

  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    // A live snapshot, so a local variant is a RUNNING local host and gets
    // the RPC page rather than the recovery console.
    localHost: options.isLocalMachine
      ? {
          hostId: options.hostId,
          availability: "available" as const,
          websocketUrl: "ws://127.0.0.1:8765",
          version: "1.5.0",
          pid: 4821,
          systemHostName: options.hostId,
          displayName: options.hostId,
        }
      : null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: options.management,
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        {options.extra ?? null}
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { fixture, queryClient };
}

function renderDoctor(options: {
  readonly isLocalMachine: boolean;
  readonly withBridge: boolean;
  readonly doctorFails: boolean;
  readonly extra: ReactNode | undefined;
}): {
  readonly management: IHostManagement;
  readonly queryClient: QueryClient;
} {
  const management = buildOverviewManagement({
    installedRecord: vi.fn(() => Promise.resolve(makeInstalledRecord("1.5.0"))),
  });
  const { queryClient } = renderDoctorPanel({
    hostId: options.isLocalMachine ? "host-local" : "host-remote",
    isLocalMachine: options.isLocalMachine,
    negotiatedMethods: OVERVIEW_METHODS,
    overrideHandlers: {
      "host.doctor": () => {
        if (options.doctorFails) {
          throw new Error("host went away mid-check");
        }
        return {
          status: "ok" as const,
          issues: [FREE_PORT_ISSUE],
          // Empty on purpose: the vantage taxonomy is the host's call, and an
          // empty set is what a relay-served report carries. Putting
          // PORT_CONFLICT in here would filter the issue out and make every
          // assertion below vacuous.
          triviallyGreenIssueCodes: [],
        };
      },
    },
    management: options.withBridge ? management : null,
    extra: options.extra,
  });
  return { management, queryClient };
}

describe("Overview doctor — the three local-only repairs", () => {
  it("still confirms before freeing a port and restarting, on the RPC route", async () => {
    // The regression this pins is a QUIET one. Moving Doctor onto the host's
    // own RPC changed which report is being read; it did not make the repair
    // any less destructive. The bridge Doctor has always put a confirmation in
    // front of this one — it ends the conflicting process and restarts the
    // host — and the first RPC card shipped without it, so a single click
    // killed a process with no warning.
    const { management } = renderDoctor({
      isLocalMachine: true,
      withBridge: true,
      doctorFails: false,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    fireEvent.click(await screen.findByTestId("host-doctor-fix-PORT_CONFLICT"));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    // Named, so the dialog cannot be a generic "are you sure" that fails to
    // say which process is about to be ended.
    expect(dialog.textContent).toContain("8765");
    expect(dialog.textContent).toContain("node");
    // Nothing has happened yet — the click ARMED the action, it did not run it.
    expect(management.freePortAndRestartIfIdle).not.toHaveBeenCalled();
    expect(management.freePortAndRestart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(management.freePortAndRestartIfIdle).toHaveBeenCalledWith({
        port: 8765,
        pid: 4242,
        processName: "node",
        expectedHostId: "host-local",
      });
    });
    expect(management.freePortAndRestart).not.toHaveBeenCalled();
  });

  it("offers the command instead of a fix button for a host on another machine", async () => {
    // Not a missing RPC — a deliberate scope drop. Freeing a port and
    // restarting repairs a host that is typically not answering RPCs at all,
    // and nothing here can reach another machine's ports or service manager.
    // The honest affordance is the command to run there, so the fix BUTTON
    // must be absent rather than present-and-broken.
    renderDoctor({
      isLocalMachine: false,
      withBridge: true,
      doctorFails: false,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    expect(
      await screen.findByTestId("host-doctor-copy-command-PORT_CONFLICT"),
    ).toBeTruthy();
    expect(screen.queryByTestId("host-doctor-fix-PORT_CONFLICT")).toBeNull();
    expect(
      screen.getByTestId("host-doctor-run-on-host-PORT_CONFLICT").textContent,
    ).toContain("has to run on");
  });

  it("offers the command for THIS computer too when the shell has no CLI bridge", async () => {
    // Web and mobile shells administer a host perfectly well over RPC but have
    // no local CLI to run a repair with. The route keys on the BRIDGE being
    // present, not on the host being local — keying on locality alone would
    // render a fix button here that can only throw.
    renderDoctor({
      isLocalMachine: true,
      withBridge: false,
      doctorFails: false,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    expect(
      await screen.findByTestId("host-doctor-copy-command-PORT_CONFLICT"),
    ).toBeTruthy();
    expect(screen.queryByTestId("host-doctor-fix-PORT_CONFLICT")).toBeNull();
  });

  it("offers a re-run when the Doctor request itself fails", async () => {
    // The failure path only toasted, and the toast is gone in seconds. `report`
    // stayed null, so the card sat on "Running Doctor…" for the life of the
    // sheet - spinning at a request that had already finished, with no way to
    // try again from inside the card.
    renderDoctor({
      isLocalMachine: true,
      withBridge: false,
      doctorFails: true,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));

    expect(await screen.findByTestId("host-doctor-run-failed")).toBeTruthy();
    expect(screen.queryByText("Running Doctor…")).toBeNull();
    expect(screen.getByTestId("host-doctor-rerun")).toBeTruthy();
  });

  it("arming the page lifecycle gate closes an open free-port dialog, and a confirm after that dispatches nothing", async () => {
    // Discriminator: gating the issue card's button never reached a dialog
    // that was ALREADY open, so a confirm after an install/restart armed
    // queued a process kill behind that write. Red against f705b8eb^ (the
    // dialog stayed answerable).
    let releaseExternal: (() => void) | null = null;
    const externalGate = new Promise<void>((resolve) => {
      releaseExternal = resolve;
    });
    const mutateRef: { current: (() => void) | null } = { current: null };
    const { management, queryClient } = renderDoctor({
      isLocalMachine: true,
      withBridge: true,
      doctorFails: false,
      extra: (
        <ExternalHostRestartTrigger
          onReady={(mutate) => {
            mutateRef.current = mutate;
          }}
          mutationFn={async () => {
            await externalGate;
            return { kind: "restarted" as const };
          }}
        />
      ),
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    fireEvent.click(await screen.findByTestId("host-doctor-fix-PORT_CONFLICT"));
    expect(
      await screen.findByTestId("confirm-destructive-dialog"),
    ).toBeTruthy();
    expect(management.freePortAndRestartIfIdle).not.toHaveBeenCalled();
    expect(management.freePortAndRestart).not.toHaveBeenCalled();

    act(() => {
      if (mutateRef.current === null) {
        throw new Error("external restart trigger was not armed");
      }
      mutateRef.current();
    });
    await waitFor(() => {
      expect(
        queryClient.isMutating({
          mutationKey: runnerMutationKeys.hostRestart(),
        }),
      ).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });

    const confirm = screen.queryByTestId("confirm-action");
    if (confirm !== null) {
      fireEvent.click(confirm);
    }
    expect(management.freePortAndRestartIfIdle).not.toHaveBeenCalled();
    expect(management.freePortAndRestart).not.toHaveBeenCalled();

    await act(async () => {
      releaseExternal?.();
      await externalGate;
    });
  });
});

function renderDoctorLogs(options: {
  readonly isLocalMachine: boolean;
  readonly withBridge: boolean;
  readonly advertiseLogs: boolean;
}): {
  readonly management: IHostManagement;
  readonly rpcLogCalls: { count: number };
} {
  const rpcLogCalls = { count: 0 };
  const management = buildOverviewManagement({
    installedRecord: vi.fn(() => Promise.resolve(makeInstalledRecord("1.5.0"))),
    getHostLogs: vi.fn(() =>
      Promise.resolve({
        path: "/tmp/host.log",
        tail: "bridge-line-1\nbridge-line-2",
      }),
    ),
  });
  renderDoctorPanel({
    hostId: options.isLocalMachine ? "host-local" : "host-remote",
    isLocalMachine: options.isLocalMachine,
    negotiatedMethods: options.advertiseLogs
      ? OVERVIEW_METHODS
      : DOCTOR_WITHOUT_LOGS,
    overrideHandlers: {
      "host.doctor": () => ({
        status: "ok" as const,
        issues: [RECENT_CRASH_MARKERS, CLI_UPGRADE_PENDING],
        triviallyGreenIssueCodes: [],
      }),
      "diagnostics.logs.tail": () => {
        rpcLogCalls.count += 1;
        return {
          status: "available" as const,
          target: "host" as const,
          path: "/tmp/host.log",
          lines: ["rpc-log-line"],
          truncated: false,
        };
      },
    },
    management: options.withBridge ? management : null,
    extra: undefined,
  });
  return { management, rpcLogCalls };
}

describe("Overview doctor — Show logs stays on an honest source", () => {
  it("Show logs on a local host with a bridge and no RPC logs reads via getHostLogs", async () => {
    const { management, rpcLogCalls } = renderDoctorLogs({
      isLocalMachine: true,
      withBridge: true,
      advertiseLogs: false,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-RECENT_CRASH_MARKERS"),
    );

    await waitFor(() => {
      // Fenced on the host the report names, not just asked for: an unfenced
      // read would hand back a replacement host's log under this one's name.
      expect(management.getHostLogs).toHaveBeenCalledWith({
        tailLines: 200,
        expectedHostId: "host-local",
      });
    });
    expect(rpcLogCalls.count).toBe(0);
    const tail = await screen.findByTestId("host-doctor-log-tail");
    expect(tail.textContent).toContain("bridge-line-1");
    expect(tail.textContent).not.toContain("rpc-log-line");
  });

  it("withholds Show logs on a remote host that advertises doctor but not diagnostics.logs.tail", async () => {
    // Discriminator: round 4 routed on `!rpcLogsSupported` alone, so a remote
    // host's Show logs button read THIS computer's log via the bridge and
    // rendered it under the remote name. The button must be absent, not
    // present-and-wrong. Red against 390d05c2^.
    const { management, rpcLogCalls } = renderDoctorLogs({
      isLocalMachine: false,
      withBridge: true,
      advertiseLogs: false,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    expect(
      await screen.findByTestId("host-doctor-fix-CLI_UPGRADE_PENDING"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("host-doctor-fix-RECENT_CRASH_MARKERS"),
    ).toBeNull();
    expect(management.getHostLogs).not.toHaveBeenCalled();
    expect(rpcLogCalls.count).toBe(0);
  });

  it("Show logs on a remote host that advertises diagnostics.logs.tail uses the RPC, not the bridge", async () => {
    const { management, rpcLogCalls } = renderDoctorLogs({
      isLocalMachine: false,
      withBridge: true,
      advertiseLogs: true,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-RECENT_CRASH_MARKERS"),
    );

    await waitFor(() => {
      expect(rpcLogCalls.count).toBe(1);
    });
    expect(management.getHostLogs).not.toHaveBeenCalled();
    const tail = await screen.findByTestId("host-doctor-log-tail");
    expect(tail.textContent).toContain("rpc-log-line");
    expect(tail.textContent).not.toContain("bridge-line-1");
  });

  it("withholds Show logs on this computer when there is no CLI bridge and no RPC logs", async () => {
    const { management, rpcLogCalls } = renderDoctorLogs({
      isLocalMachine: true,
      withBridge: false,
      advertiseLogs: false,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    expect(
      await screen.findByTestId("host-doctor-fix-CLI_UPGRADE_PENDING"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("host-doctor-fix-RECENT_CRASH_MARKERS"),
    ).toBeNull();
    expect(management.getHostLogs).not.toHaveBeenCalled();
    expect(rpcLogCalls.count).toBe(0);
  });
});

function renderRemoteDoctorRestart(options: {
  readonly advertiseRestart: boolean;
}): {
  readonly fixture: OverviewHostFixture;
} {
  const { fixture } = renderDoctorPanel({
    hostId: "host-remote",
    isLocalMachine: false,
    negotiatedMethods: options.advertiseRestart
      ? DOCTOR_WITH_RESTART
      : DOCTOR_WITHOUT_RESTART,
    overrideHandlers: {
      "host.doctor": () => ({
        status: "ok" as const,
        issues: [CLI_UPGRADE_PENDING],
        triviallyGreenIssueCodes: [],
      }),
    },
    // Always bridged, unlike the two builders above: these scenarios pin the
    // RPC-capability split on a REMOTE host, where the local bridge existing
    // must not matter.
    management: buildOverviewManagement({
      installedRecord: vi.fn(() =>
        Promise.resolve(makeInstalledRecord("1.5.0")),
      ),
    }),
    extra: undefined,
  });
  return { fixture };
}

describe("Overview doctor — remote restart capability", () => {
  it("offers the copy-command on a remote host that advertises doctor but not host.restart", async () => {
    // Discriminator: `rpcRestartSupported: !restartViaForceFallback` misread
    // a remote refusal as "the RPC works" and rendered a live Restart button
    // that dispatched the refused method. Red against 563d9035^.
    const { fixture } = renderRemoteDoctorRestart({
      advertiseRestart: false,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    expect(
      await screen.findByTestId("host-doctor-copy-command-CLI_UPGRADE_PENDING"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("host-doctor-fix-CLI_UPGRADE_PENDING"),
    ).toBeNull();
    expect(fixture.restartCalls()).toBe(0);
  });

  it("keeps a live RPC restart on a remote host that advertises host.restart", async () => {
    const { fixture } = renderRemoteDoctorRestart({
      advertiseRestart: true,
    });

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-CLI_UPGRADE_PENDING"),
    );

    await waitFor(() => {
      expect(fixture.restartCalls()).toBe(1);
    });
  });
});
