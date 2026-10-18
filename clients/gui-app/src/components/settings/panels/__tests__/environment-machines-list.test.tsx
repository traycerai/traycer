/**
 * The machines each team runs bots on (Tracy Bots), as Settings' admin
 * surface: a team's sandboxes read "Team machine", the reader's own machines
 * read "Yours", and another member's machine carries neither.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptor,
  EnvironmentHostRecord,
} from "@traycer/protocol/host/environment/contracts";
import { useAuthStore } from "@/stores/auth/auth-store";

const TEAM: EnvironmentDescriptor = {
  environmentId: "env-team",
  ownerKind: "organization",
  ownerId: "team-1",
  roomId: "room-team",
  label: "Acme",
};

const PERSONAL: EnvironmentDescriptor = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
};

const mocks = vi.hoisted(() => ({
  hostLists: new Map<string, ReadonlyArray<EnvironmentHostRecord>>(),
}));

vi.mock("@/hooks/bots/use-environment-host-lists-query", () => ({
  useEnvironmentHostLists: () => mocks.hostLists,
}));

import { EnvironmentMachinesList } from "@/components/settings/panels/environment-machines-list";

function machine(
  overrides: Partial<EnvironmentHostRecord> & { readonly hostId: string },
): EnvironmentHostRecord {
  return {
    hostLabel: overrides.hostId,
    hostPlatform: null,
    enrolledByUserId: "user-someone-else",
    kind: "personal",
    boundAt: 1,
    ...overrides,
  };
}

function renderList(): void {
  render(
    <EnvironmentMachinesList
      client={null}
      environments={[PERSONAL, TEAM]}
      enabled
    />,
  );
}

function row(hostId: string): HTMLElement {
  const found = screen
    .getAllByTestId("environment-machine")
    .find((el) => el.getAttribute("data-host-id") === hostId);
  if (found === undefined) throw new Error(`no row for ${hostId}`);
  return found;
}

beforeEach(() => {
  mocks.hostLists = new Map();
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-me", userName: "Me", email: "me@example.com" },
      { userId: "user-me", username: "Me" },
      [],
    );
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

describe("EnvironmentMachinesList", () => {
  it("marks a sandbox Team machine and the reader's own machine Yours, and nothing else", () => {
    mocks.hostLists = new Map([
      [
        TEAM.environmentId,
        [
          machine({ hostId: "sandbox-1", kind: "sandbox" }),
          machine({ hostId: "mine", enrolledByUserId: "user-me" }),
          machine({ hostId: "theirs", enrolledByUserId: "user-colleague" }),
        ],
      ],
    ]);

    renderList();

    const group = screen.getByRole("region", { name: "Machines in Acme" });
    expect(within(group).getAllByTestId("environment-machine")).toHaveLength(3);
    expect(within(row("sandbox-1")).getByText("Team machine")).toBeTruthy();
    expect(within(row("sandbox-1")).queryByText("Yours")).toBeNull();
    expect(within(row("mine")).getByText("Yours")).toBeTruthy();
    expect(within(row("mine")).queryByText("Team machine")).toBeNull();
    expect(within(row("theirs")).queryByText("Yours")).toBeNull();
    expect(within(row("theirs")).queryByText("Team machine")).toBeNull();
  });

  it("says no machine runs the team's bots when the team's list is empty", () => {
    mocks.hostLists = new Map([[TEAM.environmentId, []]]);

    renderList();

    expect(screen.getByText("No machines run Acme's bots yet.")).toBeTruthy();
    expect(screen.queryAllByTestId("environment-machine")).toEqual([]);
  });
});
