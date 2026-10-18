import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

// The capability gate and the three environment hooks are the section's only
// data sources; the section itself is the real component.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));

const PERSONAL: EnvironmentDescriptor = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
};
const TEAM: EnvironmentDescriptor = {
  environmentId: "env-acme",
  ownerKind: "organization",
  ownerId: "team-acme",
  roomId: "room-acme",
  label: "acme",
};
const BINDING: EnvironmentHostBinding = {
  hostId: "host-a",
  environment: PERSONAL,
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    isError: false,
    data: { environments: [PERSONAL, TEAM] },
  }),
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => ({ isError: false, data: BINDING }),
}));
vi.mock("@/hooks/bots/use-environment-host-bind-mutation", () => ({
  useEnvironmentHostBindMutation: () => ({
    isPending: false,
    variables: undefined,
    error: null,
    mutate: () => undefined,
  }),
}));

import { HostEnvironmentSection } from "@/components/settings/panels/host-environment-section";

afterEach(cleanup);

const { client } = buildEnvironmentClient({ hostId: "host-a", handlers: {} });

function scopeOfKind(kind: "sandbox" | "personal"): HostScope {
  const host = hostScopeOptionFixture({
    hostId: "host-a",
    kind,
    isLocalMachine: false,
    sandbox:
      kind === "sandbox"
        ? {
            state: "awake",
            frozen: false,
            summary: sandboxSummaryFixture({ hostId: "host-a" }),
            teamOwned: false,
          }
        : null,
  });
  return hostScopeFixture({ host, status: "ready", client });
}

describe("HostEnvironmentSection", () => {
  it("offers no environment to bind on a sandbox host", () => {
    render(<HostEnvironmentSection scope={scopeOfKind("sandbox")} />);

    expect(screen.queryAllByTestId("host-environment-option")).toHaveLength(0);
  });

  it("control: offers every environment to bind on a personal host", () => {
    render(<HostEnvironmentSection scope={scopeOfKind("personal")} />);

    const options = screen.getAllByTestId("host-environment-option");
    expect(
      options.map((option) => option.getAttribute("data-environment-id")),
    ).toEqual(["env-personal", "env-acme"]);
  });
});
