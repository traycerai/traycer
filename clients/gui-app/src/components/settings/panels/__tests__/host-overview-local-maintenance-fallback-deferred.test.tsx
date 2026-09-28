// On the LOCAL-MAINTENANCE FALLBACK lane (a host below the
// maintenance floor), does a version row's Install show the terminal-host
// refusal verbatim when the lane resolves `{ kind: "deferred", message }`?
//
// New file, deliberately: `host-overview-local-maintenance-fallback.test.tsx`
// already pins the SAME lane's "busy" outcome (toast fires, region survives,
// Update now re-enables) - this reuses that exact harness for a "deferred"
// outcome instead, to isolate the one new question (does the MESSAGE survive
// `mapInstallVersionOutcome` -> `HostRpcError({code:"RPC_ERROR", ...})` ->
// `toastFromHostError`'s code-keyed copy) without touching the existing file.
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
    readonly getLocalEntry: () => { readonly hostId: string } | null;
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
const localHostIdMock = vi.hoisted((): { current: string | null } => ({
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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  IHostManagement,
  IRunnerHost,
  MutationOutcome,
  InstallVersionOk,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostGetInstallationInfoResponseV11 } from "@traycer/protocol/host/maintenance/index";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { createLocalMaintenanceFallbackClient } from "@/lib/host/local-maintenance-fallback-client";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
  selectHostOverviewTab,
  updateCheckManifest,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  localHostIdMock.current = null;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.message).mockClear();
});

const HOST_ID = "host-local";
const HOST_NAME = "Local Host";
const RELEASED_FLOOR_METHODS = ["host.status"] as const;
const RPC_INSTALL_VERSION = "rpc-1.0.0";
const BRIDGE_INSTALL_VERSION = "bridge-9.9.9";
const BRIDGE_CHECK_VERSION = "1.2.0";
const RUNNING_HOST_VERSION = "1.1.11";
const RPC_CHECK_VERSION = "1.3.0";

const SENTENCE =
  "A host started in a terminal is running; the desktop won't update it.";

function managedInstallationInfo(
  version: string,
): HostGetInstallationInfoResponseV11 {
  return {
    status: "managed",
    installRecord: {
      installId: `id-${version}`,
      version,
      runtimeVersion: null,
      platform: "darwin",
      arch: "arm64",
      installedAt: "2026-08-10T00:00:00Z",
      source: { kind: "registry", value: version },
      archiveSha256: "b".repeat(64),
      signatureVerifiedAt: "2026-08-10T00:00:00Z",
      signatureKeyId: "key-1",
      sizeBytes: 2048,
      executablePath: `/tmp/traycer/${version}/host`,
      executableSha256: null,
    },
    stagedRecord: null,
    cliManifest: null,
  };
}

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      getLocalEntry: () =>
        localHostIdMock.current === null
          ? null
          : { hostId: localHostIdMock.current },
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function makeRunnerHostWithManagement(
  management: IHostManagement | null,
): IRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: management,
  });
}

function fallbackScope(
  fixture: OverviewHostFixture,
  management: IHostManagement,
): Record<string, unknown> {
  const client = createLocalMaintenanceFallbackClient({
    client: fixture.client,
    localHostId: HOST_ID,
    management,
  });
  return {
    host: hostScopeOptionFixture({
      hostId: HOST_ID,
      name: HOST_NAME,
      isLocalMachine: true,
      connectable: true,
      platform: "darwin-arm64",
      version: "1.1.11",
    }),
    hostId: HOST_ID,
    hostLabel: HOST_NAME,
    status: "ready",
    client,
    localMaintenanceFallback: true,
  };
}

