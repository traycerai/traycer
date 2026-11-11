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
  SetEnvironmentBotHostResult,
} from "@traycer-clients/shared/host-client/team-computers";
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

const ENVIRONMENT_ID = "env-a";
const OTHER_ENVIRONMENT_ID = "env-b";
const VIEWER_HOST_ID = "host-viewer";
const CURRENT_USER = "user-a";
const OTHER_USER = "user-b";
const hostBinding = vi.hoisted((): { value: unknown } => ({ value: null }));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => hostBinding.value,
  useHostClient: () => requireTeamHostClient(),
}));

const listTeamComputers =
  vi.fn<(environmentId: string) => Promise<TeamComputersResult>>();
const setEnvironmentBotHost =
  vi.fn<
    (
      environmentId: string,
      hostId: string,
      sharingGeneration: number,
    ) => Promise<SetEnvironmentBotHostResult>
  >();
const releaseTeamComputer =
  vi.fn<
    (
      hostId: string,
      environmentId: string,
    ) => Promise<TeamComputerReleaseResult>
  >();
const auth = {
  listTeamComputers,
  setEnvironmentBotHost,
  releaseTeamComputer,
} satisfies Pick<
  AuthService,
  "listTeamComputers" | "setEnvironmentBotHost" | "releaseTeamComputer"
>;
const directory = { refresh: vi.fn(() => Promise.resolve()) };

function computer(overrides: Partial<TeamComputer>): TeamComputer {
  return {
    hostId: "host-computer-a",
    environmentId: ENVIRONMENT_ID,
    hostName: "Studio",
    hostKind: "personal",
    sharingGeneration: 14,
    holdsBotSlot: false,
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

function environment(environmentId: string): EnvironmentDescriptorV11 {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: `team-${environmentId}`,
    roomId: `room-${environmentId}`,
    label: "Acme",
    effectiveRole: "editor",
    kind: "team",
    hostCount: 2,
    providerHandle: `handle-${environmentId}`,
  };
}

function sectionTree(
  harness: TeamPageHarness,
  environmentId: string,
  effectiveRole: "owner" | "admin" | "editor" | null,
): ReactNode {
  return (
    <harness.Wrapper>
      <RunnerHostContext.Provider value={dashboardRunnerHost()}>
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
) {
  const harness = mountTeamPage(sourceFor(environmentId, effectiveRole), {
    "environment.list": () => ({
      environments: [
        environment(ENVIRONMENT_ID),
        environment(OTHER_ENVIRONMENT_ID),
      ],
    }),
  });
  const view = render(sectionTree(harness, environmentId, effectiveRole));
  return { harness, view };
}

function setSignedInUser(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
  });
}

async function openReturnDialog(user: UserEvent) {
  await user.click(
    screen.getByRole("button", { name: "Return this computer to its owner" }),
  );
  return screen.findByRole("dialog");
}

