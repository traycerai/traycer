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

import {
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
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
  makeInstalledRecord,
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

function renderDoctor(options: {
  readonly isLocalMachine: boolean;
  readonly withBridge: boolean;
  readonly doctorFails: boolean;
}): IHostManagement {
  const hostId = options.isLocalMachine ? "host-local" : "host-remote";
  const fixture = buildOverviewHostFixture({
    hostId,
    isLocalMachine: options.isLocalMachine,
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
  });
  recordNegotiatedHostMethods(hostId, OVERVIEW_METHODS);

  const management = buildOverviewManagement({
    installedRecord: vi.fn(() => Promise.resolve(makeInstalledRecord("1.5.0"))),
  });

  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = { hostClient: fixture.client };

  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    // A live snapshot, so the local variant is a RUNNING local host and gets
    // the RPC page rather than the recovery console.
    localHost: options.isLocalMachine
      ? {
          hostId,
          websocketUrl: "ws://127.0.0.1:8765",
          version: "1.5.0",
          pid: 4821,
          systemHostName: hostId,
          displayName: hostId,
        }
      : null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: options.withBridge ? management : null,
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
  return management;
}

describe("Overview doctor — the three local-only repairs", () => {
  it("still confirms before freeing a port and restarting, on the RPC route", async () => {
    // The regression this pins is a QUIET one. Moving Doctor onto the host's
    // own RPC changed which report is being read; it did not make the repair
    // any less destructive. The bridge Doctor has always put a confirmation in
    // front of this one — it ends the conflicting process and restarts the
    // host — and the first RPC card shipped without it, so a single click
    // killed a process with no warning.
    const management = renderDoctor({
      isLocalMachine: true,
      withBridge: true,
      doctorFails: false,
    });

    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(await screen.findByTestId("host-doctor-fix-PORT_CONFLICT"));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    // Named, so the dialog cannot be a generic "are you sure" that fails to
    // say which process is about to be ended.
    expect(dialog.textContent).toContain("8765");
    expect(dialog.textContent).toContain("node");
    // Nothing has happened yet — the click ARMED the action, it did not run it.
    expect(management.freePortAndRestart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(management.freePortAndRestart).toHaveBeenCalledWith({
        port: 8765,
        pid: 4242,
        processName: "node",
      });
    });
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
    });

    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
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
    });

    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
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
    });

    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));

    expect(await screen.findByTestId("host-doctor-run-failed")).toBeTruthy();
    expect(screen.queryByText("Running Doctor…")).toBeNull();
    expect(screen.getByTestId("host-doctor-rerun")).toBeTruthy();
  });
});
