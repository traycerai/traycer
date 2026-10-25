/**
 * A team's bot setup dialog (Tracy Bots T59), behind the + on its section in
 * the channel sidebar. While the team's onboarding is open it walks GitHub,
 * then the bots, with a back arrow between them, and Create makes the chosen
 * bots, opens the first channel and closes; a team whose onboarding is done,
 * or that pre-dates it, gets the create-bot form instead; a read still on its
 * way shows a loading view. The real dialog, the real card steps, the real
 * flow hook and the real bot-tabs store run over scripted reads. The two
 * onboarding mutations are scripted and record what they were sent, because
 * a request through a real host client cannot run where two zod copies are
 * installed; the model picker, the create-bot form and the toolbar store hook
 * are replaced, the toolbar store itself is the production one. Focus and
 * height are read off the real dialog: where focus lands once it closes, and
 * the classes that bound its height and make each branch's body the scroller
 * (jsdom has no layout, as the sibling dialog suites read it).
 */
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotOnboardingChooseRequest,
  BotOnboardingCompleteRequest,
  BotOnboardingGithub,
  BotOnboardingReadResponse,
} from "@traycer/protocol/host/bot/onboarding-schemas";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

const HOST_ID = mockLocalHostEntry.hostId;
const ENV = "env-team";
const BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOT_B = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const mocks = vi.hoisted(() => ({
  /** The tab host's client, which carries the reads. */
  tabClient: { stub: "tab-host-client" },
  /** What the onboarding read answers, `undefined` while it is on its way. */
  read: undefined as BotOnboardingReadResponse | undefined,
  /** The model the toolbar starts with; empty reads as none chosen. */
  modelSlug: "model-a",
  chooses: [] as BotOnboardingChooseRequest[],
  completes: [] as BotOnboardingCompleteRequest[],
  /** The client the completion mutation was built over, in order. */
  completeClients: [] as unknown[],
  navigateToTabIntent: vi.fn<(intent: unknown) => void>(),
  openLink: vi.fn<(url: string, kind: string) => Promise<void>>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: (_navigate: unknown, intent: unknown) =>
    mocks.navigateToTabIntent(intent),
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.tabClient,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === HOST_ID ? { stub: "client-for-host", hostId } : null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) =>
    hostId === HOST_ID && method === "bot.onboarding.read",
}));
vi.mock("@/hooks/host/use-hosts-advertising-method", () => ({
  useHostsAdvertisingMethod: (hostIds: ReadonlyArray<string>, method: string) =>
    new Set(method === "bot.onboarding.complete" ? hostIds : []),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => HOST_ID,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ signInUrl: "https://platform.traycer.ai" }),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));
vi.mock("@/hooks/bots/use-bot-onboarding-query", () => ({
  useBotOnboardingQuery: (
    _client: unknown,
    _environmentId: string,
    enabled: boolean,
  ) => {
    const data = enabled ? mocks.read : undefined;
    return { status: data === undefined ? "pending" : "success", data };
  },
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotOnboardingChooseMutation: () => ({
    isPending: false,
    variables: undefined,
    mutate: (variables: BotOnboardingChooseRequest) => {
      mocks.chooses.push(variables);
    },
    mutateAsync: (variables: BotOnboardingChooseRequest) => {
      mocks.chooses.push(variables);
      return Promise.resolve({
        choice: {
          areas: variables.areas,
          chosenAt: 2_000,
          completedAt: null,
          pending: [],
        },
      });
    },
  }),
  useBotOnboardingCompleteMutation: (client: unknown) => {
    mocks.completeClients.push(client);
    return {
      isPending: false,
      variables: undefined,
      mutateAsync: (variables: BotOnboardingCompleteRequest) => {
        mocks.completes.push(variables);
        return Promise.resolve({
          choice: {
            areas: [],
            chosenAt: 2_000,
            completedAt: 3_000,
            pending: [],
          },
          bots: [
            { area: "ci-speed-and-cost", botId: BOT_A },
            { area: "trunk-watch", botId: BOT_B },
          ],
        });
      },
    };
  },
}));
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="stub-harness-model-picker" />,
}));
vi.mock("@/components/home/bots/create-bot-form", () => ({
  CreateBotForm: (props: {
    environmentId: string;
    environmentLabel: string;
    onDone: () => void;
  }) => (
    <div
      data-testid="stub-create-bot-form"
      data-environment-id={props.environmentId}
      data-environment-label={props.environmentLabel}
    >
      <button type="button" onClick={props.onDone}>
        Cancel
      </button>
    </div>
  ),
  CreateBotNoHost: () => <div data-testid="stub-create-bot-no-host" />,
}));
vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  return {
    useComposerToolbarStore: (): ComposerToolbarStore => {
      const [store] = useState(() =>
        createComposerToolbarStore({
          purpose: "run",
          reasoningFallback: "model-default",
          seedKey: "team-bot-setup-dialog-test",
          values: {
            permission: "supervised",
            selection: {
              harnessId: "claude",
              modelSlug: mocks.modelSlug,
              profileId: null,
            },
            reasoning: "",
            serviceTier: "",
          },
          onSettingsChange: null,
          tuiOnly: false,
          chatLineCarriesAutoMode: null,
          hostId: HOST_ID,
        }),
      );
      return store;
    },
  };
});

