import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

// Secrets under a Local pick of a computer that is not the window's own, with
// the REAL scope hooks, status derivation, pick store, page frame and panel:
// only the host lists and the clients are stood in.

const WINDOW_HOST_ID = "host-window";
const PICKED_HOST_ID = "host-picked";
const PICKED_HOST_NAME = "build-box";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  ambientClient: null as HostClient<HostRpcRegistry> | null,
  overrideClient: null as HostClient<HostRpcRegistry> | null,
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
  useHostClientFor: () => harness.overrideClient,
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
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  harness.hosts = [];
  harness.activeHostId = null;
  harness.ambientClient = null;
  harness.overrideClient = null;
});

function hostRow(input: {
  readonly hostId: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly connectable: boolean;
}): HostScopeOption {
  return hostScopeOptionFixture({
    ...input,
    isLocalMachine: false,
    version: "2.0.0",
  });
}

describe("<SecretsSettingsPanel /> under a Local pick whose computer is away", () => {
  it("shows the away notice in place of an empty body, and the page once the computer is back", async () => {
    const windowHost = buildEnvironmentClient({
      hostId: WINDOW_HOST_ID,
      handlers: {},
    });
    const pickedHost = buildEnvironmentClient({
      hostId: PICKED_HOST_ID,
      handlers: {
        "environment.secrets.list": () => ({ secrets: [], removed: [] }),
      },
    });
    harness.ambientClient = windowHost.client;
    harness.activeHostId = WINDOW_HOST_ID;
    const rows = (pickedConnectable: boolean) => [
      hostRow({
        hostId: WINDOW_HOST_ID,
        name: "window-box",
        isActive: true,
        connectable: true,
      }),
      hostRow({
        hostId: PICKED_HOST_ID,
        name: PICKED_HOST_NAME,
        isActive: false,
        connectable: pickedConnectable,
      }),
    ];
    harness.hosts = rows(false);
    useSettingsEnvironmentPickStore.setState({
      pick: {
        kind: "local",
        hostId: PICKED_HOST_ID,
        hostName: PICKED_HOST_NAME,
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const page = (
      <QueryClientProvider client={queryClient}>
        <PersonalPageFrame section="secrets">
          <SecretsSettingsPanel />
        </PersonalPageFrame>
      </QueryClientProvider>
    );
    const { rerender } = render(page);

    const away = screen.getByTestId("host-scope-unreachable");
    expect(
      within(away).getByText(`Can't reach ${PICKED_HOST_NAME} from here`),
    ).not.toBeNull();
    // Nothing on this page can re-point its scope, so no "Back to" is offered.
    expect(within(away).queryByRole("button")).toBeNull();

    harness.hosts = rows(true);
    harness.overrideClient = pickedHost.client;
    recordNegotiatedHostMethods(PICKED_HOST_ID, ["environment.secrets.list"]);
    rerender(page);

    expect(await screen.findByTestId("secrets-page")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
  });
});
