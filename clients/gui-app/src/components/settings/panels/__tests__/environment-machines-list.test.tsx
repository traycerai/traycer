/**
 * The machines each team runs bots on (Tracy Bots), as Settings' admin
 * surface: a team's sandboxes read "Team machine", the reader's own machines
 * read "Yours", and another member's machine carries neither.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  failedIds: new Set<string>(),
  retryFailed: vi.fn<() => void>(),
}));

vi.mock("@/hooks/bots/use-environment-host-lists-query", () => ({
  useEnvironmentHostLists: () => ({
    hostsByEnvironmentId: mocks.hostLists,
    failedEnvironmentIds: mocks.failedIds,
    retryFailed: mocks.retryFailed,
  }),
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
  vi.clearAllMocks();
  mocks.hostLists = new Map();
  mocks.failedIds = new Set();
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

  it("says the team's machines could not be loaded when the list failed, and Retry asks again", async () => {
    const user = userEvent.setup();
    mocks.failedIds = new Set([TEAM.environmentId]);

    renderList();

    const notice = screen.getByTestId("environment-machines-failed");
    expect(notice.textContent).toContain("Couldn't load Acme's machines.");
    // A failure is not the same fact as an empty team.
    expect(screen.queryByText("No machines run Acme's bots yet.")).toBeNull();
    expect(screen.queryAllByTestId("environment-machine")).toEqual([]);

    expect(mocks.retryFailed).not.toHaveBeenCalled();
    await user.click(within(notice).getByRole("button", { name: "Retry" }));
    expect(mocks.retryFailed).toHaveBeenCalledTimes(1);
  });

  it("shows neither the failure notice nor the empty-state copy while the list has not answered", () => {
    renderList();

    expect(
      screen.getByRole("region", { name: "Machines in Acme" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("environment-machines-failed")).toBeNull();
    expect(screen.queryByText("No machines run Acme's bots yet.")).toBeNull();
    expect(screen.queryAllByTestId("environment-machine")).toEqual([]);
  });
});
