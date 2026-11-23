/**
 * A new team's setup channel: adding a computer shows the team's install
 * command, while Enable cloud runs real sandbox reads and create over a
 * scripted control plane. The rest of the setup channel is in
 * `bot-tab-surface.test.tsx`; the real hook reads a scripted
 * `bot.onboarding.read`.
 */
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botMutationsMock,
  botSubscriptionMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostEnvironmentBindingsMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostClientMock,
  tabHostProviderMock,
  type TeamCloudBinding,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxCreateFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
} from "@traycer/protocol/host/sandbox-control";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { createSandboxRetryWalkFake } from "@/hooks/sandboxes/__tests__/sandbox-retry-walk-fake";
import type { BotOnboardingSetup } from "@traycer/protocol/host/bot/onboarding-schemas";
import {
  admitBotDrafts,
  endBotTabSurfaceCase,
  NEEDS_HOST_SETUP,
  resetBotTabSurfaceMocks,
  scriptTeamControlPlane,
  setUpNewTeam,
  SETUP_BOT_ID,
  TAB_HOST,
} from "./bot-tab-surface-harness";
import { SandboxBillingRuntime } from "@/hooks/sandboxes/__tests__/sandbox-billing-runtime-fixture";
import {
  ACME_TEAM,
  serveEnvironmentList,
} from "@/hooks/sandboxes/__tests__/sandbox-environment-list-fixture";
import { TeamSetupChannel } from "@/components/bots/team-setup-channel";

const billingRoleRead = vi.hoisted(() => ({ viaTransport: false }));
const environmentListRequests: number[] = [];
const sandboxToastSpies = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: sandboxToastSpies.success,
    error: sandboxToastSpies.error,
    info: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
  useHostClient: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);
vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => tabHostClientMock);
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
  }),
);
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", () => botSubscriptionMock);
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/bots/use-environment-list-query")
    >();
  return {
    ...environmentListMock,
    useEnvironmentListQuery: (
      enabled: Parameters<typeof actual.useEnvironmentListQuery>[0],
    ) =>
      billingRoleRead.viaTransport
        ? actual.useEnvironmentListQuery(enabled)
        : environmentListMock.useEnvironmentListQuery(),
  };
});
vi.mock("@/hooks/bots/use-bot-mutations", () => botMutationsMock);
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);
// The setup channel draws none of these, so they are drawn as nothing.
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));
vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: () => null,
}));
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: () => null,
}));
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: () => null,
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => null,
}));
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: () => null,
}));

import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useTeamCloudCreateStore } from "@/stores/bots/team-cloud-create-store";
import { AddComputerDialog } from "@/components/settings/team/add-computer-dialog";

let queryClient = new QueryClient();

function surfaceFor(botId: string | null): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotTabSurface botId={botId} hostId={TAB_HOST} />
      </QueryClientProvider>
    </StrictMode>
  );
}

function teamSetupForBillingRole(
  role: "admin" | "editor" | "viewer",
): ReactNode {
  billingRoleRead.viaTransport = true;
  // The surface reads the scripted binding as the host binding, so the list
  // is served on its auth.
  if (mocks.binding !== null) {
    serveEnvironmentList(mocks.binding.auth, {
      answer: { kind: "ready", role },
      environmentId: "env-new",
      team: ACME_TEAM,
      onRead: () => {
        environmentListRequests.push(1);
      },
    });
  }
  return (
    <SandboxBillingRuntime
      answer={{ kind: "ready", role }}
      environmentId="env-new"
      hostId="billing-host"
      queryClient={queryClient}
      onBinding={null}
      onEnvironmentListRead={() => {
        environmentListRequests.push(1);
      }}
    >
      <StrictMode>
        <TeamSetupChannel
          setup={{
            environmentId: "env-new",
            teamName: "Newco",
            botId: SETUP_BOT_ID,
            title: "Newco",
          }}
          client={null}
          hostId="billing-host"
          level2={null}
          threadsView={{
            shown: false,
            onShow: () => undefined,
            onLeave: () => undefined,
          }}
        />
      </StrictMode>
    </SandboxBillingRuntime>
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetBotTabSurfaceMocks();
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
  billingRoleRead.viaTransport = false;
  environmentListRequests.length = 0;
  sandboxToastSpies.success.mockReset();
  sandboxToastSpies.error.mockReset();
});