import {
  TeamBotSetupDialog,
  type TeamBotSetupTarget,
} from "@/components/bots/team-bot-setup-dialog";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const CATALOG: BotOnboardingReadResponse["catalog"] = [
  {
    area: "ci-speed-and-cost",
    title: "CI speed and cost",
    description: "Measures minutes, cost and wall time.",
    when: "Weekly; the baseline on the first run",
    tickedByDefault: true,
  },
  {
    area: "trunk-watch",
    title: "Trunk watch",
    description: "When the default branch goes red, finds the commit.",
    when: "When the default branch goes red",
    tickedByDefault: true,
  },
  {
    area: "alerts",
    title: "Alerts (SRE)",
    description: "Triages alerts as they fire.",
    when: null,
    tickedByDefault: false,
  },
];

const NO_SET: BotOnboardingGithub = {
  state: "ok",
  installingAdmin: null,
  repositories: [],
  callerCanConnect: true,
};

const CONNECTED: BotOnboardingGithub = {
  state: "ok",
  installingAdmin: { displayName: "Ada", you: false },
  repositories: [
    { repositoryId: "1", fullName: "acme/api", permission: "write" },
  ],
  callerCanConnect: true,
};

const LOCKED: BotOnboardingReadResponse = {
  github: NO_SET,
  unlocked: false,
  choice: null,
  catalog: CATALOG,
};

const UNLOCKED: BotOnboardingReadResponse = {
  github: CONNECTED,
  unlocked: true,
  choice: null,
  catalog: CATALOG,
};

function descriptor(): EnvironmentDescriptor {
  return {
    environmentId: ENV,
    ownerKind: "organization",
    ownerId: "team-1",
    roomId: "room-team",
    label: "acme",
  };
}

function boundHere(): HostEnvironmentBindings {
  const binding: EnvironmentHostBinding = {
    hostId: HOST_ID,
    environment: descriptor(),
    explicit: true,
    enrolledByUserId: "user-1",
    canUnbind: true,
  };
  return {
    byHostId: new Map([[HOST_ID, binding]]),
    failedHostIds: [],
    retryFailed: () => undefined,
  };
}

const BINDINGS = boundHere();
const CONNECTABLE = [HOST_ID];

/**
 * What the sidebar does: the dialog is open for a team until it closes. A
 * dialog not open at mount is opened by a control that passes itself as the
 * opener, as the sidebar's + does.
 */
function Harness(props: {
  readonly botCount: number;
  readonly openAtMount: boolean;
}): ReactNode {
  const [team, setTeam] = useState<TeamBotSetupTarget | null>(
    props.openAtMount
      ? {
          environmentId: ENV,
          teamName: "acme",
          botCount: props.botCount,
          opener: null,
        }
      : null,
  );
  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          setTeam({
            environmentId: ENV,
            teamName: "acme",
            botCount: props.botCount,
            opener: event.currentTarget,
          })
        }
      >
        Set up acme
      </button>
      <TeamBotSetupDialog
        team={team}
        connectableHostIds={CONNECTABLE}
        environmentBindings={BINDINGS}
        onClose={() => setTeam(null)}
      />
    </>
  );
}

function mount(input: {
  readonly read: BotOnboardingReadResponse | undefined;
  readonly botCount: number;
}): void {
  mocks.read = input.read;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness botCount={input.botCount} openAtMount />
    </QueryClientProvider>,
  );
}

/** Mounts with the dialog shut; the returned control opens it. */
function mountClosed(input: {
  readonly read: BotOnboardingReadResponse | undefined;
  readonly botCount: number;
}): HTMLElement {
  mocks.read = input.read;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness botCount={input.botCount} openAtMount={false} />
    </QueryClientProvider>,
  );
  return screen.getByRole("button", { name: "Set up acme" });
}

