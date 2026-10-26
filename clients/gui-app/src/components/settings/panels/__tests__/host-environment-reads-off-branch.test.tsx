// Host ▸ Overview's two environment reads, over a real client and a recording
// messenger: with the verdict off or unread neither section sends a request or
// draws anything; with environments on the same host is read and drawn.
const authUser = vi.hoisted((): { current: { readonly data: unknown } } => ({
  current: { data: undefined },
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: authUser.current.data,
    isPending: authUser.current.data === undefined,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
}));
// The card behind the slot opens the configuration drawer, which has its own suite.
vi.mock("@/components/settings/details/overview-card-details-line", () => ({
  OverviewCardDetailsLine: () => null,
}));
vi.mock("@/components/settings/details/settings-details-button", () => ({
  SettingsDetailsDialog: () => null,
}));
vi.mock(
  "@/components/settings/details/use-host-settings-details-subject",
  () => ({
    useHostSettingsDetailsSubject: () => ({
      environmentId: "env-a",
      kind: "host_settings",
      key: "old",
    }),
  }),
);

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { HostEnvironmentSection } from "@/components/settings/panels/host-environment-section";
import { HostOverviewSettingsCardSlot } from "@/components/settings/panels/host-overview-settings-card";
import {
  environmentStatusFixture,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

const HOST_ID = "host-a";
const RECORD_ON = {
  userId: "user-me",
  previewFeatures: { environments: true, sandboxes: false, bots: true },
};
const OFF_READINGS = [
  { reading: "an unread user record", user: undefined },
  { reading: "a record without a verdict", user: { userId: "user-me" } },
  {
    reading: "a record with environments off",
    user: {
      userId: "user-me",
      previewFeatures: { environments: false, sandboxes: false, bots: false },
    },
  },
] as const;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  authUser.current = { data: undefined };
});

interface HostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly requests: () => string[];
}

function hostFixture(): HostFixture {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-reads",
    handlers: {
      "environment.status": () =>
        environmentStatusFixture({
          principal: null,
          planes: { records: "local", broker: "local", room: "local" },
          setup: { stage: "moving_settings", state: "awaiting_consent" },
        }),
      "environment.host.read": () =>
        Promise.resolve({
          hostId: HOST_ID,
          environment: {
            environmentId: "env-personal",
            ownerKind: "user" as const,
            ownerId: "user-me",
            roomId: "room-personal",
            label: "Personal",
          },
          explicit: false,
          enrolledByUserId: null,
          canUnbind: false,
        }),
    },
  });
  const entry = hostEntryFixture(HOST_ID);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
    "environment.host.read": { major: 1, minor: 0 },
  });
  return {
    client: spine.createRequester(entry),
    requests: () => messenger.calls.map((call) => call.method),
  };
}

function renderWithQueries(ui: React.ReactNode): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("the Overview's settings card slot", () => {
  describe.each(OFF_READINGS)("with $reading", ({ user }) => {
    it("sends no environment.status request and draws no card", async () => {
      authUser.current = { data: user };
      const host = hostFixture();
      renderWithQueries(
        <HostOverviewSettingsCardSlot
          client={host.client}
          hostId={HOST_ID}
          hostName="dev-box"
          usable
        />,
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(host.requests()).toEqual([]);
      expect(document.body.textContent).toBe("");
    });
  });

  it("reads environment.status and draws the card with environments on", async () => {
    authUser.current = { data: RECORD_ON };
    const host = hostFixture();
    renderWithQueries(
      <HostOverviewSettingsCardSlot
        client={host.client}
        hostId={HOST_ID}
        hostName="dev-box"
        usable
      />,
    );

    await waitFor(() => {
      expect(host.requests()).toContain("environment.status");
    });
    await waitFor(() => {
      expect(screen.getByTestId("host-settings-card-local")).toBeTruthy();
    });
  });
});

describe("the Overview's Runs line", () => {
  function renderSection(host: HostFixture): void {
    renderWithQueries(
      <HostEnvironmentSection
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({ hostId: HOST_ID, name: "dev-box" }),
          hostId: HOST_ID,
          status: "ready",
          client: host.client,
        })}
      />,
    );
  }

  describe.each(OFF_READINGS)("with $reading", ({ user }) => {
    it("sends no environment.host.read or environment.status request and draws nothing", async () => {
      authUser.current = { data: user };
      const host = hostFixture();
      renderSection(host);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(host.requests()).toEqual([]);
      expect(screen.queryByTestId("host-environment-section")).toBeNull();
    });
  });

  it("reads both and names the configuration with environments on", async () => {
    authUser.current = { data: RECORD_ON };
    const host = hostFixture();
    renderSection(host);

    expect(await screen.findByTestId("host-environment-section")).toBeTruthy();
    expect(host.requests()).toEqual(
      expect.arrayContaining(["environment.host.read", "environment.status"]),
    );
  });
});
