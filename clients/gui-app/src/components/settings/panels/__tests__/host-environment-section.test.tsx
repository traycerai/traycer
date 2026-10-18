/**
 * The Settings host-environment picker (Tracy Bots): another member's team
 * binding is shown, never changed; choosing a team asks first, in words that
 * depend on what the host is; the bind fires only after Confirm.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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
import type { HostRegistryKind } from "@traycer/protocol/host/host-status";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

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
  bindMutate: vi.fn<(variables: { readonly environmentId: string }) => void>(),
  state: {
    hostKind: null as HostRegistryKind | null,
    binding: null as EnvironmentHostBinding | null,
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  // The binding reads are supported; the machine list is left out so this
  // suite stays on the picker (`environment-machines-list.test.tsx` owns it).
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "environment.host.read",
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({
    data: {
      hosts:
        mocks.state.hostKind === null
          ? []
          : [{ hostId: "host-a", kind: mocks.state.hostKind }],
    },
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    isError: false,
    data: { environments: [PERSONAL, TEAM] },
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
  useEnvironmentHostLists: () => new Map(),
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

function renderSection(): void {
  render(
    <HostEnvironmentSection
      scope={hostScopeFixture({
        host: hostScopeOptionFixture({ hostId: "host-a", name: "Mac mini" }),
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
  mocks.state.hostKind = null;
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

    renderSection();

    expect(screen.getByTestId("host-environment-locked").textContent).toBe(
      "Only the member who added this machine to Acme can change it.",
    );
    expect(optionFor(PERSONAL.environmentId).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("leaves the options open to the member who added the machine", () => {
    mocks.state.binding = teamBinding(true);

    renderSection();

    expect(screen.queryByTestId("host-environment-locked")).toBeNull();
    expect(optionFor(PERSONAL.environmentId).hasAttribute("disabled")).toBe(
      false,
    );
  });
});

describe("HostEnvironmentSection bind confirmation", () => {
  it.each([
    [
      "personal",
      "Mac mini will run Acme's bots and skills. It stays yours; only you see it here and can change this.",
    ],
    [
      "sandbox",
      "Mac mini becomes Acme's: every member sees it, and the team's bots and tasks can run on it.",
    ],
    [null, "Mac mini will run Acme's bots and skills."],
  ] as const)(
    "words the %s host's confirmation for what binding does to it",
    async (kind, copy) => {
      mocks.state.hostKind = kind;
      renderSection();

      await userEvent.click(optionFor(TEAM.environmentId));

      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByText("Run Acme's bots on Mac mini?"),
      ).toBeTruthy();
      expect(
        within(dialog).getByTestId("host-environment-confirm-copy").textContent,
      ).toBe(copy);
    },
  );

  it("binds the team only after Confirm, and not at all after Cancel", async () => {
    renderSection();

    await userEvent.click(optionFor(TEAM.environmentId));
    expect(mocks.bindMutate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.bindMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(optionFor(TEAM.environmentId));
    await userEvent.click(screen.getByTestId("host-environment-confirm"));
    expect(mocks.bindMutate).toHaveBeenCalledTimes(1);
    expect(mocks.bindMutate).toHaveBeenCalledWith({
      environmentId: TEAM.environmentId,
    });
  });

  it("returns to the personal environment without asking", async () => {
    mocks.state.binding = teamBinding(true);
    renderSection();

    await userEvent.click(optionFor(PERSONAL.environmentId));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.bindMutate).toHaveBeenCalledWith({
      environmentId: PERSONAL.environmentId,
    });
  });
});
