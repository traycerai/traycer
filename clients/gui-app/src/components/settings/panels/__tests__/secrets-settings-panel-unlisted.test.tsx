import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

// Secrets under a Local pick of a computer the settled host lists no longer
// name, with the REAL scope hooks, status derivation, pick store, page frame
// and panel: only the host lists and the clients are stood in.

const WINDOW_HOST_ID = "host-window";
const GONE_HOST_ID = "host-gone";
const GONE_HOST_NAME = "Garage PC";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  ambientClient: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
    hostManagement: null,
  }),
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: harness.hosts,
        activeHostId: harness.activeHostId,
      }),
  };
});

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (harness.ambientClient === null) {
        throw new Error("ambient client not installed");
      }
      return harness.ambientClient;
    },
  };
});

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { SecretsSettingsPanel } from "@/components/settings/panels/secrets-settings-panel";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

afterEach(() => {
  cleanup();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  harness.hosts = [];
  harness.activeHostId = null;
  harness.ambientClient = null;
});

describe("<SecretsSettingsPanel /> under a Local pick the host lists no longer name", () => {
  it("says the page is not on that computer, which isn't connected to this app", () => {
    harness.ambientClient = buildEnvironmentClient({
      hostId: WINDOW_HOST_ID,
      handlers: {},
    }).client;
    harness.activeHostId = WINDOW_HOST_ID;
    harness.hosts = [
      hostScopeOptionFixture({
        hostId: WINDOW_HOST_ID,
        name: "window-box",
        isLocalMachine: false,
        isActive: true,
        version: "2.0.0",
      }),
    ];
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: GONE_HOST_ID, hostName: GONE_HOST_NAME },
    });

    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <PersonalPageFrame section="secrets">
          <SecretsSettingsPanel />
        </PersonalPageFrame>
      </QueryClientProvider>,
    );

    const card = screen.getByTestId("secrets-not-connected");
    expect(within(card).getByText(`Not on ${GONE_HOST_NAME}`)).toBeTruthy();
    expect(
      within(card).getByText(`${GONE_HOST_NAME} isn't connected to this app.`),
    ).toBeTruthy();
  });
});
