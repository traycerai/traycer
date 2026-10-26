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

// The preview-features verdict per feature; a case sets it, every other runs on.
const previewVerdict = vi.hoisted(
  (): { current: Record<"environments" | "sandboxes" | "bots", "on" | "off" | "unread"> } => ({
    current: { environments: "on", sandboxes: "on", bots: "on" },
  }),
);
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: (feature: "environments" | "sandboxes" | "bots") =>
    previewVerdict.current[feature],
}));

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

  it("says a computer with a Local row runs its own settings, and a moved one keeps Runs Personal", () => {
    mocks.state.status = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
      setup: { stage: "moving_settings", state: "awaiting_consent" },
    });
    renderSection("personal");
    expect(screen.getByTestId("host-environment-section").textContent).toBe(
      "Runs its own settings, not in Personal yet",
    );
    cleanup();

    mocks.state.status = environmentStatusFixture({
      principal: { kind: "personal" },
    });
    renderSection("personal");
    expect(screen.getByTestId("host-environment-section").textContent).toBe(
      "Runs Personal",
    );
  });

  it("shows nothing on a sandbox host", () => {
    renderSection("sandbox");

    expect(screen.queryByTestId("host-environment-section")).toBeNull();
  });
});
