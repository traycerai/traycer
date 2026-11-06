/**
 * A new team's setup channel, where its host comes from: the machine option's
 * install token (minted once, held while out, kept across a remount, lapsing
 * into Create a new token), the held buttons while a machine of the team is
 * joining, and Enable cloud, which runs the real sandbox reads and create over
 * a scripted control plane. The rest of the setup channel is in
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
import { formatClockTime } from "@/lib/relative-time";
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
import { TeamHostInstallTokenLifecycleBridge } from "@/providers/team-host-install-token-lifecycle-bridge";
import { teamHostMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTeamCloudCreateStore } from "@/stores/bots/team-cloud-create-store";

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

/** The surface beside the real bridge that drops a mint when the account changes. */
function surfaceWithTokenBridge(botId: string | null): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TeamHostInstallTokenLifecycleBridge />
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

  describe("Create a team host on a machine", () => {
    const TOKEN = "team-host-install-token-fixture";
    const HOST_ID = "0b6f6a3e-6f4c-4a0e-9d6e-0d7a4c1f2a11";
    /** A token's window from its mint to its lapse. */
    const TOKEN_WINDOW_MS = 10 * 60_000;
    const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
    const EXPIRES_AT = NOW + TOKEN_WINDOW_MS;
    const JOIN_COMMAND = `traycer host join ${TOKEN}`;
    const MINTED: TeamHostInstallTokenResult = {
      kind: "ok",
      hostId: HOST_ID,
      installToken: TOKEN,
      expiresAt: EXPIRES_AT,
    };
    const initialClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );

    beforeEach(scriptTeamControlPlane);
    // A token lapses at its own time on the clock, so the clock is held: only
    // `Date`, which a case that waits for a lapse widens to the timers.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
      if (initialClipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", initialClipboard);
      }
    });

    function auth(): TeamCloudBinding["auth"] {
      if (mocks.binding === null) throw new Error("no binding scripted");
      return mocks.binding.auth;
    }

    function machineOption(): HTMLElement {
      return screen.getByTestId("team-host-option-machine");
    }

    function createButton(): HTMLElement {
      return within(machineOption()).getByRole("button", {
        name: "Create team host",
      });
    }

    /** Enable cloud is enabled only once the sandbox list has answered. */
    async function sandboxListRead(): Promise<void> {
      await waitFor(() =>
        expect(
          within(screen.getByTestId("team-host-option-cloud")).getByRole(
            "button",
            { name: "Enable cloud" },
          ),
        ).toHaveProperty("disabled", false),
      );
    }

    function noteLine(): string | undefined {
      return within(machineOption()).queryByTestId(
        "team-host-option-machine-note",
      )?.textContent;
    }

    it("mints once for the team's environment, holds the button while it is out, then shows the command and when it lapses, with the token nowhere else", async () => {
      const user = userEvent.setup();
      let answer: (result: TeamHostInstallTokenResult) => void = () =>
        undefined;
      auth().mintTeamHostInstallToken.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      render(surfaceFor(SETUP_BOT_ID));
      await sandboxListRead();

      expect(createButton()).toHaveProperty("disabled", false);
      expect(noteLine()).toBeUndefined();
      await user.click(createButton());

      expect(auth().mintTeamHostInstallToken.mock.calls).toEqual([["env-new"]]);
      await waitFor(() =>
        expect(createButton()).toHaveProperty("disabled", true),
      );
      await user.click(createButton());
      expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);

      act(() => {
        answer(MINTED);
      });

      expect(
        (await screen.findByTestId("team-host-option-machine-command"))
          .textContent,
      ).toBe(JOIN_COMMAND);
      expect(
        screen.getByTestId("team-host-option-machine-expiry").textContent,
      ).toBe(
        `Expires at ${formatClockTime(EXPIRES_AT)}. The team's bots start once the machine joins.`,
      );
      expect(
        within(machineOption()).queryByRole("button", {
          name: "Create team host",
        }),
      ).toBeNull();
      expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);
      // The command is the token's only appearance, in text or attributes.
      expect(document.body.innerHTML.split(TOKEN)).toHaveLength(2);
    });

    it.each([
      [
        "waits for the machine while the team's kept sandbox is listed",
        sandboxSummaryFixture({
          environmentId: "env-new",
          kind: "agent",
          burst: false,
          state: "awake",
        }),
        true,
      ],
      [
        "stays pressable when only a burst sandbox of the team is listed",
        sandboxSummaryFixture({ environmentId: "env-new", burst: true }),
        false,
      ],
      [
        "stays pressable when only a destroyed sandbox of the team is listed",
        sandboxSummaryFixture({
          environmentId: "env-new",
          burst: false,
          state: "destroyed",
        }),
        false,
      ],
      [
        "stays pressable when only another team's kept sandbox is listed",
        sandboxSummaryFixture({ environmentId: "env-team", burst: false }),
        false,
      ],
    ] as const)("%s", async (_case, sandbox, waits) => {
      auth().listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: [sandbox] },
      });
      render(surfaceFor(SETUP_BOT_ID));

      if (waits) {
        await waitFor(() =>
          expect(noteLine()).toBe("The team has a cloud sandbox."),
        );
        expect(createButton()).toHaveProperty("disabled", true);
        expect(
          document.getElementById(
            createButton().getAttribute("aria-describedby") ?? "",
          )?.textContent,
        ).toBe("The team has a cloud sandbox.");
      } else {
        await sandboxListRead();
        expect(createButton()).toHaveProperty("disabled", false);
        expect(noteLine()).toBeUndefined();
      }
    });

    it.each([
      [
        "a create is out",
        () => useTeamCloudCreateStore.getState().start("env-new", "key-1"),
      ],
      [
        "a create was accepted that the list does not carry yet",
        () => {
          useTeamCloudCreateStore.getState().start("env-new", "key-1");
          useTeamCloudCreateStore
            .getState()
            .accept("env-new", "sbx_1", Date.now());
        },
      ],
    ] as const)(
      "holds the button while %s for the team's cloud, and a press mints nothing",
      async (_case, script) => {
        const user = userEvent.setup();
        auth().listSandboxes.mockImplementation(() => new Promise(() => {}));
        script();
        render(surfaceFor(SETUP_BOT_ID));

        expect(noteLine()).toBe("The team has a cloud sandbox.");
        expect(createButton()).toHaveProperty("disabled", true);
        await user.click(createButton());

        expect(auth().mintTeamHostInstallToken).not.toHaveBeenCalled();
      },
    );

    it.each<readonly [string, TeamHostInstallTokenResult, string]>([
      [
        "the team already has a host",
        { kind: "team-host-exists" },
        "The team already has a host.",
      ],
      [
        "the viewer cannot add a host to the team",
        { kind: "not-found" },
        "You can't add a host to this team.",
      ],
      [
        "the viewer is signed out",
        { kind: "unauthorized" },
        "Sign in to add a host to this team.",
      ],
      [
        "the service is unavailable",
        { kind: "unavailable", reason: "Hosts can't be added right now." },
        "Hosts can't be added right now.",
      ],
      [
        "the server refuses with a code of its own",
        { kind: "refused", status: 422, code: "invalid_environment" },
        "Couldn't create the install token. Try again.",
      ],
      [
        "the network fails",
        { kind: "network-error", detail: "offline" },
        "Couldn't create the install token. Try again.",
      ],
    ])(
      "says so under the button when %s, and leaves the button to press again",
      async (_case, result, line) => {
        const user = userEvent.setup();
        auth().mintTeamHostInstallToken.mockResolvedValue(result);
        render(surfaceFor(SETUP_BOT_ID));
        await sandboxListRead();

        await user.click(createButton());

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toBe(line);
        expect(alert.dataset.testid).toBe("team-host-option-machine-refusal");
        expect(createButton()).toHaveProperty("disabled", false);
        expect(
          screen.queryByTestId("team-host-option-machine-command"),
        ).toBeNull();

        await user.click(createButton());
        await waitFor(() =>
          expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(2),
        );
      },
    );

    it("copies the join command, and the copy button says Copied", async () => {
      const user = userEvent.setup();
      const writeText = vi.fn((_value: string) => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
      auth().mintTeamHostInstallToken.mockResolvedValue(MINTED);
      render(surfaceFor(SETUP_BOT_ID));
      await sandboxListRead();
      await user.click(createButton());

      await user.click(
        await within(machineOption()).findByRole("button", {
          name: "Copy command",
        }),
      );

      expect(writeText.mock.calls).toEqual([[JOIN_COMMAND]]);
      expect(
        await within(machineOption()).findByRole("button", { name: "Copied" }),
      ).toBeTruthy();
    });

    it("keeps the token when the card is left and comes back within its window: the join view again, with no second mint", async () => {
      const user = userEvent.setup();
      auth().mintTeamHostInstallToken.mockResolvedValue(MINTED);
      const first = render(surfaceFor(SETUP_BOT_ID));
      await sandboxListRead();
      await user.click(createButton());
      await screen.findByTestId("team-host-option-machine-command");
      first.unmount();

      render(surfaceFor(SETUP_BOT_ID));

      expect(
        screen.getByTestId("team-host-option-machine-command").textContent,
      ).toBe(JOIN_COMMAND);
      expect(
        within(machineOption()).queryByRole("button", {
          name: "Create team host",
        }),
      ).toBeNull();
      expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);
      expect(document.body.innerHTML.split(TOKEN)).toHaveLength(2);
    });

    it("shows a mint still out when the card is left and comes back: the button held, then the token once it is minted", async () => {
      const user = userEvent.setup();
      let answer: (result: TeamHostInstallTokenResult) => void = () =>
        undefined;
      auth().mintTeamHostInstallToken.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      const first = render(surfaceFor(SETUP_BOT_ID));
      await sandboxListRead();
      await user.click(createButton());
      await waitFor(() =>
        expect(createButton()).toHaveProperty("disabled", true),
      );
      first.unmount();

      render(surfaceFor(SETUP_BOT_ID));

      expect(createButton()).toHaveProperty("disabled", true);
      expect(
        screen.queryByTestId("team-host-option-machine-command"),
      ).toBeNull();
      expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);

      act(() => {
        answer(MINTED);
      });

      expect(
        (await screen.findByTestId("team-host-option-machine-command"))
          .textContent,
      ).toBe(JOIN_COMMAND);
      expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);
    });

    describe("when another account takes over this app", () => {
      const MACHINE_JOINING_NOTE = "A machine is joining the team.";

      function switchToAccountB(): void {
        act(() => {
          useAuthStore.setState({
            contextMetadata: { userId: "user-other", username: "bea" },
          });
        });
      }

      function enableCloudButton(): HTMLElement {
        return within(screen.getByTestId("team-host-option-cloud")).getByRole(
          "button",
          { name: "Enable cloud" },
        );
      }

      /**
       * The card as a first visit draws it. Enable cloud waits for the new
       * account's own sandbox list, then is pressable and unheld by any mint.
       */
      async function expectFreshCard(): Promise<void> {
        await sandboxListRead();
        expect(
          screen.queryByTestId("team-host-option-machine-command"),
        ).toBeNull();
        expect(
          screen.queryByTestId("team-host-option-machine-expired"),
        ).toBeNull();
        expect(createButton()).toHaveProperty("disabled", false);
        expect(enableCloudButton()).toHaveProperty("disabled", false);
        expect(screen.queryByTestId("team-host-option-cloud-note")).toBeNull();
        expect(document.body.innerHTML).not.toContain(TOKEN);
      }

      it("never shows the first account's token to the account that takes over", async () => {
        const user = userEvent.setup();
        auth().mintTeamHostInstallToken.mockResolvedValue(MINTED);
        render(surfaceWithTokenBridge(SETUP_BOT_ID));
        await sandboxListRead();
        await user.click(createButton());
        await screen.findByTestId("team-host-option-machine-command");

        switchToAccountB();

        await waitFor(() =>
          expect(
            screen.queryByTestId("team-host-option-machine-command"),
          ).toBeNull(),
        );
        await expectFreshCard();
        expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);
      });

      it("drops a mint that settles after the account changed, and holds nothing for the account that took over meanwhile", async () => {
        const user = userEvent.setup();
        let answer: (result: TeamHostInstallTokenResult) => void = () =>
          undefined;
        auth().mintTeamHostInstallToken.mockImplementation(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        render(surfaceWithTokenBridge(SETUP_BOT_ID));
        await sandboxListRead();
        await user.click(createButton());
        await waitFor(() =>
          expect(createButton()).toHaveProperty("disabled", true),
        );
        expect(enableCloudButton()).toHaveProperty("disabled", true);
        expect(
          document.getElementById(
            enableCloudButton().getAttribute("aria-describedby") ?? "",
          )?.textContent,
        ).toBe(MACHINE_JOINING_NOTE);

        switchToAccountB();

        await waitFor(() =>
          expect(createButton()).toHaveProperty("disabled", false),
        );
        await expectFreshCard();

        await act(async () => {
          answer(MINTED);
          await Promise.resolve();
        });

        await expectFreshCard();
        expect(
          queryClient.getMutationCache().findAll({
            mutationKey: teamHostMutationKeys.installTokenAll(),
          }),
        ).toEqual([]);
        expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);
      });

      it("drops the token when the account signs out, so signing the same account back in shows no token", async () => {
        const user = userEvent.setup();
        auth().mintTeamHostInstallToken.mockResolvedValue(MINTED);
        render(surfaceWithTokenBridge(SETUP_BOT_ID));
        await sandboxListRead();
        await user.click(createButton());
        await screen.findByTestId("team-host-option-machine-command");

        act(() => {
          useAuthStore.setState({
            status: "signed-out",
            contextMetadata: null,
          });
        });
        act(() => {
          useAuthStore.setState({
            status: "signed-in",
            contextMetadata: { userId: "user-viewer", username: "olive" },
          });
        });

        await waitFor(() =>
          expect(
            screen.queryByTestId("team-host-option-machine-command"),
          ).toBeNull(),
        );
        await expectFreshCard();
        expect(
          queryClient.getMutationCache().findAll({
            mutationKey: teamHostMutationKeys.installTokenAll(),
          }),
        ).toEqual([]);
        expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);
      });
    });

    describe("once the token lapses before the machine joins", () => {
      const REMINTED_TOKEN = "team-host-install-token-second";

      beforeEach(() => {
        // The lapse is a timer, so the timers are held with the clock, which
        // still follows real time for the waits around it.
        vi.useFakeTimers({
          toFake: ["Date", "setTimeout", "clearTimeout"],
          shouldAdvanceTime: true,
        });
        vi.setSystemTime(NOW);
      });

      function lapseUser(): UserEvent {
        return userEvent.setup({
          advanceTimers: (ms) => vi.advanceTimersByTime(ms),
        });
      }

      async function lapse(): Promise<void> {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(TOKEN_WINDOW_MS);
        });
      }

      function remintButton(): HTMLElement {
        return within(machineOption()).getByRole("button", {
          name: "Create a new token",
        });
      }

      it("keeps the command and its copy button until the token lapses, then says it expired and offers neither", async () => {
        const user = lapseUser();
        auth().mintTeamHostInstallToken.mockResolvedValue(MINTED);
        render(surfaceFor(SETUP_BOT_ID));
        await sandboxListRead();
        await user.click(createButton());
        await screen.findByTestId("team-host-option-machine-command");
        expect(
          within(machineOption()).getByRole("button", { name: "Copy command" }),
        ).toBeTruthy();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(TOKEN_WINDOW_MS / 2);
        });
        expect(
          screen.getByTestId("team-host-option-machine-command").textContent,
        ).toBe(JOIN_COMMAND);

        await lapse();

        expect(
          screen.getByTestId("team-host-option-machine-expired").textContent,
        ).toBe(
          "The install token expired before the machine joined.Create a new token",
        );
        expect(
          screen.queryByTestId("team-host-option-machine-command"),
        ).toBeNull();
        expect(
          within(machineOption()).queryByRole("button", {
            name: "Copy command",
          }),
        ).toBeNull();
        expect(document.body.innerHTML).not.toContain(TOKEN);
      });

      it("shows the expired view at once for a token that lapsed while the card was away", async () => {
        const user = lapseUser();
        auth().mintTeamHostInstallToken.mockResolvedValue(MINTED);
        const first = render(surfaceFor(SETUP_BOT_ID));
        await sandboxListRead();
        await user.click(createButton());
        await screen.findByTestId("team-host-option-machine-command");
        first.unmount();
        vi.setSystemTime(NOW + TOKEN_WINDOW_MS + 1);

        render(surfaceFor(SETUP_BOT_ID));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(
          screen.getByTestId("team-host-option-machine-expired"),
        ).toBeTruthy();
        expect(remintButton()).toBeTruthy();
        expect(document.body.innerHTML).not.toContain(TOKEN);
      });

      it("mints again when Create a new token is pressed, and shows the new token's command in place of the dead one", async () => {
        const user = lapseUser();
        auth().mintTeamHostInstallToken.mockResolvedValueOnce(MINTED);
        auth().mintTeamHostInstallToken.mockImplementationOnce(() =>
          Promise.resolve({
            kind: "ok",
            hostId: HOST_ID,
            installToken: REMINTED_TOKEN,
            expiresAt: Date.now() + TOKEN_WINDOW_MS,
          }),
        );
        render(surfaceFor(SETUP_BOT_ID));
        await sandboxListRead();
        await user.click(createButton());
        await screen.findByTestId("team-host-option-machine-command");
        await lapse();

        await user.click(remintButton());

        expect(auth().mintTeamHostInstallToken.mock.calls).toEqual([
          ["env-new"],
          ["env-new"],
        ]);
        expect(
          (await screen.findByTestId("team-host-option-machine-command"))
            .textContent,
        ).toBe(`traycer host join ${REMINTED_TOKEN}`);
        expect(
          screen.queryByTestId("team-host-option-machine-expired"),
        ).toBeNull();
        expect(document.body.innerHTML).not.toContain(TOKEN);
      });

      it("says why under the button when the new token is refused", async () => {
        const user = lapseUser();
        auth().mintTeamHostInstallToken.mockResolvedValueOnce(MINTED);
        auth().mintTeamHostInstallToken.mockResolvedValueOnce({
          kind: "team-host-exists",
        });
        render(surfaceFor(SETUP_BOT_ID));
        await sandboxListRead();
        await user.click(createButton());
        await screen.findByTestId("team-host-option-machine-command");
        await lapse();

        await user.click(remintButton());

        const alert = await within(machineOption()).findByRole("alert");
        expect(alert.textContent).toBe("The team already has a host.");
        expect(alert.dataset.testid).toBe("team-host-option-machine-refusal");
        expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(2);
        expect(
          screen.queryByTestId("team-host-option-machine-command"),
        ).toBeNull();
        expect(document.body.innerHTML).not.toContain(TOKEN);
      });

      describe("while the team's host is held", () => {
        const JOINING_SETUP: BotOnboardingSetup = {
          ...NEEDS_HOST_SETUP,
          state: "host_joining",
          arrival: { kind: "machine" },
        };

        /** The card's buttons that are not held. */
        function pressableButtons(): readonly string[] {
          return within(screen.getByTestId("team-host-options"))
            .getAllByRole("button")
            .filter((button) => !button.hasAttribute("disabled"))
            .map((button) => button.textContent);
        }

        it("keeps the command in the window while the machine it enrolled is joining, then says so and offers no new token", async () => {
          const user = lapseUser();
          auth().mintTeamHostInstallToken.mockResolvedValue(MINTED);
          const view = render(surfaceFor(SETUP_BOT_ID));
          await sandboxListRead();
          await user.click(createButton());
          await screen.findByTestId("team-host-option-machine-command");

          // The machine registered with the token but has no provider signed
          // in, so no bot exists yet: the team's read says it is joining.
          mocks.state.readsCached = true;
          mocks.reads["env-new"] = { setup: JOINING_SETUP };
          view.rerender(surfaceFor(SETUP_BOT_ID));

          expect(
            screen.getByTestId("team-host-option-machine-command").textContent,
          ).toBe(JOIN_COMMAND);

          await lapse();

          const line = screen.getByTestId(
            "team-host-option-machine-expired-line",
          );
          expect(line.textContent).toBe("A machine is joining the team.");
          expect(remintButton()).toHaveProperty("disabled", true);
          expect(remintButton().getAttribute("aria-describedby")).toBe(line.id);
          expect(pressableButtons()).toEqual([]);
          await user.click(remintButton());
          expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);
          expect(document.body.innerHTML).not.toContain(TOKEN);
        });

        it("offers no new token past the window while the team's kept sandbox is listed", async () => {
          const user = lapseUser();
          auth().mintTeamHostInstallToken.mockResolvedValue(MINTED);
          render(surfaceFor(SETUP_BOT_ID));
          await sandboxListRead();
          await user.click(createButton());
          await screen.findByTestId("team-host-option-machine-command");

          auth().listSandboxes.mockResolvedValue({
            kind: "ok",
            response: {
              sandboxes: [
                sandboxSummaryFixture({
                  environmentId: "env-new",
                  kind: "agent",
                  burst: false,
                  state: "awake",
                }),
              ],
            },
          });
          await act(async () => {
            await queryClient.invalidateQueries();
          });
          await lapse();

          const line = screen.getByTestId(
            "team-host-option-machine-expired-line",
          );
          await waitFor(() =>
            expect(line.textContent).toBe("The team has a cloud sandbox."),
          );
          expect(remintButton()).toHaveProperty("disabled", true);
          expect(remintButton().getAttribute("aria-describedby")).toBe(line.id);
          await user.click(remintButton());
          expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);
        });
      });
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
          { name: "Create team host" },
        ),
      ];
    }

    it("shows the setup channel with both host buttons held under the note, and lets them be pressed again once the machine is gone", async () => {
      mocks.reads["env-new"] = { setup: JOINING_SETUP };
      const view = render(surfaceFor(SETUP_BOT_ID));

      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
      expect(mocks.open).not.toHaveBeenCalled();
      for (const option of ["cloud", "machine"]) {
        const note = screen.getByTestId(`team-host-option-${option}-note`);
        expect(note.textContent).toBe(JOINING_NOTE);
        const button = within(
          screen.getByTestId(`team-host-option-${option}`),
        ).getByRole("button");
        expect(button).toHaveProperty("disabled", true);
        expect(button.getAttribute("aria-describedby")).toBe(note.id);
      }

      mocks.reads["env-new"] = { setup: NEEDS_HOST_SETUP };
      view.rerender(surfaceFor(SETUP_BOT_ID));

      await waitFor(() =>
        expect(
          hostButtons().map((button) => button.hasAttribute("disabled")),
        ).toEqual([false, false]),
      );
      expect(screen.queryByTestId("team-host-option-cloud-note")).toBeNull();
      expect(screen.queryByTestId("team-host-option-machine-note")).toBeNull();
    });

    it("mints nothing and creates nothing when a held button is pressed", async () => {
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

    describe("while a machine's install token is being minted", () => {
      const MACHINE_JOINING_NOTE = "A machine is joining the team.";

      // The join view's lapse is read from the clock: only `Date` is held.
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      function createHostButton(): HTMLElement {
        return within(screen.getByTestId("team-host-option-machine")).getByRole(
          "button",
          { name: "Create team host" },
        );
      }

      async function pressEnableCloudHeld(user: UserEvent): Promise<void> {
        expect(enableButton()).toHaveProperty("disabled", true);
        expect(
          document.getElementById(
            enableButton().getAttribute("aria-describedby") ?? "",
          )?.textContent,
        ).toBe(MACHINE_JOINING_NOTE);
        expect(createHostButton()).toHaveProperty("disabled", true);
        await user.click(enableButton());
        expect(auth().createSandbox).not.toHaveBeenCalled();
      }

      it("holds the button and creates nothing, as does a card that is left and comes back while the mint is still out, until the token is minted", async () => {
        const user = userEvent.setup();
        let answer: (result: TeamHostInstallTokenResult) => void = () =>
          undefined;
        auth().mintTeamHostInstallToken.mockImplementation(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        const first = render(surfaceFor(SETUP_BOT_ID));
        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", false),
        );

        await user.click(createHostButton());
        await waitFor(() =>
          expect(enableButton()).toHaveProperty("disabled", true),
        );
        await pressEnableCloudHeld(user);

        first.unmount();
        render(surfaceFor(SETUP_BOT_ID));
        await pressEnableCloudHeld(user);
        expect(auth().mintTeamHostInstallToken).toHaveBeenCalledTimes(1);

        act(() => {
          answer({
            kind: "ok",
            hostId: "0b6f6a3e-6f4c-4a0e-9d6e-0d7a4c1f2a11",
            installToken: "team-host-install-token-fixture",
            expiresAt: Date.now() + 10 * 60_000,
          });
        });

        expect(
          (await screen.findByTestId("team-host-option-machine-command"))
            .textContent,
        ).toBe("traycer host join team-host-install-token-fixture");
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