function renderOverview(input: {
  readonly management: IHostManagement;
  readonly queryClient: QueryClient;
}): void {
  const runnerHost = makeRunnerHostWithManagement(input.management);
  render(
    <QueryClientProvider client={input.queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function mountFallbackOverview(
  installOutcome: MutationOutcome<InstallVersionOk>,
): { readonly management: IHostManagement } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const fixture = buildOverviewHostFixture({
    hostId: HOST_ID,
    isLocalMachine: true,
    hostVersion: RUNNING_HOST_VERSION,
    effectiveName: HOST_NAME,
    invalidator: createHostQueryInvalidator(queryClient),
    overrideHandlers: {
      "host.update.check": () => ({
        outcome: "ok" as const,
        effectiveIncludePreReleases: false,
        includePreReleasesSource: "stable-default" as const,
        manifest: updateCheckManifest(RPC_CHECK_VERSION),
      }),
      "host.getInstallationInfo": () =>
        managedInstallationInfo(RPC_INSTALL_VERSION),
    },
  });
  const management = buildOverviewManagement({
    maintenanceUpdateCheck: vi.fn(() =>
      Promise.resolve({
        outcome: "ok" as const,
        effectiveIncludePreReleases: false,
        includePreReleasesSource: "stable-default" as const,
        manifest: updateCheckManifest(BRIDGE_CHECK_VERSION),
      }),
    ),
    maintenanceInstallVersion: vi.fn(
      (_input: {
        readonly version: string;
        readonly force: boolean;
        readonly expectedHostId: string;
      }) =>
        Promise.resolve({
          kind: "dispatched" as const,
          outcome: installOutcome,
        }),
    ),
    maintenanceInstallationInfo: vi.fn(() =>
      Promise.resolve(managedInstallationInfo(BRIDGE_INSTALL_VERSION)),
    ),
  });
  recordNegotiatedHostMethods(HOST_ID, [...RELEASED_FLOOR_METHODS]);
  localHostIdMock.current = HOST_ID;
  hostBindingMock.current = bindingWith(fixture.client);
  scopeOverrides.current = fallbackScope(fixture, management);
  renderOverview({ management, queryClient });
  return { management };
}

describe("<HostSettingsPanel /> local-maintenance CLI fallback - a deferred (terminal-host) install outcome", () => {
  it("Update now shows the refusal verbatim", async () => {
    const { management } = mountFallbackOverview({
      kind: "deferred",
      message: SENTENCE,
    });

    await selectHostOverviewTab("updates");
    await screen.findByText(`v${BRIDGE_CHECK_VERSION} is available.`);
    const updateNow = await screen.findByRole("button", {
      name: "Update now",
    });
    fireEvent.click(updateNow);

    await waitFor(() => {
      expect(management.maintenanceInstallVersion).toHaveBeenCalledWith({
        version: BRIDGE_CHECK_VERSION,
        force: false,
        expectedHostId: HOST_ID,
      });
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    // What the toast actually shows - reported verbatim for review,
    // whichever it is.
    const shown = vi.mocked(toast.error).mock.calls[0]?.[0];
    expect(shown).toContain(SENTENCE);
  });

  // The ruling named the version ROW specifically, not the "Update now" shortcut.
  // Both reach the same `install()` `onError` (`host-overview-updates-state.ts`
  // ~:351), but the row lives on the Updates tab's own list
  // (`host-version-rows.tsx`, `aria-label="Install <version>"`), which the case
  // above never opens. The bridge's single `host.update.check` answer
  // (`BRIDGE_CHECK_VERSION`) already offers one installable version other than
  // the running one, so this reuses that row rather than adding a fixture
  // entry.
  it("a version row's own Install shows the refusal verbatim", async () => {
    const user = userEvent.setup();
    const { management } = mountFallbackOverview({
      kind: "deferred",
      message: SENTENCE,
    });

    await selectHostOverviewTab("updates");
    await screen.findByText(`v${BRIDGE_CHECK_VERSION} is available.`);
    // Radix's TabsTrigger activates on pointer events, not a bare `click`
    // event, so this needs `userEvent` - the same pattern
    // `add-host-dialog.test.tsx` uses for its own tab switch.
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    const installRow = await screen.findByRole("button", {
      name: `Install ${BRIDGE_CHECK_VERSION}`,
    });
    fireEvent.click(installRow);

    await waitFor(() => {
      expect(management.maintenanceInstallVersion).toHaveBeenCalledWith({
        version: BRIDGE_CHECK_VERSION,
        force: false,
        expectedHostId: HOST_ID,
      });
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    const shown = vi.mocked(toast.error).mock.calls[0]?.[0];
    expect(shown).toContain(SENTENCE);
  });
});
