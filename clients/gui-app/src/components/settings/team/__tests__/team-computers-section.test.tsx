import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type {
  TeamComputer,
  TeamComputersResult,
} from "@traycer-clients/shared/host-client/team-computers";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { TeamComputerReleaseResult } from "@traycer-clients/shared/host-client/team-computer-release";
import type { AuthService } from "@/lib/auth/auth-service";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { TeamComputersSection } from "@/components/settings/team/team-computers-section";
import {
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { RunnerHostContext } from "@/providers/runner-host-context";
import type { ClaimRunningChats } from "@/components/settings/team/claim-running-chats";

const ENVIRONMENT_ID = "env-a";
const OTHER_ENVIRONMENT_ID = "env-b";
const CURRENT_USER = "user-a";
const OTHER_USER = "user-b";
const hostBinding = vi.hoisted((): { value: unknown } => ({ value: null }));
const noteHostMembershipChanged = vi.hoisted(() =>
  vi.fn<(hostId: string) => void>(),
);

const runningChatsAnswer = vi.hoisted(
  (): { value: ClaimRunningChats | null } => ({ value: null }),
);

vi.mock("@/lib/host/local-admission-invalidation", () => ({
  noteHostMembershipChanged,
}));

// The host's `{ kind: "computer" }` subject is not on the stack yet, so a
// count can only come from here; `null` leaves the real read in place.
vi.mock(
  "@/components/settings/team/claim-running-chats",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/team/claim-running-chats")
      >();
    return {
      ...actual,
      useClaimRunningChats: (hostId: string | null): ClaimRunningChats =>
        runningChatsAnswer.value ?? actual.useClaimRunningChats(hostId),
    };
  },
);

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => hostBinding.value,
  useHostClient: () => requireTeamHostClient(),
}));

const listTeamComputers =
  vi.fn<(environmentId: string) => Promise<TeamComputersResult>>();
const releaseTeamComputer =
  vi.fn<
    (
      hostId: string,
      environmentId: string,
    ) => Promise<TeamComputerReleaseResult>
  >();
const auth = {
  listTeamComputers,
  releaseTeamComputer,
} satisfies Pick<AuthService, "listTeamComputers" | "releaseTeamComputer">;
const directory = { refresh: vi.fn(() => Promise.resolve()) };

function computer(overrides: Partial<TeamComputer>): TeamComputer {
  return {
    hostId: "host-computer-a",
    environmentId: ENVIRONMENT_ID,
    hostName: "Studio",
    hostKind: "personal",
    sharingGeneration: 14,
    purgePending: false,
    ...overrides,
  };
}

function sourceFor(
  environmentId: string,
  effectiveRole: "owner" | "admin" | "editor" | null,
): ConfigurationSource {
  return {
    kind: "pool",
    configuration: "team",
    environmentId,
    roomId: `room-${environmentId}`,
    providerHandle: `handle-${environmentId}`,
    effectiveRole,
  };
}

function environment(
  environmentId: string,
  providerHandle: string | null,
): EnvironmentDescriptorV11 {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: `team-${environmentId}`,
    roomId: `room-${environmentId}`,
    label: "Acme",
    effectiveRole: "editor",
    kind: "team",
    hostCount: 2,
    providerHandle,
  };
}

function sectionTree(
  harness: TeamPageHarness,
  environmentId: string,
  effectiveRole: "owner" | "admin" | "editor" | null,
  runnerHost: IRunnerHost,
): ReactNode {
  return (
    <harness.Wrapper>
      <RunnerHostContext.Provider value={runnerHost}>
        <ConfigurationSourceContext.Provider
          value={sourceFor(environmentId, effectiveRole)}
        >
          <TeamComputersSection environmentId={environmentId} />
        </ConfigurationSourceContext.Provider>
      </RunnerHostContext.Provider>
    </harness.Wrapper>
  );
}

function mountSection(
  environmentId: string,
  effectiveRole: "owner" | "admin" | "editor" | null,
  providerHandle: string | null,
) {
  const harness = mountTeamPage(sourceFor(environmentId, effectiveRole), {
    "environment.list": () => ({
      environments: [
        environment(ENVIRONMENT_ID, providerHandle),
        environment(OTHER_ENVIRONMENT_ID, `handle-${OTHER_ENVIRONMENT_ID}`),
      ],
    }),
  });
  const runnerHost = dashboardRunnerHost();
  const view = render(
    sectionTree(harness, environmentId, effectiveRole, runnerHost),
  );
  return { harness, view, runnerHost };
}

