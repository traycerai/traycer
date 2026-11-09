/** The Overview's settings source row, including the legacy team state. */
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const PERSONAL: EnvironmentDescriptor = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
};

const TEAM: EnvironmentDescriptor = {
  environmentId: "env-team",
  ownerKind: "organization",
  ownerId: "team-1",
  roomId: "room-team",
  label: "Acme",
};

const mocks = vi.hoisted(() => ({
  state: {
    binding: null as EnvironmentHostBinding | null,
    status: null as EnvironmentStatusResponseV11 | null,
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "environment.host.read",
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => ({
    isError: false,
    data: mocks.state.binding ?? undefined,
  }),
}));
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({ data: mocks.state.status }),
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: (hostIds: readonly string[]) =>
    new Map(hostIds.map((hostId) => [hostId, { major: 1, minor: 1 }])),
}));
import { HostEnvironmentSection } from "@/components/settings/panels/host-environment-section";

function makeClient(): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function renderSection(kind: "personal" | "sandbox"): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostEnvironmentSection
        hostName="Mac mini"
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-a",
            name: "Mac mini",
            kind,
            sandbox:
              kind === "sandbox"
                ? {
                    state: "awake",
                    frozen: false,
                    summary: sandboxSummaryFixture({ hostId: "host-a" }),
                    teamOwned: false,
                  }
                : null,
          }),
          client: makeClient(),
        })}
      />
    </QueryClientProvider>,
  );
}

function teamBinding(canUnbind: boolean): EnvironmentHostBinding {
  return {
    hostId: "host-a",
    environment: TEAM,
    explicit: true,
    enrolledByUserId: "user-enroller",
    canUnbind,
  };
}

beforeEach(() => {
  mocks.state.status = environmentStatusFixture({
    principal: { kind: "personal" },
  });
  mocks.state.binding = {
    hostId: "host-a",
    environment: PERSONAL,
    explicit: false,
    enrolledByUserId: null,
    canUnbind: false,
  };
});

afterEach(() => {
  cleanup();
});

describe("HostEnvironmentSection", () => {
  it("shows the current personal source in the selector", () => {
    renderSection("personal");

    const row = screen.getByTestId("host-settings-source");
    expect(row.textContent).toContain("Environment");
    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(within(selector).getByText("Personal")).toBeTruthy();
    expect(within(selector).getByText("Runs Personal").className).toContain(
      "in-data-[slot=select-trigger]:hidden",
    );
    expect(within(row).getByText("Details")).toBeTruthy();
    expect(screen.queryByText(/team's bots run/)).toBeNull();
    expect(screen.queryByText(/Machines in/)).toBeNull();
  });

  it("shows a legacy team source in the disabled selector", () => {
    mocks.state.binding = teamBinding(false);

    renderSection("personal");

    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(selector.textContent).toBe("Acme");
    expect(selector.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Runs the team's settings.")).toBeTruthy();
  });

  it("shows move progress instead of another source line while settings move", () => {
    mocks.state.status = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
      setup: { stage: "moving_settings", state: "awaiting_consent" },
    });
    renderSection("personal");
    expect(screen.getByText("Environment")).toBeTruthy();
    expect(
      screen.getByText("Runs its own settings, not in Personal yet"),
    ).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(within(selector).getByText("Mac mini")).toBeTruthy();
    expect(within(selector).getByText("Local")).toBeTruthy();
  });

  it("shows nothing on a sandbox when no settings status or binding is available", () => {
    mocks.state.status = null;
    mocks.state.binding = null;
    renderSection("sandbox");

    expect(screen.queryByTestId("host-settings-source")).toBeNull();
  });
});