beforeEach(() => {
  hostBinding.value = { auth, directory };
  listTeamComputers.mockReset();
  setEnvironmentBotHost.mockReset();
  releaseTeamComputer.mockReset();
  directory.refresh.mockClear();
  listTeamComputers.mockImplementation((environmentId) =>
    Promise.resolve({
      kind: "ok",
      hosts: [computer({ environmentId })],
    }),
  );
  setEnvironmentBotHost.mockImplementation((environmentId, hostId) =>
    Promise.resolve({
      kind: "ok",
      host: computer({ environmentId, hostId, holdsBotSlot: true }),
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
  it("does not choose a bot host when no computer holds the bot slot", async () => {
    listTeamComputers.mockResolvedValue({
      kind: "ok",
      hosts: [computer({ holdsBotSlot: false })],
    });
    mountSection(ENVIRONMENT_ID, "editor");

    expect(await screen.findByText("No bot host chosen")).toBeTruthy();
    expect(listTeamComputers).toHaveBeenCalledWith(ENVIRONMENT_ID);
  });

  it("refreshes a successful empty list after an external enrollment and uses the new generation", async () => {
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
    setEnvironmentBotHost.mockImplementation(() => {
      const assigned = { ...enrolled, holdsBotSlot: true };
      listTeamComputers.mockResolvedValue({ kind: "ok", hosts: [assigned] });
      return Promise.resolve({ kind: "ok", host: assigned });
    });
    mountSection(ENVIRONMENT_ID, "editor");
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
    const picker = screen.getByRole("combobox", { name: "Bot host" });
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: hostName }));
    await waitFor(() =>
      expect(picker.textContent).toBe(`${hostName} · Current bot host`),
    );
    expect(setEnvironmentBotHost).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      enrolled.hostId,
      42,
    );
  });

  it("shows the current sandbox host and sends the eligible computer's generation without changing the viewing host", async () => {
    const available = computer({
      hostId: "host-available",
      hostName: "Bench",
      sharingGeneration: 29,
    });
    const returned = computer({
      hostId: "host-returning",
      hostName: "Returning computer",
      sharingGeneration: 30,
      purgePending: true,
    });
    const sandbox = computer({
      hostId: "host-sandbox",
      hostName: "Sandbox",
      hostKind: "sandbox",
      holdsBotSlot: true,
    });
    listTeamComputers.mockResolvedValue({
      kind: "ok",
      hosts: [available, returned, sandbox],
    });
    const pick = { kind: "team", environmentId: ENVIRONMENT_ID } as const;
    const viewingHost = { hostId: VIEWER_HOST_ID, name: "Viewing computer" };
    useSettingsHostScopeStore.getState().selectHost(pick, viewingHost);
    mountSection(ENVIRONMENT_ID, "editor");
    const user = userEvent.setup();

    expect(await screen.findByText("Sandbox")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "Bot host" }));
    const returningOption = await screen.findByRole("option", {
      name: /Returning computer/,
    });
    expect(screen.queryByRole("option", { name: /Sandbox/ })).toBeNull();
    expect(returningOption.getAttribute("aria-disabled")).toBe("true");
    await user.click(await screen.findByRole("option", { name: "Bench" }));

    await waitFor(() =>
      expect(setEnvironmentBotHost).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        "host-available",
        29,
      ),
    );
    expect(useSettingsHostScopeStore.getState().hostByEnvironment).toEqual({
      "team:env-a": viewingHost,
    });
  });

  it("lets an editor open the return confirmation and posts only after confirmation", async () => {
    const pending = Promise.withResolvers<TeamComputerReleaseResult>();
    releaseTeamComputer.mockReturnValue(pending.promise);
    mountSection(ENVIRONMENT_ID, "editor");
    const user = userEvent.setup();

    expect(
      await screen.findByRole("button", {
        name: "Return this computer to its owner",
      }),
    ).toBeTruthy();
    await openReturnDialog(user);
    expect(
      screen.getByRole("heading", { name: "Return Studio to its owner?" }),
    ).toBeTruthy();
    expect(releaseTeamComputer).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Return computer" }));

    const confirm = screen.getByRole("button", { name: "Return computer" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));
    expect(
      confirm.querySelector('[data-testid="team-computer-return-progress"]'),
    ).not.toBeNull();
    await act(async () => {
      pending.resolve({ kind: "ok" });
      await pending.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await waitFor(() =>
      expect(releaseTeamComputer).toHaveBeenCalledWith(
        "host-computer-a",
        ENVIRONMENT_ID,
      ),
    );
  });

  it("does not offer return or add actions to an unknown role", async () => {
    mountSection(ENVIRONMENT_ID, null);

    await screen.findByText("Studio");
    expect(
      screen.queryByRole("button", {
        name: "Return this computer to its owner",
      }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a computer" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows a fixed error when returning a computer fails", async () => {
    releaseTeamComputer.mockResolvedValue({ kind: "network-error" });
    mountSection(ENVIRONMENT_ID, "editor");
    const user = userEvent.setup();

    await screen.findByRole("button", {
      name: "Return this computer to its owner",
    });
    await openReturnDialog(user);
    await user.click(screen.getByRole("button", { name: "Return computer" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Could not return this computer. Refresh the list to check what changed.",
    );
    expect(releaseTeamComputer).toHaveBeenCalledWith(
      "host-computer-a",
      ENVIRONMENT_ID,
    );
  });

  it("clears return confirmation when the signed-in account changes", async () => {
    mountSection(ENVIRONMENT_ID, "editor");
    const user = userEvent.setup();
    await screen.findByRole("button", {
      name: "Return this computer to its owner",
    });
    await openReturnDialog(user);

    act(() => setSignedInUser(OTHER_USER));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears return confirmation when the selected environment changes", async () => {
    const { harness, view } = mountSection(ENVIRONMENT_ID, "editor");
    const user = userEvent.setup();
    await screen.findByRole("button", {
      name: "Return this computer to its owner",
    });
    await openReturnDialog(user);

    view.rerender(sectionTree(harness, OTHER_ENVIRONMENT_ID, "editor"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(listTeamComputers).toHaveBeenCalledWith(OTHER_ENVIRONMENT_ID),
    );
  });
});
