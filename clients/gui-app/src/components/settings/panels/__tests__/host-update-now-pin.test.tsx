// The page a computer lacks offers the same Update now Host Overview does: one
// recording host client answers both, and both dispatch the same
// `host.update.install` with the same latest version.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));
vi.mock("@/components/settings/panels/host-overview-settings-card", () => ({
  HostOverviewSettingsCardSlot: () => null,
}));
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).personalHostScopeModule,
);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ManifestMethodEntry } from "@traycer/protocol/framework/index";
import {
  personalHostScopeOverrides,
  resetEnvironmentSectionReads,
} from "@/components/settings/__tests__/environment-section-reads-fixture";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { PageOrNotOnComputer } from "@/components/settings/environment/page-not-on-computer";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import {
  buildOverviewHostFixture,
  selectHostOverviewTab,
  updateCheckManifest,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/** What the host serves: the Overview's reads and install, and no `environment.status`. */
const OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.getInstallationInfo",
  "host.update.check",
  "host.update.install",
] as const;

afterEach(() => {
  cleanup();
  resetHostServiceWriteLatchesForTest();
  resetNegotiatedManifests();
  resetEnvironmentSectionReads();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function renderWith(page: React.ReactNode): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <RunnerHostProvider
        runnerHost={
          new MockRunnerHost({
            signInUrl: "https://example.invalid/signin",
            authnBaseUrl: "https://example.invalid",
            localHost: null,
            hosts: [],
            workspaceFolderPickerPaths: undefined,
            hasLocalHost: undefined,
            traycerCli: undefined,
          })
        }
      >
        {page}
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("Update now, on the page a computer lacks and on Host Overview", () => {
  it("dispatches the same host.update.install with the same latest version", async () => {
    const installs: unknown[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.6.0"),
        }),
        "host.update.install": (req) => {
          installs.push(req);
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });
    const manifest: Record<string, ManifestMethodEntry> = {};
    for (const method of OVERVIEW_METHODS) {
      manifest[method] = { major: 1, minor: 0 };
    }
    manifest["host.update.install"] = { major: 1, minor: 2 };
    recordNegotiatedHostManifest("host-a", manifest);
    personalHostScopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId: "host-a",
        name: "Old laptop",
        isLocalMachine: true,
        connectable: true,
      }),
      hostId: "host-a",
      status: "ready",
      client: fixture.client,
    };

    renderWith(<HostSettingsPanel />);
    await selectHostOverviewTab("updates");
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => {
      expect(installs).toHaveLength(1);
    });
    cleanup();
    resetHostServiceWriteLatchesForTest();

    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-a", hostName: "Old laptop" },
    });
    renderWith(
      <PageOrNotOnComputer section="secrets">
        <div data-testid="secrets-page" />
      </PageOrNotOnComputer>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => {
      expect(installs).toHaveLength(2);
    });

    expect(installs[1]).toEqual(installs[0]);
    expect(installs[0]).toMatchObject({ version: "1.6.0" });
    expect(screen.queryByTestId("secrets-page")).toBeNull();
  });
});