function setSignedInUser(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
  });
}

async function openClaimDialog(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: "Claim this computer" }));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  hostBinding.value = { auth, directory };
  runningChatsAnswer.value = null;
  listTeamComputers.mockReset();
  releaseTeamComputer.mockReset();
  noteHostMembershipChanged.mockReset();
  directory.refresh.mockClear();
  listTeamComputers.mockImplementation((environmentId) =>
    Promise.resolve({
      kind: "ok",
      hosts: [computer({ environmentId })],
    }),
  );
  releaseTeamComputer.mockResolvedValue({ kind: "ok" });
  setSignedInUser(CURRENT_USER);
  useSettingsHostScopeStore.getState().reset();
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  hostBinding.value = null;
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
  useSettingsHostScopeStore.getState().reset();
});

describe("TeamComputersSection", () => {
  it("shows the translated list error and keeps Refresh available to retry it", async () => {
    const host = computer({ hostId: "host-after-refresh", hostName: "Ready" });
    listTeamComputers
      .mockResolvedValueOnce({ kind: "unauthorized" })
      .mockResolvedValueOnce({ kind: "ok", hosts: [host] });
    mountSection(ENVIRONMENT_ID, "editor", `handle-${ENVIRONMENT_ID}`);

    expect(
      await screen.findByText("Sign in again to manage this team's computers."),
    ).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await userEvent.setup().click(refresh);

    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(listTeamComputers).toHaveBeenCalledTimes(2);
  });

  it("prints install and use commands with the team's provider handle", async () => {
    mountSection(ENVIRONMENT_ID, "owner", `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Add a computer" }),
    );

    expect(screen.getByTestId("team-computers-add-command").textContent).toBe(
      "traycer host install --team handle-env-a",
    );
    expect(screen.getByText(/Already installed\? Run/).textContent).toContain(
      "traycer host use handle-env-a",
    );
  });

  it("does not offer a command when the team has no provider handle", async () => {
    mountSection(ENVIRONMENT_ID, "owner", null);

    await waitFor(() =>
      expect(listTeamComputers).toHaveBeenCalledWith(ENVIRONMENT_ID),
    );
    expect(screen.queryByRole("button", { name: "Add a computer" })).toBeNull();
  });

  it("refreshes a successful empty list after an external enrollment", async () => {
    const hostName = "New computer";
    const enrolled = computer({
      hostId: "host-new-computer",
      hostName,
      sharingGeneration: 42,
    });
    const refreshed = Promise.withResolvers<TeamComputersResult>();
    listTeamComputers
      .mockResolvedValue({ kind: "ok", hosts: [enrolled] })
      .mockResolvedValueOnce({ kind: "ok", hosts: [] })
      .mockReturnValueOnce(refreshed.promise);
    mountSection(ENVIRONMENT_ID, "editor", `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();

    expect(await screen.findByText("This team has no computers.")).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await user.click(refresh);
    await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(true));
    expect(
      within(refresh).getByTestId("team-computers-refresh-progress"),
    ).toBeTruthy();
    await act(async () => {
      refreshed.resolve({ kind: "ok", hosts: [enrolled] });
      await refreshed.promise;
    });

    const row = await screen.findByRole("listitem");
    expect(within(row).getByText(hostName)).toBeTruthy();
  });

  it("lets a team member claim a computer after confirming", async () => {
    const pending = Promise.withResolvers<TeamComputerReleaseResult>();
    releaseTeamComputer.mockReturnValue(pending.promise);
    mountSection(ENVIRONMENT_ID, "editor", `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();

    expect(
      await screen.findByRole("button", {
        name: "Claim this computer",
      }),
    ).toBeTruthy();
    const dialog = await openClaimDialog(user);
    expect(screen.getByRole("heading", { name: "Claim Studio?" })).toBeTruthy();
    expect(
      screen.getByText(
        "This computer will become yours. The team will lose access to it.",
      ),
    ).toBeTruthy();
    expect(releaseTeamComputer).not.toHaveBeenCalled();

    await user.click(
      within(dialog).getByRole("button", { name: "Claim this computer" }),
    );

    const confirm = screen.getByRole("button", { name: "Claim this computer" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));
    expect(
      confirm.querySelector('[data-testid="team-computer-claim-progress"]'),
    ).not.toBeNull();
    await act(async () => {
      pending.resolve({ kind: "ok" });
      await pending.promise;
    });
    await waitFor(() =>
      expect(noteHostMembershipChanged).toHaveBeenCalledWith("host-computer-a"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await waitFor(() =>
      expect(releaseTeamComputer).toHaveBeenCalledWith(
        "host-computer-a",
        ENVIRONMENT_ID,
      ),
    );
    expect(noteHostMembershipChanged).toHaveBeenCalledTimes(1);
  });

  it("says running chats will stop when the computer's count is not known", async () => {
    mountSection(ENVIRONMENT_ID, "editor", `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Claim this computer" });

    const dialog = await openClaimDialog(user);

    expect(within(dialog).getByText("Running chats will stop.")).toBeTruthy();
    expect(within(dialog).queryByText(/chats are running/)).toBeNull();
  });

  it("says how many chats will stop when the computer counts them", async () => {
    runningChatsAnswer.value = { kind: "counted", chats: 3 };
    mountSection(ENVIRONMENT_ID, "editor", `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Claim this computer" });

    const dialog = await openClaimDialog(user);

    expect(
      within(dialog).getByText("3 chats are running and will stop."),
    ).toBeTruthy();
    expect(within(dialog).queryByText("Running chats will stop.")).toBeNull();
  });

  it("draws no running-chats line when the computer has none running", async () => {
    runningChatsAnswer.value = { kind: "counted", chats: 0 };
    mountSection(ENVIRONMENT_ID, "editor", `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Claim this computer" });

    const dialog = await openClaimDialog(user);

    expect(
      within(dialog).getByText(
        "This computer will become yours. The team will lose access to it.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/chats are running/)).toBeNull();
    expect(within(dialog).queryByText("Running chats will stop.")).toBeNull();
  });

  it("keeps claiming available when team configuration editing is not authorized", async () => {
    mountSection(ENVIRONMENT_ID, null, `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();

    await screen.findByText("Studio");
    await user.click(
      screen.getByRole("button", { name: "Claim this computer" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Claim this computer" }),
    );
    await waitFor(() =>
      expect(releaseTeamComputer).toHaveBeenCalledWith(
        "host-computer-a",
        ENVIRONMENT_ID,
      ),
    );
    expect(screen.queryByRole("button", { name: "Add a computer" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows a fixed error when claiming a computer fails", async () => {
    releaseTeamComputer.mockResolvedValue({ kind: "network-error" });
    mountSection(ENVIRONMENT_ID, "editor", `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();

    await screen.findByRole("button", { name: "Claim this computer" });
    const dialog = await openClaimDialog(user);
    await user.click(
      within(dialog).getByRole("button", { name: "Claim this computer" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Could not claim this computer. Refresh the list to check what changed.",
    );
    expect(releaseTeamComputer).toHaveBeenCalledWith(
      "host-computer-a",
      ENVIRONMENT_ID,
    );
    expect(noteHostMembershipChanged).not.toHaveBeenCalled();
  });

  it("clears claim confirmation when the signed-in account changes", async () => {
    mountSection(ENVIRONMENT_ID, "editor", `handle-${ENVIRONMENT_ID}`);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Claim this computer" });
    await openClaimDialog(user);

    act(() => setSignedInUser(OTHER_USER));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears claim confirmation when the selected environment changes", async () => {
    const { harness, view, runnerHost } = mountSection(
      ENVIRONMENT_ID,
      "editor",
      `handle-${ENVIRONMENT_ID}`,
    );
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Claim this computer" });
    await openClaimDialog(user);

    view.rerender(
      sectionTree(harness, OTHER_ENVIRONMENT_ID, "editor", runnerHost),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(listTeamComputers).toHaveBeenCalledWith(OTHER_ENVIRONMENT_ID),
    );
  });
});
