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
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamHostInstallTokenResult } from "@traycer-clients/shared/host-client/team-host";
import type {
  SandboxCreateFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  type SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { BotOnboardingSetup } from "@traycer/protocol/host/bot/onboarding-schemas";
import {
  endBotTabSurfaceCase,
  NEEDS_HOST_SETUP,
  resetBotTabSurfaceMocks,
  scriptTeamControlPlane,
  setUpNewTeam,
  SETUP_BOT_ID,
  TAB_HOST,
} from "./bot-tab-surface-harness";

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
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
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
import { teamHostMutationKeys } from "@/lib/query-keys";
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

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetBotTabSurfaceMocks();
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
});

describe("<BotTabSurface /> a team's main bot still to be set up", () => {
  beforeEach(() => {
    setUpNewTeam();
    mocks.reads["env-new"] = {
      setup: NEEDS_HOST_SETUP,
    };
  });

  describe("Add a computer", () => {
    beforeEach(scriptTeamControlPlane);

    it("opens the install instructions for the selected team without minting a token", async () => {
      const user = userEvent.setup();
      render(surfaceFor(SETUP_BOT_ID));

      await user.click(screen.getByRole("button", { name: "Add a computer" }));

      expect(
        screen.getByRole("heading", { name: "Add a computer to Newco" }),
      ).toBeTruthy();
      expect(
        screen.getByText(
          "Run this on the computer, then sign in as a team member.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByTestId("team-host-option-machine-command").textContent,
      ).toBe("traycer host install --team env-new");
      expect(screen.getByText(/Already installed\? Run/).textContent).toContain(
        "traycer host use env-new",
      );
      expect(document.body.textContent).not.toContain("traycer host join");
      expect(
        mocks.binding?.auth.mintTeamHostInstallToken,
      ).not.toHaveBeenCalled();
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

      expect(
        screen.getByTestId("shell-safe-add-computer-command").textContent,
      ).toBe("traycer host install --team 'team one'\\''s; echo unsafe'");
      expect(screen.getByText(/Already installed\? Run/).textContent).toContain(
        "traycer host use 'team one'\\''s; echo unsafe'",
      );
    });
  });

  describe("while a machine of the team is joining", () => {
    const JOINING_SETUP: BotOnboardingSetup = {
      ...NEEDS_HOST_SETUP,
      state: "host_joining",
      arrival: { kind: "machine" },
    };
    const JOINING_NOTE = "A machine is joining the team.";

    beforeEach(() => {
      scriptTeamControlPlane();
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
      ).toBe("traycer host install --team env-new");
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

    it("does not mint or create anything when the available instructions are opened", async () => {
      const user = userEvent.setup();
      mocks.reads["env-new"] = { setup: JOINING_SETUP };
      render(surfaceFor(SETUP_BOT_ID));

      for (const button of hostButtons()) await user.click(button);

      expect(
        mocks.binding?.auth.mintTeamHostInstallToken,
      ).not.toHaveBeenCalled();
      expect(mocks.binding?.auth.createSandbox).not.toHaveBeenCalled();
    });
  });

  describe("Enable cloud", () => {
    beforeEach(scriptTeamControlPlane);

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

    describe("while an install-token mutation is pending", () => {
      const MACHINE_JOINING_NOTE = "A machine is joining the team.";

      async function pressEnableCloudHeld(user: UserEvent): Promise<void> {
        expect(enableButton()).toHaveProperty("disabled", true);
        expect(
          document.getElementById(
            enableButton().getAttribute("aria-describedby") ?? "",
          )?.textContent,
        ).toBe(MACHINE_JOINING_NOTE);
        await user.click(enableButton());
        expect(auth().createSandbox).not.toHaveBeenCalled();
      }

      it("holds cloud creation across a remount until the pending mint settles", async () => {
        const user = userEvent.setup();
        const first = render(surfaceFor(SETUP_BOT_ID));
        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );
        let answer: (result: TeamHostInstallTokenResult) => void = () =>
          undefined;
        const pendingMint = queryClient
          .getMutationCache()
          .build<TeamHostInstallTokenResult, Error, void, undefined>(
            queryClient,
            {
              mutationKey: teamHostMutationKeys.installToken(
                "user-viewer",
                "env-new",
              ),
              mutationFn: () =>
                new Promise((resolve) => {
                  answer = resolve;
                }),
            },
          );
        // Another install-token flow can still conflict with cloud creation;
        // represent its pending state without making Add a computer mint one.
        const mintResult = pendingMint.execute();

        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", true),
        );
        await pressEnableCloudHeld(user);

        first.unmount();
        render(surfaceFor(SETUP_BOT_ID));
        await pressEnableCloudHeld(user);

        await act(async () => {
          answer({
            kind: "ok",
            hostId: "0b6f6a3e-6f4c-4a0e-9d6e-0d7a4c1f2a11",
            installToken: "team-host-install-token-fixture",
            expiresAt: Date.now() + 10 * 60_000,
          });
          await mintResult;
        });

        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );
        expect(auth().mintTeamHostInstallToken).not.toHaveBeenCalled();
        expect(auth().createSandbox).not.toHaveBeenCalled();
      });
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

      expect(auth().createSandbox.mock.calls).toEqual([
        [
          {
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
            clientRequestId: expect.any(String),
          } satisfies Record<keyof SandboxCreateRequest, unknown>,
        ],
      ]);
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
        expect(new Set(keys).size).toBe(2);
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
        creditSource: "team",
      });
      render(surfaceFor(SETUP_BOT_ID));

      await waitFor(() =>
        expect(enableButton()).toHaveProperty("disabled", false),
      );
      await user.click(enableButton());

      const alert = await within(cloudOption()).findByRole("alert");
      expect(alert.textContent).toBe(
        "The team's credits don't cover an hour of this sandbox.",
      );
      expect(enableButton()).toHaveProperty("disabled", false);
    });
  });
});