function dialog(): HTMLElement {
  return screen.getByTestId("team-bot-setup-dialog");
}

function checkbox(key: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-onboarding-area")
    .find((element) => element.getAttribute("data-area") === key);
  if (found === undefined) throw new Error(`no area ${key}`);
  return within(found).getByRole("checkbox");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read = undefined;
  mocks.modelSlug = "model-a";
  mocks.chooses = [];
  mocks.completes = [];
  mocks.completeClients = [];
  mocks.openLink.mockResolvedValue(undefined);
  useBotTabsStore.setState({ tabs: {} });
});

afterEach(() => {
  cleanup();
});

describe("<TeamBotSetupDialog /> while the team's onboarding is open", () => {
  it("opens a team with no repository on GitHub, goes on to the bots with Create waiting on GitHub, and comes back", async () => {
    const user = userEvent.setup();
    mount({ read: LOCKED, botCount: 0 });

    expect(within(dialog()).getByText("Set up acme's bots")).toBeTruthy();
    expect(screen.getByTestId("bot-onboarding-connect-github")).toBeTruthy();
    expect(screen.queryByTestId("bot-onboarding-area")).toBeNull();
    expect(screen.queryByTestId("team-bot-setup-back")).toBeNull();

    await user.click(screen.getByTestId("team-bot-setup-next"));

    expect(checkbox("ci-speed-and-cost").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(checkbox("trunk-watch").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("alerts").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("team-bot-setup-needs-github").textContent).toBe(
      "Connect GitHub to create the bots.",
    );
    expect(screen.queryByTestId("stub-harness-model-picker")).toBeNull();
    expect(screen.getByTestId("bot-onboarding-open").textContent).toBe(
      "Create",
    );
    expect(
      screen.getByTestId("bot-onboarding-open").hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByTestId("bot-onboarding-connect-github")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByTestId("bot-onboarding-connect-github")).toBeTruthy();
    expect(screen.queryByTestId("bot-onboarding-area")).toBeNull();
    expect(screen.queryByTestId("team-bot-setup-back")).toBeNull();
  });

  it("opens a team whose set holds a repository on the bots, with Create off until a model is chosen", () => {
    mocks.modelSlug = "";
    mount({ read: UNLOCKED, botCount: 0 });

    expect(screen.getAllByTestId("bot-onboarding-area")).toHaveLength(3);
    expect(screen.queryByTestId("bot-onboarding-connect-github")).toBeNull();
    expect(screen.queryByTestId("team-bot-setup-needs-github")).toBeNull();
    expect(screen.getByTestId("stub-harness-model-picker")).toBeTruthy();
    expect(
      screen.getByTestId("bot-onboarding-open").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("creates the chosen bots with the picked model on the chosen host, opens the first channel and closes", async () => {
    const user = userEvent.setup();
    mount({ read: UNLOCKED, botCount: 0 });

    const create = screen.getByTestId("bot-onboarding-open");
    expect(create.hasAttribute("disabled")).toBe(false);
    await user.click(create);

    await waitFor(() =>
      expect(mocks.completes).toEqual([
        {
          environmentId: ENV,
          harness: "claude",
          model: "model-a",
          effort: null,
          profile: null,
        },
      ]),
    );
    expect(mocks.chooses).toEqual([
      { environmentId: ENV, areas: ["ci-speed-and-cost", "trunk-watch"] },
    ]);
    expect(mocks.completeClients.at(-1)).toMatchObject({ hostId: HOST_ID });
    await waitFor(() =>
      expect(screen.queryByTestId("team-bot-setup-dialog")).toBeNull(),
    );
    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_A)).toMatchObject({
      botId: BOT_A,
      hostId: HOST_ID,
      title: "CI speed and cost",
    });
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith({
      kind: "bot",
      botId: BOT_A,
    });
  });
});

describe("<TeamBotSetupDialog /> once onboarding no longer applies", () => {
  const completedChoice = {
    areas: ["alerts"],
    chosenAt: 1_000,
    completedAt: 2_000,
    pending: [],
  };

  it.each([
    {
      label: "a team whose onboarding completed",
      read: { ...UNLOCKED, choice: completedChoice },
      botCount: 3,
    },
    {
      label: "a team that has bots and no record, which pre-dates onboarding",
      read: LOCKED,
      botCount: 2,
    },
  ])(
    "gives $label the create-bot form for its environment, and Cancel closes it",
    async ({ read, botCount }) => {
      const user = userEvent.setup();
      mount({ read, botCount });

      expect(within(dialog()).getByText("Add a bot to acme")).toBeTruthy();
      const form = within(dialog()).getByTestId("stub-create-bot-form");
      expect(form.getAttribute("data-environment-id")).toBe(ENV);
      expect(form.getAttribute("data-environment-label")).toBe("acme");
      expect(screen.queryByTestId("bot-onboarding-area")).toBeNull();
      expect(screen.queryByTestId("bot-onboarding-open")).toBeNull();
      expect(screen.queryByTestId("team-bot-setup-next")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByTestId("team-bot-setup-dialog")).toBeNull();
    },
  );
});

describe("<TeamBotSetupDialog /> before the onboarding read answers", () => {
  it.each([
    { label: "a team with bots", botCount: 3 },
    { label: "a team with none", botCount: 0 },
  ])(
    "shows the loading view for $label, with neither the checklist nor the form",
    ({ botCount }) => {
      mount({ read: undefined, botCount });

      expect(within(dialog()).getByText("Set up acme's bots")).toBeTruthy();
      expect(screen.getByTestId("team-bot-setup-loading")).toBeTruthy();
      expect(screen.queryByTestId("stub-create-bot-form")).toBeNull();
      expect(screen.queryByTestId("bot-onboarding-area")).toBeNull();
      expect(screen.queryByTestId("bot-onboarding-open")).toBeNull();
    },
  );
});

describe("<TeamBotSetupDialog /> bounding its height to the viewport", () => {
  const completedChoice = {
    areas: ["alerts"],
    chosenAt: 1_000,
    completedAt: 2_000,
    pending: [],
  };

  it.each([
    {
      label: "the create-bot form",
      read: { ...UNLOCKED, choice: completedChoice },
      botCount: 3,
      body: () => screen.getByTestId("stub-create-bot-form"),
    },
    {
      label: "the GitHub step",
      read: LOCKED,
      botCount: 0,
      body: () => screen.getByTestId("bot-onboarding-connect-github"),
    },
    {
      label: "the bots step",
      read: UNLOCKED,
      botCount: 0,
      body: () => screen.getAllByTestId("bot-onboarding-area")[0],
    },
  ])(
    "caps the dialog at the viewport and scrolls $label between its header and footer",
    ({ read, botCount, body }) => {
      mount({ read, botCount });

      expect(
        dialog().classList.contains("max-h-[min(86dvh,calc(100dvh-2rem))]"),
      ).toBe(true);
      expect(dialog().classList.contains("overflow-hidden")).toBe(true);
      const scroller = body().closest<HTMLElement>(".overflow-y-auto");
      if (scroller === null || !dialog().contains(scroller)) {
        throw new Error("The branch's body is not a scroller of the dialog");
      }
      // Shrinks inside the grid's flexible row instead of growing the box.
      expect(scroller.classList.contains("min-h-0")).toBe(true);
    },
  );
});

describe("<TeamBotSetupDialog /> returning focus", () => {
  const completedChoice = {
    areas: ["alerts"],
    chosenAt: 1_000,
    completedAt: 2_000,
    pending: [],
  };

  it.each([
    {
      label: "Escape",
      dismiss: (user: UserEvent) => user.keyboard("{Escape}"),
    },
    {
      label: "the Close button",
      dismiss: (user: UserEvent) =>
        user.click(screen.getByRole("button", { name: "Close" })),
    },
  ])(
    "gives focus back to the control that opened it on $label",
    async ({ dismiss }) => {
      const user = userEvent.setup();
      const opener = mountClosed({
        read: { ...UNLOCKED, choice: completedChoice },
        botCount: 3,
      });
      await user.click(opener);
      await screen.findByTestId("team-bot-setup-dialog");

      await dismiss(user);

      await waitFor(() => {
        expect(screen.queryByTestId("team-bot-setup-dialog")).toBeNull();
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(opener);
      });
    },
  );

  it("leaves focus off the opener when Create opens the first channel and closes", async () => {
    const user = userEvent.setup();
    const opener = mountClosed({ read: UNLOCKED, botCount: 0 });
    await user.click(opener);
    const focus = vi.spyOn(opener, "focus");

    await user.click(await screen.findByTestId("bot-onboarding-open"));

    await waitFor(() => {
      expect(screen.queryByTestId("team-bot-setup-dialog")).toBeNull();
    });
    // The dialog hands focus back one task after it unmounts: run past that.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(opener);
  });
});
