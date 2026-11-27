import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { UpdateHostVersionPolicyInput } from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

// Secrets under a Local pick of a computer other than the window's own, with
// the REAL scope hooks, status derivation, pick store, page frame, panel and
// Update now: only the host lists, the clients and the account's update call
// are stood in.

const WINDOW_HOST_ID = "host-window";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  ambientClient: null as HostClient<HostRpcRegistry> | null,
  updateHostVersionPolicy:
    vi.fn<
      (hostId: string, input: UpdateHostVersionPolicyInput) => Promise<never>
    >(),
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
    useHostBinding: () => ({
      ...actual.useHostBinding(),
      auth: { updateHostVersionPolicy: harness.updateHostVersionPolicy },
    }),
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
  harness.updateHostVersionPolicy.mockReset();
  resetNegotiatedManifests();
});

function windowHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: WINDOW_HOST_ID,
    name: "window-box",
    isLocalMachine: false,
    isActive: true,
    version: "2.0.0",
  });
}

function renderSecrets(): void {
  harness.ambientClient = buildEnvironmentClient({
    hostId: WINDOW_HOST_ID,
    handlers: {},
  }).client;
  harness.activeHostId = WINDOW_HOST_ID;
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
}

describe("<SecretsSettingsPanel /> under a Local pick of another computer", () => {
  it("says the page is not on a computer the host lists no longer name, which isn't connected to this app", () => {
    harness.hosts = [windowHost()];
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-gone", hostName: "Garage PC" },
    });

    renderSecrets();

    const card = screen.getByTestId("secrets-not-connected");
    expect(within(card).getByText("Not on Garage PC")).toBeTruthy();
    expect(
      within(card).getByText("Garage PC isn't connected to this app."),
    ).toBeTruthy();
  });

  it("asks the account to update the picked computer, not the window's, from Update now", async () => {
    const oldHostId = "host-old";
    harness.hosts = [
      windowHost(),
      hostScopeOptionFixture({
        hostId: oldHostId,
        name: "Old laptop",
        isLocalMachine: false,
        isActive: false,
        version: "1.0.0",
      }),
    ];
    // The old computer's handshake went through without environment.status,
    // so it is known to predate the page.
    recordNegotiatedHostMethods(oldHostId, ["host.status"]);
    harness.updateHostVersionPolicy.mockReturnValue(new Promise(() => {}));
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: oldHostId, hostName: "Old laptop" },
    });

    renderSecrets();

    const card = screen.getByTestId("secrets-update-host");
    expect(within(card).getByText("Not on Old laptop")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Update now" }));

    // The mutation calls the account once it has run its own setup.
    await waitFor(() =>
      expect(harness.updateHostVersionPolicy.mock.calls).toEqual([
        [
          oldHostId,
          {
            desiredVersion: "0.0.0",
            updatePolicy: undefined,
            force: undefined,
          },
        ],
      ]),
    );
  });
});