describe("<BotTabSurface /> a team's main bot still to be set up", () => {
  beforeEach(() => {
    setUpNewTeam();
    mocks.reads["env-new"] = {
      setup: NEEDS_HOST_SETUP,
    };
  });

  describe("Add a computer", () => {
    beforeEach(async () => {
      scriptTeamControlPlane();
      await admitBotDrafts();
    });

    it("does not offer team commands when the environment has no provider handle", () => {
      mocks.state.environments = mocks.state.environments.map((row) =>
        row.environmentId === "env-new"
          ? { ...row, providerHandle: null }
          : row,
      );
      render(surfaceFor(SETUP_BOT_ID));

      expect(
        screen.queryByRole("button", { name: "Add a computer" }),
      ).toBeNull();
    });

    it("opens the install instructions for the selected team without minting a token", async () => {
      const user = userEvent.setup();
      render(surfaceFor(SETUP_BOT_ID));

      await user.click(screen.getByRole("button", { name: "Add a computer" }));

      expect(
        screen.getByRole("heading", { name: "Add a computer to Newco" }),
      ).toBeTruthy();
      expect(screen.getByText("Run this on the computer.")).toBeTruthy();
      expect(
        screen.getByTestId("team-host-option-machine-command").textContent,
      ).toBe("traycer host install --team newco");
      expect(screen.getByText(/Already installed\? Run/).textContent).toContain(
        "traycer host use newco",
      );
      expect(document.body.textContent).not.toContain("traycer host join");
    });

    it("quotes a selected team safely in both machine commands", async () => {
      const user = userEvent.setup();
      render(
        <AddComputerDialog
          teamName="Newco"
          teamSelector="team one's; echo unsafe"
          unattended={null}
          testId="shell-safe-add-computer"
        />,
      );

      await user.click(screen.getByRole("button", { name: "Add a computer" }));

      expect(screen.getByText(/^macOS and Linux(?: command)?$/)).not.toBeNull();
      expect(
        screen.getByText(/^Windows \(PowerShell\)(?: command)?$/),
      ).not.toBeNull();
      expect(
        screen.getByText(
          "traycer host install --team 'team one'\\''s; echo unsafe'",
        ),
      ).not.toBeNull();
      expect(
        screen.getByText(
          "traycer host install --team 'team one''s; echo unsafe'",
        ),
      ).not.toBeNull();
      expect(screen.getByText(/Already installed\? Run/).textContent).toContain(
        "traycer host use 'team one'\\''s; echo unsafe'",
      );
      expect(screen.getByText(/Already installed\? Run/).textContent).toContain(
        "traycer host use 'team one''s; echo unsafe'",
      );
    });
  });

  describe("while a machine of the team is joining", () => {
    const JOINING_SETUP: BotOnboardingSetup = {
      ...NEEDS_HOST_SETUP,
      state: "host_joining",
      arrival: { kind: "machine" },
    };
    const JOINING_NOTE = "A computer is joining the team.";

    beforeEach(async () => {
      scriptTeamControlPlane();
      await admitBotDrafts();
      // The setup channel's own read is not enabled by the surface: it reads
      // as what the host answered, which the fake host serves from its cache.
      mocks.state.readsCached = true;
    });

    function hostButtons(): readonly HTMLElement[] {
      return [
        within(screen.getByTestId("team-host-option-cloud")).getByRole(
          "button",
          { name: "Enable cloud" },
        ),
        within(screen.getByTestId("team-host-option-machine")).getByRole(
          "button",
          { name: "Add a computer" },
        ),
      ];
    }

    it("holds cloud creation while a machine joins, while the install instructions remain available", async () => {
      mocks.reads["env-new"] = { setup: JOINING_SETUP };
      const view = render(surfaceFor(SETUP_BOT_ID));

      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
      expect(mocks.open).not.toHaveBeenCalled();
      const note = screen.getByTestId("team-host-option-cloud-note");
      expect(note.textContent).toBe(JOINING_NOTE);
      const cloudButton = within(
        screen.getByTestId("team-host-option-cloud"),
      ).getByRole("button", { name: "Enable cloud" });
      expect(cloudButton).toHaveProperty("disabled", true);
      expect(cloudButton.getAttribute("aria-describedby")).toBe(note.id);
      const addComputerButton = hostButtons()[1];
      expect(addComputerButton).toHaveProperty("disabled", false);

      const user = userEvent.setup();
      await user.click(addComputerButton);
      expect(
        screen.getByTestId("team-host-option-machine-command").textContent,
      ).toBe("traycer host install --team newco");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(hostButtons()[0]).toHaveProperty("disabled", true);
      await user.click(hostButtons()[0]);
      expect(mocks.binding?.auth.createSandbox).not.toHaveBeenCalled();

      mocks.reads["env-new"] = { setup: NEEDS_HOST_SETUP };
      // The setup read resumes from the joining state as the host changes it.
      mocks.state.readsCached = true;
      view.rerender(surfaceFor(SETUP_BOT_ID));

      await waitFor(() =>
        expect(hostButtons()[0]).toHaveProperty("disabled", false),
      );
      expect(screen.queryByTestId("team-host-option-cloud-note")).toBeNull();
    });

    it("does not create a sandbox when the available instructions are opened", async () => {
      const user = userEvent.setup();
      mocks.reads["env-new"] = { setup: JOINING_SETUP };
      render(surfaceFor(SETUP_BOT_ID));

      for (const button of hostButtons()) await user.click(button);

      expect(mocks.binding?.auth.createSandbox).not.toHaveBeenCalled();
    });
  });

  describe("Enable cloud", () => {
    beforeEach(async () => {
      scriptTeamControlPlane();
      await admitBotDrafts();
    });

    function auth(): TeamCloudBinding["auth"] {
      if (mocks.binding === null) throw new Error("no binding scripted");
      return mocks.binding.auth;
    }

    function cloudOption(): HTMLElement {
      return screen.getByTestId("team-host-option-cloud");
    }

    function enableButton(): HTMLElement {
      return within(cloudOption()).getByRole("button", {
        name: "Enable cloud",
      });
    }

    function joinedRow(
      sandboxId: string,
      state: "awake" | "destroying" | "destroyed",
    ): SandboxCreateFetchResult {
      return {
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId,
          hostId: `host-${sandboxId}`,
          sandbox: sandboxSummaryFixture({
            id: sandboxId,
            environmentId: "env-new",
            state,
            displayName: "Team bots",
          }),
        },
      };
    }

    it("shows the named refusal when HTTP 200 joins a destroyed credit-gate row", async () => {
      const user = userEvent.setup();
      auth().createSandbox.mockResolvedValue({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: "sbx_team_credit_gate",
          hostId: "host-team-credit-gate",
          sandbox: sandboxSummaryFixture({
            id: "sbx_team_credit_gate",
            environmentId: "env-new",
            state: "destroyed",
            failureCode: "credit-gate",
            displayName: "Team bots",
          }),
        },
      });
      render(surfaceFor(SETUP_BOT_ID));
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );

      await user.click(enableButton());

      expect(
        await within(cloudOption())
          .findByRole("alert")
          .then((alert) => alert.textContent),
      ).toBe("Couldn't start Team bots");
      expect(sandboxToastSpies.success).not.toHaveBeenCalled();
    });

    it("shows the provider failure for an ordinary joined failed HTTP 200", async () => {
      const user = userEvent.setup();
      auth().createSandbox.mockResolvedValue({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: "sbx_team_ordinary_failed",
          hostId: "host-team-ordinary-failed",
          sandbox: sandboxSummaryFixture({
            id: "sbx_team_ordinary_failed",
            environmentId: "env-new",
            state: "failed",
            failureCode: "PROVIDER_CREATE_FAILED",
            displayName: "Team bots",
          }),
        },
      });
      render(surfaceFor(SETUP_BOT_ID));
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );

      await user.click(enableButton());

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Couldn't complete the sandbox action.",
      );
      expect(sandboxToastSpies.success).not.toHaveBeenCalled();
      expect(auth().createSandbox.mock.calls[0]?.[0].displayName).toBe(
        "Team bots",
      );
    });

    it("retries a row-less shape refusal with refreshed defaults under the same team key", async () => {
      const user = userEvent.setup();
      auth()
        .createSandbox.mockResolvedValueOnce(
          refusal(400, SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED),
        )
        .mockResolvedValueOnce({
          kind: "ok",
          accepted: {
            sandboxId: "sbx_team_shape_retry",
            hostId: "host-team-shape-retry",
            sandbox: sandboxSummaryFixture({
              id: "sbx_team_shape_retry",
              environmentId: "env-new",
              displayName: "Team bots",
            }),
          },
        });
      const view = render(surfaceFor(SETUP_BOT_ID));
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );

      await user.click(enableButton());
      expect(
        (await within(cloudOption()).findByRole("alert")).textContent,
      ).toBe("That size is outside what's offered.");
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      expect(auth().createSandbox.mock.calls[0]?.[0]).toMatchObject({
        clientRequestId: "team-setup:env-new",
        cpus: 4,
        memoryMb: 8192,
        diskMb: 40960,
        destroyAfterRestingMinutes: 1_440,
      });

      const defaults = mocks.sandboxDefaults;
      if (defaults.kind !== "ready")
        throw new Error("expected team sandbox defaults");
      const revision = defaults.value.revision;
      if (revision === null)
        throw new Error("expected a versioned defaults catalogue");
      const defaultShape = defaults.value.defaults;
      if (defaultShape === null)
        throw new Error("expected a team sandbox default shape");
      mocks.sandboxDefaults = {
        kind: "ready",
        value: {
          ...defaults.value,
          revision: revision + 1,
          defaults: {
            ...defaultShape,
            cpus: 6,
            memoryMb: 12_288,
            diskMb: 61_440,
            idleMinutes: 30,
            restingMinutes: 720,
          },
        },
      };
      view.rerender(surfaceFor(SETUP_BOT_ID));

      await user.click(enableButton());
      await waitFor(() =>
        expect(sandboxToastSpies.success).toHaveBeenCalledWith(
          "Created Team bots",
        ),
      );
      expect(auth().createSandbox).toHaveBeenCalledTimes(2);
      expect(auth().createSandbox.mock.calls[1]?.[0]).toMatchObject({
        clientRequestId: "team-setup:env-new",
        cpus: 6,
        memoryMb: 12_288,
        diskMb: 61_440,
        idleMinutes: 30,
        destroyAfterRestingMinutes: 720,
      });
    });

    it("stops at a joined destroying hop and restarts the next press from the team's key", async () => {
      const user = userEvent.setup();
      const firstHop = Promise.withResolvers<SandboxCreateFetchResult>();
      const transitionHop = Promise.withResolvers<SandboxCreateFetchResult>();
      const restartedPress = Promise.withResolvers<SandboxCreateFetchResult>();
      auth()
        .createSandbox.mockImplementationOnce(() => firstHop.promise)
        .mockImplementationOnce(() => transitionHop.promise)
        .mockImplementationOnce(() => restartedPress.promise)
        .mockResolvedValueOnce(joinedRow("team-holder-2", "destroyed"))
        .mockResolvedValueOnce({
          kind: "ok",
          accepted: {
            sandboxId: "team-awake-row",
            hostId: "host-team-awake-row",
            sandbox: sandboxSummaryFixture({
              id: "team-awake-row",
              environmentId: "env-new",
              displayName: "Team bots",
            }),
          },
        });
      render(surfaceFor(SETUP_BOT_ID));
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );

      await user.click(enableButton());
      await waitFor(() =>
        expect(auth().createSandbox).toHaveBeenCalledTimes(1),
      );
      expect(enableButton()).toHaveProperty("disabled", true);
      act(() => firstHop.resolve(joinedRow("team-holder-1", "destroyed")));
      await waitFor(() =>
        expect(auth().createSandbox).toHaveBeenCalledTimes(2),
      );
      act(() =>
        transitionHop.resolve(joinedRow("team-holder-2", "destroying")),
      );

      expect(
        (await within(cloudOption()).findByRole("alert")).textContent,
      ).toBe("This sandbox is changing state. Try again in a moment.");
      expect(sandboxToastSpies.success).not.toHaveBeenCalled();
      expect(auth().createSandbox).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      expect(
        auth().createSandbox.mock.calls.map(
          ([request]) => request.clientRequestId,
        ),
      ).toEqual(["team-setup:env-new", "retry:team-holder-1"]);

      await user.click(enableButton());
      await waitFor(() =>
        expect(auth().createSandbox).toHaveBeenCalledTimes(3),
      );
      const restartedKey =
        auth().createSandbox.mock.calls[2]?.[0].clientRequestId;
      act(() =>
        restartedPress.resolve(joinedRow("team-holder-1", "destroyed")),
      );
      expect(restartedKey).toBe("team-setup:env-new");
      await waitFor(() =>
        expect(sandboxToastSpies.success).toHaveBeenCalledWith(
          "Created Team bots",
        ),
      );
      expect(
        auth().createSandbox.mock.calls.map(
          ([request]) => request.clientRequestId,
        ),
      ).toEqual([
        "team-setup:env-new",
        "retry:team-holder-1",
        "team-setup:env-new",
        "retry:team-holder-1",
        "retry:team-holder-2",
      ]);
    });

    it("creates the team's kept sandbox in the team's environment, in the configuration's default shape and region, holding the button while it is created", async () => {
      const user = userEvent.setup();
      let answer: (result: SandboxCreateFetchResult) => void = () => undefined;
      auth().createSandbox.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      render(surfaceFor(SETUP_BOT_ID));

      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      await user.click(enableButton());

      expect(auth().createSandbox.mock.calls[0]?.[0]).toMatchObject({
        os: "linux",
        cpus: 4,
        memoryMb: 8192,
        diskMb: 40960,
        region: "us-east",
        displayName: "Team bots",
        idleMinutes: 45,
        burst: false,
        createdByHostId: null,
        createdByAgentId: null,
        environmentId: "env-new",
        destroyAfterRestingMinutes: 1_440,
        createdByTaskId: null,
      });
      expect(auth().createSandbox.mock.calls[0]?.[0].clientRequestId).toBe(
        "team-setup:env-new",
      );
      expect(auth().createSandbox).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", true),
      );
      await user.click(enableButton());
      expect(auth().createSandbox).toHaveBeenCalledTimes(1);

      // The created sandbox is listed once the create is answered.
      auth().listSandboxes.mockResolvedValue({
        kind: "ok",
        response: {
          sandboxes: [
            sandboxSummaryFixture({
              environmentId: "env-new",
              state: "creating",
              burst: false,
            }),
          ],
        },
      });
      act(() => {
        answer({
          kind: "ok",
          accepted: {
            sandboxId: "sbx_1",
            hostId: "host-sbx-1",
            sandbox: sandboxSummaryFixture({ environmentId: "env-new" }),
          },
        });
      });

      await waitFor(() =>
        expect(
          within(cloudOption()).getByTestId("team-host-option-cloud-note")
            .textContent,
        ).toBe(
          "The team has a cloud sandbox. Its bots start once it's running.",
        ),
      );
      expect(enableButton()).toHaveProperty("disabled", true);
    });

    it.each([
      ["window A first sees awake", 0, "awake"],
      ["window A first sees failed", 0, "failed"],
      ["window B first sees awake", 1, "awake"],
      ["window B first sees failed", 1, "failed"],
    ] as const)(
      "joins each held key across both windows when %s",
      async (_arrival, firstWindowIndex, firstState) => {
        const user = userEvent.setup();
        const walk = createSandboxRetryWalkFake(
          "team-setup:env-new",
          "env-new",
        );
        auth().createSandbox.mockImplementation(walk.create);

        const firstWindow = render(teamSetupForBillingRole("editor"));
        const firstButton = await within(firstWindow.container).findByRole(
          "button",
          { name: "Enable cloud" },
        );
        await waitFor(() =>
          expect(firstButton).toHaveProperty("disabled", false),
        );
        queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        const secondWindow = render(teamSetupForBillingRole("editor"));
        const secondButton = await within(secondWindow.container).findByRole(
          "button",
          { name: "Enable cloud" },
        );
        await waitFor(() =>
          expect(secondButton).toHaveProperty("disabled", false),
        );
        const firstInOrder =
          firstWindowIndex === 0 ? firstButton : secondButton;
        const secondInOrder =
          firstWindowIndex === 0 ? secondButton : firstButton;
        await user.click(firstInOrder);
        useTeamCloudCreateStore.setState({ byEnvironmentId: {} });
        await user.click(secondInOrder);

        const oneWalk = [
          "team-setup:env-new",
          "retry:holder-1",
          "retry:holder-2",
          "retry:holder-3",
          "retry:holder-4",
          "retry:holder-5",
        ];
        for (let step = 0; step < 4; step += 1) {
          const key = oneWalk.at(step);
          if (key === undefined) throw new Error("expected a walk key");
          await Promise.all([
            walk.waitForArrival(key, 1),
            walk.waitForArrival(key, 2),
          ]);
          expect(firstButton).toHaveProperty("disabled", true);
          expect(secondButton).toHaveProperty("disabled", true);
          act(() => {
            walk.answer(key, 1, { state: "destroyed" });
            walk.answer(key, 2, { state: "destroyed" });
          });
        }
        const transitionKey = oneWalk.at(4);
        const finalKey = oneWalk.at(-1);
        if (transitionKey === undefined || finalKey === undefined)
          throw new Error("expected the transition and final keys");
        await Promise.all([
          walk.waitForArrival(transitionKey, 1),
          walk.waitForArrival(transitionKey, 2),
        ]);
        const firstResultOrdinal = 1;
        const secondResultOrdinal = 2;
        act(() =>
          walk.answer(transitionKey, firstResultOrdinal, { state: firstState }),
        );
        if (firstState === "failed") {
          await waitFor(() =>
            expect(screen.getByRole("alert").textContent).toBe(
              "Couldn't complete the sandbox action.",
            ),
          );
          expect(sandboxToastSpies.success).not.toHaveBeenCalled();
        } else {
          await waitFor(() =>
            expect(sandboxToastSpies.success).toHaveBeenCalledTimes(1),
          );
        }
        act(() =>
          walk.answer(transitionKey, secondResultOrdinal, {
            state: "destroyed",
          }),
        );
        await walk.waitForArrival(finalKey, 1);
        act(() => walk.answer(finalKey, 1, { state: "awake" }));
        await waitFor(() =>
          expect(sandboxToastSpies.success).toHaveBeenCalledTimes(
            firstState === "failed" ? 1 : 2,
          ),
        );
        expect(walk.requests.map((request) => request.clientRequestId)).toEqual(
          [...oneWalk.slice(0, 5).flatMap((key) => [key, key]), finalKey],
        );
        firstWindow.unmount();
        secondWindow.unmount();
      },
    );

    it.each([
      [
        "is still out",
        (): Promise<SandboxListFetchResult> => new Promise(() => undefined),
        "The team has a cloud sandbox. Its bots start once it's running.",
      ],
      [
        "fails",
        (): Promise<SandboxListFetchResult> =>
          Promise.resolve({ kind: "network-error", detail: "offline" }),
        "Couldn't reach Traycer. Try again in a moment.",
      ],
    ] as const)(
      "keeps the button held after the create is accepted while the list's next read %s, so a second press creates nothing",
      async (_case, nextList, sentence) => {
        const user = userEvent.setup();
        auth().createSandbox.mockResolvedValue({
          kind: "ok",
          accepted: {
            sandboxId: "sbx_1",
            hostId: "host-sbx-1",
            sandbox: sandboxSummaryFixture({ environmentId: "env-new" }),
          },
        });
        render(surfaceFor(SETUP_BOT_ID));
        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );
        auth().listSandboxes.mockImplementation(nextList);

        await user.click(enableButton());
        await waitFor(() =>
          expect(
            document.getElementById(
              enableButton().getAttribute("aria-describedby") ?? "",
            )?.textContent,
          ).toBe(sentence),
        );
        expect(enableButton()).toHaveProperty("disabled", true);
        await user.click(enableButton());

        expect(auth().createSandbox).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps a remounted card held while the list has not caught up with an accepted create, so a press there creates nothing", async () => {
      const user = userEvent.setup();
      auth().createSandbox.mockResolvedValue({
        kind: "ok",
        accepted: {
          sandboxId: "sbx_team",
          hostId: "host-sbx-team",
          sandbox: sandboxSummaryFixture({ environmentId: "env-new" }),
        },
      });
      const first = render(surfaceFor(SETUP_BOT_ID));
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      let answerList: (result: SandboxListFetchResult) => void = () =>
        undefined;
      auth().listSandboxes.mockImplementation(
        () =>
          new Promise((resolve) => {
            answerList = resolve;
          }),
      );
      await user.click(enableButton());
      await waitFor(() =>
        expect(
          within(cloudOption()).queryByTestId("team-host-option-cloud-note")
            ?.textContent,
        ).toBe(
          "The team has a cloud sandbox. Its bots start once it's running.",
        ),
      );
      first.unmount();

      // The same app, the card mounted again: the list still holds the read
      // from before the create.
      render(surfaceFor(SETUP_BOT_ID));
      expect(
        within(cloudOption()).getByTestId("team-host-option-cloud-note")
          .textContent,
      ).toBe("The team has a cloud sandbox. Its bots start once it's running.");
      expect(enableButton()).toHaveProperty("disabled", true);
      await user.click(enableButton());
      expect(auth().createSandbox).toHaveBeenCalledTimes(1);

      // Once the list carries the sandbox, it speaks for the team.
      act(() => {
        answerList({
          kind: "ok",
          response: {
            sandboxes: [
              sandboxSummaryFixture({
                id: "sbx_team",
                environmentId: "env-new",
                state: "creating",
              }),
            ],
          },
        });
      });
      await waitFor(() =>
        expect(
          useTeamCloudCreateStore.getState().byEnvironmentId["env-new"],
        ).toBeUndefined(),
      );
      expect(enableButton()).toHaveProperty("disabled", true);
    });

    it("lets the team make another sandbox once a list read sent after the accepted create no longer carries it, and never on a read sent before", async () => {
      const user = userEvent.setup();
      // Only the clock is held, so which read was sent after the answer is
      // decided by the test, not by how fast it ran.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(1_000_000);
        auth().createSandbox.mockResolvedValue({
          kind: "ok",
          accepted: {
            sandboxId: "sbx_team",
            hostId: "host-sbx-team",
            sandbox: sandboxSummaryFixture({ environmentId: "env-new" }),
          },
        });
        render(surfaceFor(SETUP_BOT_ID));
        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );

        // The create's own refresh is sent no later than its answer is heard:
        // the row's absence there settles nothing.
        await user.click(enableButton());
        await waitFor(() =>
          expect(auth().listSandboxes.mock.calls.length).toBeGreaterThan(1),
        );
        await waitFor(() =>
          expect(
            within(cloudOption()).queryByTestId("team-host-option-cloud-note")
              ?.textContent,
          ).toBe(
            "The team has a cloud sandbox. Its bots start once it's running.",
          ),
        );
        expect(
          useTeamCloudCreateStore.getState().byEnvironmentId["env-new"]
            ?.acceptedSandboxId,
        ).toBe("sbx_team");

        // The sandbox is destroyed elsewhere before this app lists it; the
        // next read, sent later, does not carry it.
        vi.setSystemTime(1_000_100);
        await act(() => queryClient.invalidateQueries());
        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );
        expect(
          useTeamCloudCreateStore.getState().byEnvironmentId["env-new"],
        ).toBeUndefined();

        await user.click(enableButton());
        await waitFor(() =>
          expect(auth().createSandbox).toHaveBeenCalledTimes(2),
        );
        const keys = auth().createSandbox.mock.calls.map(
          ([request]) => request.clientRequestId,
        );
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toBe("team-setup:env-new");
        expect(keys[0]?.length).toBeGreaterThanOrEqual(1);
        expect(keys[0]?.length).toBeLessThanOrEqual(64);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a remounted card held while its create is still out, and sends no second create", async () => {
      const user = userEvent.setup();
      auth().createSandbox.mockImplementation(
        () => new Promise(() => undefined),
      );
      const first = render(surfaceFor(SETUP_BOT_ID));
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      await user.click(enableButton());
      first.unmount();

      render(surfaceFor(SETUP_BOT_ID));
      expect(enableButton()).toHaveProperty("disabled", true);
      await user.click(enableButton());
      expect(auth().createSandbox).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "answers no model",
        { kind: "ok", models: [] },
        "No model is available for team sandboxes yet.",
      ],
      [
        "cannot be read",
        { kind: "network-error", detail: "offline" },
        "Couldn't reach Traycer. Try again in a moment.",
      ],
    ] as const)(
      "keeps the button disabled, saying why, when the team sandbox model list %s",
      async (_case, models, sentence) => {
        const user = userEvent.setup();
        auth().getTraycerModels.mockResolvedValue(models);
        render(surfaceFor(SETUP_BOT_ID));

        await waitFor(() =>
          expect(
            document.getElementById(
              enableButton().getAttribute("aria-describedby") ?? "",
            )?.textContent,
          ).toBe(sentence),
        );
        expect(enableButton()).toHaveProperty("disabled", true);
        await user.click(enableButton());
        expect(auth().createSandbox).not.toHaveBeenCalled();
      },
    );

    it("keeps the button disabled, saying so, when the team already has its sandbox", async () => {
      const user = userEvent.setup();
      auth().listSandboxes.mockResolvedValue({
        kind: "ok",
        response: {
          sandboxes: [
            // Another team's kept sandbox and this team's job sandbox host
            // no bot of this team's.
            sandboxSummaryFixture({
              id: "sbx_other",
              environmentId: "env-team",
            }),
            sandboxSummaryFixture({
              id: "sbx_job",
              environmentId: "env-new",
              burst: true,
            }),
            sandboxSummaryFixture({
              id: "sbx_team",
              environmentId: "env-new",
              state: "suspended",
            }),
          ],
        },
      });
      render(surfaceFor(SETUP_BOT_ID));

      await waitFor(() =>
        expect(
          document.getElementById(
            enableButton().getAttribute("aria-describedby") ?? "",
          )?.textContent,
        ).toBe(
          "The team has a cloud sandbox. Its bots start once it's running.",
        ),
      );
      expect(enableButton()).toHaveProperty("disabled", true);
      await user.click(enableButton());
      expect(auth().createSandbox).not.toHaveBeenCalled();
    });

    it("says a refusal for want of the team's credit under the button, and lets the person press it again", async () => {
      const user = userEvent.setup();
      auth().createSandbox.mockResolvedValue({
        ...refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
        reason: "denied",
        shortfallMc: 120,
        newRateMcPerHour: 120,
        currentAwakeBurnMcPerHour: 0,
        creditSource: "team",
      });
      render(teamSetupForBillingRole("editor"));

      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      await user.click(enableButton());

      const alert = await within(cloudOption()).findByRole("alert");
      expect(environmentListRequests.length).toBeGreaterThan(0);
      expect(alert.textContent).toBe(
        "The team's credits don't cover an hour of this sandbox.",
      );
      expect(enableButton()).toHaveProperty("disabled", false);
    });

    it("keeps the add-credit amount on a team Admin's refusal", async () => {
      const user = userEvent.setup();
      auth().createSandbox.mockResolvedValue({
        ...refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
        reason: "denied",
        shortfallMc: 120,
        newRateMcPerHour: 120,
        currentAwakeBurnMcPerHour: 0,
        creditSource: "team",
      });
      render(teamSetupForBillingRole("admin"));

      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      await user.click(enableButton());

      const alert = await within(cloudOption()).findByRole("alert");
      expect(environmentListRequests.length).toBeGreaterThan(0);
      expect(alert.textContent).toBe(
        "The team's credits don't cover an hour of this sandbox. Add $0.12 and try again.",
      );
    });

    it.each([
      ["401", { kind: "unauthorized" }],
      [
        "402",
        {
          ...refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
          reason: "denied",
        },
      ],
    ] as const)(
      "uses the correct request key after a %s",
      async (_status, answer) => {
        const user = userEvent.setup();
        if (_status === "402") {
          const key = "team-setup:env-new";
          const walk = createSandboxRetryWalkFake(key, "env-new");
          walk.refuseUnnamed402(key, true);
          auth().createSandbox.mockImplementation(walk.create);
        } else {
          auth().createSandbox.mockResolvedValue(answer);
        }
        const firstCard = render(teamSetupForBillingRole("editor"));

        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );
        await user.click(enableButton());
        await waitFor(() =>
          expect(auth().createSandbox).toHaveBeenCalledTimes(1),
        );
        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );
        firstCard.unmount();
        render(teamSetupForBillingRole("editor"));
        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );
        await user.click(enableButton());
        await waitFor(() =>
          expect(auth().createSandbox).toHaveBeenCalledTimes(2),
        );
        if (_status === "402")
          await waitFor(() =>
            expect(sandboxToastSpies.success).toHaveBeenCalledWith(
              "Created Team bots",
            ),
          );

        const keys = auth().createSandbox.mock.calls.map(
          ([request]) => request.clientRequestId,
        );
        expect(keys[1]).toBe(keys[0]);
        expect(keys[0]).toBe("team-setup:env-new");
        expect(keys[0]?.length).toBeGreaterThanOrEqual(1);
        expect(keys[0]?.length).toBeLessThanOrEqual(64);
      },
    );

    it("keeps an unnamed 402 on its existing refusal when no credit-gate row qualifies for transfer", async () => {
      const user = userEvent.setup();
      const key = "team-setup:env-new";
      const walk = createSandboxRetryWalkFake(key, "env-new");
      walk.refuseUnnamed402(key, false);
      auth().createSandbox.mockImplementation(walk.create);
      render(teamSetupForBillingRole("editor"));
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );

      await user.click(enableButton());
      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      await user.click(enableButton());

      const alert = await within(cloudOption()).findByRole("alert");
      expect(alert.textContent).toBe(
        "The team's credits don't cover an hour of this sandbox.",
      );
      expect(sandboxToastSpies.success).not.toHaveBeenCalled();
      expect(walk.requests.map((request) => request.clientRequestId)).toEqual([
        key,
        key,
      ]);
    });
  });
});
