// Same boundary as `host-overview-parity.test.tsx`: mock `useHostScope` and
// `@/lib/host`'s `useHostBinding` rather than standing up the real hooks.
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

import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostInstalledRecord } from "@traycer-clients/shared/platform/runner-host";
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

function renderPanel(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly connectable: boolean;
  readonly hasManagement: boolean;
  /** Only meaningful when `hasManagement`: drives `deriveStatus` ("stopped" vs "not-installed"). */
  readonly installedRecord?: HostInstalledRecord | null;
  readonly noHostRow?: boolean;
}): void {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
  });

  scopeOverrides.current = options.noHostRow
    ? {
        host: null,
        hosts: [],
        hostId: null,
        vanishedHostId: null,
        isLoading: false,
        listsFailed: false,
        status: "unreachable",
      }
    : {
        host: hostScopeOptionFixture({
          hostId: options.hostId,
          isLocalMachine: options.isLocalMachine,
          connectable: options.connectable,
        }),
        hostId: options.hostId,
        status: options.connectable ? "ready" : "unreachable",
        client: fixture.client,
      };
  hostBindingMock.current = { hostClient: fixture.client };

  const management = options.hasManagement
    ? buildOverviewManagement({
        installedRecord: vi.fn(() =>
          Promise.resolve(options.installedRecord ?? null),
        ),
      })
    : null;

  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost:
      options.isLocalMachine && options.connectable
        ? {
            hostId: options.hostId,
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
}

describe("<HostSettingsPanel /> recovery console — local, stopped or not installed", () => {
  it("renders the recovery console (not the RPC page) for a stopped local host with a management bridge", async () => {
    renderPanel({
      hostId: "host-a",
      isLocalMachine: true,
      connectable: false,
      hasManagement: true,
      installedRecord: makeInstalledRecord("1.4.2"),
    });

    expect(await screen.findByTestId("settings-host-identity")).toBeTruthy();
    expect(screen.queryByTestId("host-overview-restart")).toBeNull();
  });

  it("renders the RPC page (not the recovery console) once the SAME local host is running", async () => {
    renderPanel({
      hostId: "host-a",
      isLocalMachine: true,
      connectable: true,
      hasManagement: true,
      installedRecord: makeInstalledRecord("1.5.0"),
    });

    expect(await screen.findByTestId("host-overview-restart")).toBeTruthy();
    expect(screen.queryByTestId("settings-host-identity")).toBeNull();
  });

  it("does NOT render the recovery console for an unreachable REMOTE host — a remote host has no local console", async () => {
    renderPanel({
      hostId: "host-remote",
      isLocalMachine: false,
      connectable: false,
      hasManagement: true,
      installedRecord: makeInstalledRecord("1.4.2"),
    });

    // The misattribution guard: an unreachable REMOTE host is never routed to
    // the local recovery console just because it can't be dialed right now —
    // `localConsoleApplies` gates on `isLocalMachine`, not on reachability.
    // The RPC page renders instead (degraded, since nothing is dialable), but
    // it is never this computer's install/start console under another name.
    expect(await screen.findByTestId("host-identity-card")).toBeTruthy();
    expect(screen.queryByTestId("settings-host-identity")).toBeNull();
  });

  it("keeps the console reachable for the empty-account carve-out (no host row anywhere)", async () => {
    renderPanel({
      hostId: "host-a",
      isLocalMachine: true,
      connectable: false,
      hasManagement: true,
      installedRecord: null,
      noHostRow: true,
    });

    expect(await screen.findByTestId("settings-host-identity")).toBeTruthy();
    expect(screen.queryByTestId("host-overview-restart")).toBeNull();
  });
});
