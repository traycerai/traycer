/**
 * The Settings host-environment picker (Tracy Bots): a sandbox shows nothing
 * (a team's sandbox is placed in its team at create); another member's team
 * binding is shown, never changed; any other host is offered the personal
 * environment, plus the one it reports now (a team's bots run on the team's
 * machines).
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const OTHER_TEAM: EnvironmentDescriptor = {
  environmentId: "env-other-team",
  ownerKind: "organization",
  ownerId: "team-2",
  roomId: "room-other-team",
  label: "Globex",
};

const mocks = vi.hoisted(() => ({
  bindMutate: vi.fn<(variables: { readonly environmentId: string }) => void>(),
  state: {
    binding: null as EnvironmentHostBinding | null,
    environments: [] as ReadonlyArray<EnvironmentDescriptor>,
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  // The binding reads are supported; the machine list is left out so this
  // suite stays on the picker (`environment-machines-list.test.tsx` owns it).
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "environment.host.read",
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    isError: false,
    data: { environments: mocks.state.environments },
  }),
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => ({
    isError: false,
    data: mocks.state.binding ?? undefined,
  }),
}));
vi.mock("@/hooks/bots/use-environment-host-bind-mutation", () => ({
  useEnvironmentHostBindMutation: () => ({
    mutate: mocks.bindMutate,
    isPending: false,
    variables: undefined,
    error: null,
  }),
}));
vi.mock("@/hooks/bots/use-environment-host-lists-query", () => ({
  useEnvironmentHostLists: () => ({
    hostsByEnvironmentId: new Map(),
    failedEnvironmentIds: new Set<string>(),
    retryFailed: () => undefined,
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

function optionFor(environmentId: string): HTMLElement {
  const option = screen
    .getAllByTestId("host-environment-option")
    .find((el) => el.getAttribute("data-environment-id") === environmentId);
  if (option === undefined) {
    throw new Error(`no option for ${environmentId}`);
  }
  return option;
}

function optionIds(): string[] {
  return screen
    .getAllByTestId("host-environment-option")
    .map((el) => el.getAttribute("data-environment-id") ?? "");
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
  mocks.bindMutate.mockReset();
  mocks.state.environments = [PERSONAL, TEAM, OTHER_TEAM];
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

describe("HostEnvironmentSection lock", () => {
  it("locks the options and names the lock to a member who did not add the machine", () => {
    mocks.state.binding = teamBinding(false);

    renderSection("personal");

    expect(screen.getByTestId("host-environment-locked").textContent).toBe(
      "Only the member who added this machine to Acme can change it.",
    );
    expect(optionFor(PERSONAL.environmentId).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("leaves the options open to the member who added the machine", () => {
    mocks.state.binding = teamBinding(true);

    renderSection("personal");

    expect(screen.queryByTestId("host-environment-locked")).toBeNull();
    expect(optionFor(PERSONAL.environmentId).hasAttribute("disabled")).toBe(
      false,
    );
  });
});

describe("HostEnvironmentSection team hosts only", () => {
  it("offers a personal host only the personal environment, and says where a team's bots run", () => {
    renderSection("personal");

    expect(optionIds()).toEqual([PERSONAL.environmentId]);
    expect(
      screen.getByTestId("host-environment-team-hosts-only").textContent,
    ).toBe("A team's bots run on the team's machines.");
  });

  it("shows nothing on a sandbox host", () => {
    renderSection("sandbox");

    expect(screen.queryByTestId("host-environment-section")).toBeNull();
    expect(screen.queryAllByTestId("host-environment-option")).toHaveLength(0);
  });

  it("says where a team's bots run on a personal host though the reader belongs to no team, so nothing is hidden", () => {
    mocks.state.environments = [PERSONAL];
    renderSection("personal");

    expect(optionIds()).toEqual([PERSONAL.environmentId]);
    expect(screen.getByTestId("host-environment-team-hosts-only")).toBeTruthy();
  });

  it("says where a team's bots run on a personal host bound to the reader's only team, so nothing is hidden", () => {
    mocks.state.environments = [PERSONAL, TEAM];
    mocks.state.binding = teamBinding(true);
    renderSection("personal");

    expect(optionIds()).toEqual([PERSONAL.environmentId, TEAM.environmentId]);
    expect(screen.getByTestId("host-environment-team-hosts-only")).toBeTruthy();
  });

  it("keeps the team a personal host currently reports, marked, and hides the other teams", () => {
    mocks.state.binding = teamBinding(true);
    renderSection("personal");

    expect(optionIds()).toEqual([PERSONAL.environmentId, TEAM.environmentId]);
    expect(optionFor(TEAM.environmentId).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("host-environment-team-hosts-only")).toBeTruthy();
  });
});

describe("HostEnvironmentSection bind", () => {
  it("returns to the personal environment without asking", async () => {
    mocks.state.binding = teamBinding(true);
    renderSection("personal");

    await userEvent.click(optionFor(PERSONAL.environmentId));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.bindMutate).toHaveBeenCalledWith({
      environmentId: PERSONAL.environmentId,
    });
  });
});
