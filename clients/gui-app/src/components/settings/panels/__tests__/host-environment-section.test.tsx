/**
 * The Overview's one line naming the configuration a host runs: `Runs
 * Personal`, or `Runs <team label>` for a host an earlier build bound to a
 * team. A sandbox shows nothing.
 */
import { cleanup, render, screen } from "@testing-library/react";
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
  render(
    <HostEnvironmentSection
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
    />,
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
  it("says Runs Personal for a host on the personal environment, with nothing to pick", () => {
    renderSection("personal");

    expect(screen.getByTestId("host-environment-section").textContent).toBe(
      "Runs Personal",
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/team's bots run/)).toBeNull();
    expect(screen.queryByText(/Machines in/)).toBeNull();
  });

  it("names the team a host an earlier build bound to one runs", () => {
    mocks.state.binding = teamBinding(false);

    renderSection("personal");

    expect(screen.getByTestId("host-environment-section").textContent).toBe(
      "Runs Acme",
    );
  });

  it("shows nothing on a sandbox host", () => {
    renderSection("sandbox");

    expect(screen.queryByTestId("host-environment-section")).toBeNull();
  });
});
