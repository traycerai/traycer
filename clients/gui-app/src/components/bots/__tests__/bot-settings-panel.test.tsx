/**
 * A bot's settings (Tracy Bots). Model: the picker opens on what the bot
 * RUNS, not on the app default, so Apply has nothing to apply until the
 * person changes something. The toolbar-store hook is replaced by one that
 * records the seed source it was given and builds a REAL toolbar store from
 * it, so what the picker would show and what Apply compares are the
 * production store's own values.
 *
 * No control is gated on which host serves the tab (the panel takes no
 * `canEdit`): every control is live, and a host that refuses a write has the
 * refusal shown in place, under the control that made it.
 */
import { StrictMode, useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  BotMemoryEntry,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import {
  SLACK_APP_REFUSAL_BOT_NOT_FOUND,
  SLACK_APP_REFUSAL_NOT_CONFIGURED,
  type SlackAppRegisterRequest,
} from "@traycer/protocol/host/slack-app";
import type {
  SlackAppManifestResult,
  SlackAppReadResult,
} from "@traycer-clients/shared/host-client/slack-app";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { SLACK_SETTINGS_UNAVAILABLE_IN_STAGING } from "@traycer-clients/shared/host-client/slack-app";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  BotIdentityContext,
  type BotIdentity,
  type BotOwner,
} from "@/components/bots/bot-identity-context";
import {
  BotMemoryContext,
  type BotMemoryAccess,
} from "@/components/bots/bot-memory-context";
import type { BotMemoryReading } from "@/hooks/bots/use-bot-memory";
import {
  memoryRailOver,
  useBotOpenThreadStore,
} from "@/stores/bots/bot-open-thread-store";
import type { ComposerSeedSource } from "@/lib/composer/composer-seed-source";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { ModelOption } from "@/components/home/data/landing-options";
import {
  maxModeListedFor,
  type MaxModeContext,
} from "@/components/home/data/model-max-mode";

function memoryEntry(index: number): BotMemoryEntry {
  return {
    id: `memory-${index}`,
    text: `Memory ${index}`,
    tags: ["bot_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    writtenBy: { botId: null, chatId: "trunk-1", requestId: null },
    at: 1_000,
    confirmedAt: 1_000,
  };
}

const mocks = vi.hoisted(() => ({
  hostClient: { stub: "tab-host-client" },
  seeds: [] as ComposerSeedSource[],
  stores: [] as ComposerToolbarStore[],
  // Every `maxModeContext` the (stubbed) picker was rendered with, one per render.
  pickerContexts: [] as MaxModeContext[],
  updateRunSettings: vi.fn<(variables: object) => void>(),
  // The client each `useBotUpdateRunSettingsMutation` call was handed.
  runSettingsClients: [] as Array<object | null>,
  updateTitle: vi.fn<(variables: object) => void>(),
  deleteBot: vi.fn<(variables: object) => void>(),
  updateReplyMode: vi.fn<(variables: object) => void>(),
  setNotificationLevel: vi.fn<(variables: object) => void>(),
  // The levels `bot.notificationLevel.read` answers; `undefined` = unread.
  notificationLevels: {} as Record<string, string> | undefined,
  // What it answers for the notification-level methods.
  notificationSupport: true as boolean | null,
  // What the levels read and the level write report as their error.
  notificationReadError: null as string | null,
  notificationWriteError: null as string | null,
  // Whether the level write is in flight.
  notificationPending: false,
  // What it answers for `bot.updateReplyMode`.
  replyModeSupport: true as boolean | null,
  // Whether the reply-mode write is in flight.
  replyModePending: false,
  supportQueries: [] as Array<{ hostId: string | null; method: string }>,
  // Whether the tab's host advertises `host.usage.summary`.
  usageSupported: false,
  // The host each read of that support asked about.
  usageSupportHosts: [] as Array<string | null>,
  // What the bot's memory reads as (`useBotMemory`); `null` = unsupported.
  memoryEntries: null as number | "loading" | null,
  // The binding `useHostBinding` answers: its `auth` is the Slack adapter.
  binding: null as { readonly auth: object } | null,
  // What each write's mutation reports as its error; `null` = no refusal.
  refusal: {
    title: null as string | null,
    runSettings: null as string | null,
    remove: null as string | null,
    replyMode: null as string | null,
  },
}));

function refusalOf(message: string | null): { message: string } | null {
  return message === null ? null : { message };
}

// The Slack group reads `binding.auth`; everything else of `@/lib/host` stays real.
vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return { ...actual, useHostBinding: () => mocks.binding };
});
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    if (method.startsWith("bot.notificationLevel.")) {
      return mocks.notificationSupport;
    }
    return method === "bot.updateReplyMode" ? mocks.replyModeSupport : null;
  },
}));
vi.mock("@/hooks/usage-analytics/use-usage-summary-support", () => ({
  useUsageSummarySupported: (hostId: string | null) => {
    mocks.usageSupportHosts.push(hostId);
    return mocks.usageSupported;
  },
}));
// The memory pane has its own suite (`bot-memory-pane.test.tsx`); here the
// entry only counts what the stream reads.
vi.mock("@/hooks/bots/use-bot-memory", () => ({
  useBotMemory: (): BotMemoryReading => {
    if (mocks.memoryEntries === null) return { kind: "unsupported" };
    if (mocks.memoryEntries === "loading") return { kind: "loading" };
    return {
      kind: "ready",
      memory: {
        entries: Array.from({ length: mocks.memoryEntries }, (_, index) =>
          memoryEntry(index),
        ),
        own: { entries: mocks.memoryEntries, chars: 0, ceiling: 8_000 },
        shared: { entries: 0, chars: 0, ceiling: 8_000 },
      },
    };
  },
}));
// The usage dialog has its own suite; here it only shows which epic it reads.
vi.mock("@/components/epic-canvas/panels/epic-usage-dialog", () => ({
  EpicUsageDialog: (props: { epicId: string; open: boolean }) =>
    props.open ? (
      <div data-testid="stub-usage-dialog" data-epic-id={props.epicId} />
    ) : null,
}));
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: { maxModeContext: MaxModeContext }) => {
    mocks.pickerContexts.push(props.maxModeContext);
    return <div data-testid="stub-harness-model-picker" />;
  },
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotUpdateTitleMutation: () => ({
    isPending: false,
    error: refusalOf(mocks.refusal.title),
    mutate: mocks.updateTitle,
  }),
  useBotDeleteMutation: () => ({
    isPending: false,
    error: refusalOf(mocks.refusal.remove),
    mutate: mocks.deleteBot,
  }),
  useBotUpdateRunSettingsMutation: (client: object | null) => {
    mocks.runSettingsClients.push(client);
    return {
      isPending: false,
      error: refusalOf(mocks.refusal.runSettings),
      mutate: mocks.updateRunSettings,
    };
  },
  useBotUpdateReplyModeMutation: () => ({
    isPending: mocks.replyModePending,
    error: refusalOf(mocks.refusal.replyMode),
    mutate: mocks.updateReplyMode,
  }),
}));
vi.mock("@/hooks/bots/use-bot-notification-level", () => ({
  useBotNotificationLevelsQuery: (
    _client: unknown,
    _botId: string,
    enabled: boolean,
  ) => ({
    data:
      enabled && mocks.notificationLevels !== undefined
        ? { levels: mocks.notificationLevels }
        : undefined,
    error: refusalOf(mocks.notificationReadError),
  }),
  useBotNotificationLevelSetMutation: () => ({
    isPending: mocks.notificationPending,
    error: refusalOf(mocks.notificationWriteError),
    mutate: mocks.setNotificationLevel,
  }),
}));
vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  return {
    useComposerToolbarStore: (
      _registerAs: string | null,
      seedSource: ComposerSeedSource,
    ): ComposerToolbarStore => {
      mocks.seeds.push(seedSource);
      const [store] = useState(() => {
        const settings =
          seedSource.kind === "none" ? null : seedSource.settings;
        const created = createComposerToolbarStore({
          purpose: "run",
          reasoningFallback: "model-default",
          seedKey: "bot-settings-test",
          values: {
            ultracode: false,
            permission: settings?.permissionMode ?? "supervised",
            selection: {
              harnessId: settings?.harnessId ?? "codex",
              modelSlug: settings?.model ?? "model-a",
              profileId: settings?.profileId ?? null,
            },
            reasoning: settings?.reasoningEffort ?? "",
            serviceTier: "",
          },
          onSettingsChange: null,
          tuiOnly: false,
          chatLineCarriesAutoMode: null,
          ultracodeCarried: false,
          hostId: "host-1",
        });
        return created;
      });
      // StrictMode runs the initializer twice and keeps one result, so the
      // store in use is the one the hook returns, recorded here.
      mocks.stores.push(store);
      return store;
    },
  };
});

import { BotChannelSettingsPanel } from "@/components/bots/bot-settings-panel";
import { AuthService } from "@/lib/auth/auth-service";
import { createAppQueryClient } from "@/lib/query-client";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotSlackPendingInstallStore } from "@/stores/bots/bot-slack-pending-install-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

const BOT: BotRecord = {
  botId: "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environmentId: "env-personal",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "model-b",
  effort: "high",
  profile: "profile-1",
  trunkChatId: "trunk-1",
  boundHostId: "host-1",
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: null,
};

// The Slack group's world: a real in-memory runner host behind the five
// AuthService calls, an app-wide query client, and a signed-in person.
let slackHost: MockRunnerHost;
let queryClient: QueryClient;
// What the Slack calls answer instead of the mock, for the refusals the mock
// does not produce (a server without Slack, a bot the caller is not in).
const slackOverrides: {
  read: SlackAppReadResult | null;
  manifest: SlackAppManifestResult | null;
} = { read: null, manifest: null };
const SLACK_BEARER = "test-bearer";

function newSlackHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function newSlackAuth(host: MockRunnerHost): object {
  return {
    readSlackApp: async (botId: string) =>
      slackOverrides.read ?? host.readSlackApp(SLACK_BEARER, botId),
    getSlackAppManifest: async (botId: string) =>
      slackOverrides.manifest ?? host.getSlackAppManifest(SLACK_BEARER, botId),
    registerSlackApp: (request: SlackAppRegisterRequest) =>
      host.registerSlackApp(SLACK_BEARER, request),
    mintSlackAppInstallUrl: (botId: string) =>
      host.mintSlackAppInstallUrl(SLACK_BEARER, botId),
    disconnectSlackApp: (botId: string) =>
      host.disconnectSlackApp(SLACK_BEARER, botId),
  };
}

function inProviders(children: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext value={slackHost}>{children}</RunnerHostContext>
    </QueryClientProvider>
  );
}

/** The channel settings panel, as it first opens: nothing folded. */
function mountPanel(bot: BotRecord, personal: boolean): void {
  render(
    inProviders(
      <StrictMode>
        <BotChannelSettingsPanel
          bot={bot}
          personal={personal}
          channelId={null}
          environmentBots={null}
          onClose={vi.fn()}
        />
      </StrictMode>,
    ),
  );
}

function applyButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Apply" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Apply is not a button element");
  }
  return button;
}

function liveStore(): ComposerToolbarStore {
  const store = mocks.stores.at(-1);
  if (store === undefined) throw new Error("no toolbar store was created");
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  slackHost = newSlackHost();
  slackOverrides.read = null;
  slackOverrides.manifest = null;
  mocks.binding = { auth: newSlackAuth(slackHost) };
  queryClient = createAppQueryClient();
  useBotSlackPendingInstallStore.setState({ entries: {} });
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-1", userName: "user-1", email: "u@example.com" },
    contextMetadata: { userId: "user-1", username: "user-1" },
  });
  mocks.seeds.length = 0;
  mocks.stores.length = 0;
  mocks.pickerContexts.length = 0;
  mocks.runSettingsClients.length = 0;
  mocks.refusal.title = null;
  mocks.refusal.runSettings = null;
  mocks.refusal.remove = null;
  mocks.refusal.replyMode = null;
  mocks.replyModeSupport = true;
  mocks.replyModePending = false;
  mocks.supportQueries.length = 0;
  mocks.usageSupported = false;
  mocks.usageSupportHosts.length = 0;
  mocks.memoryEntries = null;
  mocks.notificationLevels = {};
  mocks.notificationSupport = true;
  mocks.notificationReadError = null;
  mocks.notificationWriteError = null;
  mocks.notificationPending = false;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
});

describe("<BotChannelSettingsPanel /> model", () => {
  it("seeds the picker with what the bot runs and leaves Apply disabled", () => {
    mountPanel(BOT, false);

    const seed = mocks.seeds.at(-1);
    expect(seed).toEqual({
      kind: "fallback",
      settings: {
        ultracode: false,
        harnessId: "claude",
        model: "model-b",
        permissionMode: useSettingsStore.getState().defaultPermission,
        reasoningEffort: "high",
        serviceTier: null,
        agentMode: "regular",
        profileId: "profile-1",
      },
      client: mocks.hostClient,
    });
    expect(applyButton().disabled).toBe(true);
  });

  it("says only that the next turn uses what is applied, not what the bot runs on", () => {
    mountPanel(BOT, false);

    expect(
      screen.getByText("The next turn uses what you apply here."),
    ).toBeTruthy();
    expect(screen.getByTestId("stub-harness-model-picker")).toBeTruthy();
    expect(screen.queryByText(/Runs on/)).toBeNull();
  });

  it("enables Apply once the person picks another model, and applies exactly that", async () => {
    const user = userEvent.setup();
    mountPanel(BOT, false);
    expect(applyButton().disabled).toBe(true);

    act(() => {
      liveStore().getState().setSelection({
        harnessId: "claude",
        modelSlug: "model-c",
        profileId: "profile-1",
      });
    });
    expect(applyButton().disabled).toBe(false);

    await user.click(applyButton());
    expect(mocks.updateRunSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateRunSettings).toHaveBeenCalledWith({
      botId: BOT.botId,
      harness: "claude",
      model: "model-c",
      effort: "high",
      profile: "profile-1",
    });
    expect(mocks.runSettingsClients.at(-1)).toBe(mocks.hostClient);
  });

  it("disables Apply again when the person picks the bot's own model back", () => {
    mountPanel(BOT, false);

    act(() => {
      liveStore().getState().setSelection({
        harnessId: "claude",
        modelSlug: "model-c",
        profileId: "profile-1",
      });
    });
    expect(applyButton().disabled).toBe(false);

    act(() => {
      liveStore().getState().setSelection({
        harnessId: "claude",
        modelSlug: "model-b",
        profileId: "profile-1",
      });
    });
    expect(applyButton().disabled).toBe(true);
  });

  it("seeds nothing when the bot's harness is not one this client can pick", () => {
    mountPanel({ ...BOT, harness: "not-a-harness" }, false);

    expect(mocks.seeds.at(-1)).toEqual({ kind: "none" });
  });
});

describe("<BotChannelSettingsPanel /> controls", () => {
  it("renames through the tab host with the trimmed name", async () => {
    const user = userEvent.setup();
    mountPanel(BOT, false);

    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "  Renamed Bot  ");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(mocks.updateTitle).toHaveBeenCalledTimes(1);
    expect(mocks.updateTitle.mock.calls[0][0]).toEqual({
      botId: BOT.botId,
      title: "Renamed Bot",
    });
  });
});

describe("<BotChannelSettingsPanel /> refusals", () => {
  it("shows no refusal line while every write is accepted", () => {
    mountPanel(BOT, false);

    expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();
  });

  it("states a rename refusal under the name field, and nowhere else", () => {
    mocks.refusal.title = "Only the bot's owner can rename it";
    mountPanel(BOT, false);

    const refusals = screen.getAllByTestId("bot-settings-refusal");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].textContent).toBe("Only the bot's owner can rename it");
    expect(refusals[0].getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("bot-settings-title").contains(refusals[0])).toBe(
      true,
    );
  });

  it("states a model refusal inside the model section, and nowhere else", () => {
    mocks.refusal.runSettings = "This machine cannot change the model";
    mountPanel(BOT, false);

    const refusals = screen.getAllByTestId("bot-settings-refusal");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].textContent).toBe(
      "This machine cannot change the model",
    );
    expect(screen.getByTestId("bot-settings-model").contains(refusals[0])).toBe(
      true,
    );
  });

  it("states a delete refusal inside the confirm dialog, not on the panel", async () => {
    const user = userEvent.setup();
    mocks.refusal.remove = "Only the bot's owner can delete it";
    mountPanel(BOT, false);
    // Closed: the refusal lives in the dialog, which is not rendered yet.
    expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete bot" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("bot-settings-refusal").textContent).toBe(
      "Only the bot's owner can delete it",
    );
    expect(mocks.deleteBot).not.toHaveBeenCalled();
  });

  it("deletes the bot when the confirm dialog is confirmed", async () => {
    const user = userEvent.setup();
    mountPanel(BOT, false);

    await user.click(screen.getByRole("button", { name: "Delete bot" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Delete bot" }),
    );

    expect(mocks.deleteBot).toHaveBeenCalledTimes(1);
    expect(mocks.deleteBot.mock.calls[0][0]).toEqual({ botId: BOT.botId });
  });
});

describe("<BotChannelSettingsPanel /> reply mode", () => {
  function radio(name: string): HTMLElement {
    return screen.getByRole("radio", { name });
  }

  it("offers both ways of answering, checked on the bot's own reply mode", () => {
    mountPanel({ ...BOT, replyMode: "direct" }, true);

    const section = screen.getByTestId("bot-settings-reply-mode");
    expect(
      within(section).getByRole("radiogroup", { name: "Replies" }),
    ).toBeTruthy();
    expect(radio("In the channel").getAttribute("aria-checked")).toBe("true");
    expect(radio("In a thread").getAttribute("aria-checked")).toBe("false");
    expect(mocks.supportQueries).toContainEqual({
      hostId: "host-1",
      method: "bot.updateReplyMode",
    });
  });

  it("checks the thread option for a bot that answers in threads", () => {
    mountPanel(BOT, true);

    expect(radio("In a thread").getAttribute("aria-checked")).toBe("true");
    expect(radio("In the channel").getAttribute("aria-checked")).toBe("false");
  });

  it("writes the other reply mode with the bot's id when the person picks it", async () => {
    const user = userEvent.setup();
    mountPanel(BOT, true);

    await user.click(radio("In the channel"));

    expect(mocks.updateReplyMode).toHaveBeenCalledTimes(1);
    expect(mocks.updateReplyMode.mock.calls[0][0]).toEqual({
      botId: BOT.botId,
      replyMode: "direct",
    });
  });

  it("writes nothing when the person picks the mode the bot already has", async () => {
    const user = userEvent.setup();
    mountPanel(BOT, true);

    await user.click(radio("In a thread"));

    expect(mocks.updateReplyMode).not.toHaveBeenCalled();
  });

  it("states a refusal inside the reply mode section, and nowhere else", () => {
    mocks.refusal.replyMode = "A team's bot always answers in threads";
    mountPanel(BOT, true);

    const refusals = screen.getAllByTestId("bot-settings-refusal");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].textContent).toBe(
      "A team's bot always answers in threads",
    );
    expect(
      screen.getByTestId("bot-settings-reply-mode").contains(refusals[0]),
    ).toBe(true);
  });

  it("locks the choice while a write is in flight", () => {
    mocks.replyModePending = true;
    mountPanel(BOT, true);

    expect(radio("In the channel").hasAttribute("disabled")).toBe(true);
    expect(radio("In a thread").hasAttribute("disabled")).toBe(true);
  });

  it("draws no reply mode section for a team environment's bot", () => {
    mountPanel(BOT, false);

    expect(screen.queryByTestId("bot-settings-reply-mode")).toBeNull();
  });

  it.each([false, null])(
    "draws no reply mode section for a host whose support for bot.updateReplyMode is %s",
    (support) => {
      mocks.replyModeSupport = support;
      mountPanel(BOT, true);

      expect(screen.queryByTestId("bot-settings-reply-mode")).toBeNull();
    },
  );
});

// The bot's next turn runs its stored harness/model/effort/profile with NO
// service tier (`serviceTier: null`), so the pre-send Max Mode label must be
// keyed on that exact tuple: the bot's effort, Fast off.
describe("<BotChannelSettingsPanel /> Max Mode label", () => {
  const CURSOR_BOT: BotRecord = {
    ...BOT,
    harness: "cursor",
    model: "cursor-max",
    effort: "high",
  };

  function cursorRow(
    chat: ReadonlyArray<{ reasoningEffort: string | null; fast: boolean }>,
  ): ModelOption {
    return {
      harnessId: "cursor",
      slug: "cursor-max",
      label: "Cursor Max",
      description: null,
      contextWindow: null,
      maxOutputTokens: null,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: ["low", "high"].map((id) => ({
        id,
        label: id,
        description: null,
      })),
      defaultServiceTier: null,
      supportedServiceTiers: [],
      deprecationNotice: null,
      metadata: {
        maxMode: { chat, judge: [], fastServiceTierId: "fast" },
      },
    };
  }

  function lastContext(): MaxModeContext {
    const context = mocks.pickerContexts.at(-1);
    if (context === undefined) throw new Error("the picker never rendered");
    return context;
  }

  it("hands the picker the bot's own tuple: its effort and Fast off, never the none context", () => {
    mountPanel(CURSOR_BOT, false);

    expect(lastContext()).toEqual({
      kind: "chat",
      tuple: { reasoningEffort: "high", serviceTier: null },
    });
  });

  it("lists Max at the bot's selected effort with Fast off", () => {
    mountPanel(CURSOR_BOT, false);

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "high", fast: false }]),
        lastContext(),
      ),
    ).toBe(true);
  });

  it("does not list Max when only another effort is Max-only", () => {
    mountPanel(CURSOR_BOT, false);

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "low", fast: false }]),
        lastContext(),
      ),
    ).toBe(false);
  });

  it("does not list Max when only the Fast-on selection is Max-only", () => {
    mountPanel(CURSOR_BOT, false);

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "high", fast: true }]),
        lastContext(),
      ),
    ).toBe(false);
  });

  it("does not re-render the owner (and so the picker) when only the catalog moves", () => {
    mountPanel(CURSOR_BOT, false);
    const apply = () =>
      act(() => {
        liveStore().getState().setCatalog({
          hostId: "host-1",
          chatLineCarriesAutoMode: null,
          ultracodeCarried: false,
          keepsUnavailablePick: false,
          harnesses: undefined,
          modelsHarnessId: "cursor",
          models: [],
          modelsLoaded: false,
          tuiOnly: false,
        });
      });
    // The first write may settle derived state; a second write with fresh
    // arrays and the same values must not render the owner again. A broad
    // `useStore(toolbarStore)` there feeds the catalog effect that owns the
    // write, which is the update-depth loop.
    apply();
    const settled = mocks.pickerContexts.length;
    apply();
    apply();

    expect(mocks.pickerContexts.length).toBe(settled);
  });
});

describe("<BotChannelSettingsPanel /> as the channel's settings", () => {
  const CHANNEL = "conversation-app";
  const TEAM_OWNER: BotOwner = {
    kind: "team",
    name: "Acme",
    members: [
      { userId: "user-1", displayName: "Ada", avatarUrl: null },
      { userId: "user-2", displayName: null, avatarUrl: null },
    ],
  };
  const OTHER_BOT: BotRecord = {
    ...BOT,
    botId: "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    title: "Triage Bot",
  };

  function mountChannelPanel(input: {
    readonly personal: boolean;
    readonly owner: BotOwner | null;
    readonly environmentBots: ReadonlyArray<BotRecord> | null;
  }): Mock<() => void> {
    const onClose = vi.fn<() => void>();
    const identity: BotIdentity = {
      botId: BOT.botId,
      title: BOT.title,
      owner: input.owner,
    };
    render(
      inProviders(
        <BotIdentityContext value={identity}>
          <BotChannelSettingsPanel
            bot={BOT}
            personal={input.personal}
            channelId={CHANNEL}
            environmentBots={input.environmentBots}
            onClose={onClose}
          />
        </BotIdentityContext>,
      ),
    );
    return onClose;
  }

  function groupTitles(): ReadonlyArray<string | null> {
    return within(screen.getByTestId("bot-channel-settings"))
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
  }

  /**
   * Nothing in the panel is folded, and nothing in it is about the main bot:
   * the sidebar's star says which bot is main, and its row's menu hands it
   * over.
   */
  function expectNothingFoldedAndNoMainBot(): void {
    const panel = screen.getByTestId("bot-channel-settings");
    expect(
      within(panel).queryByRole("button", { name: "Advanced" }),
    ).toBeNull();
    expect(within(panel).queryByText(/main bot/i)).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: "Make main" }),
    ).toBeNull();
  }

  it("groups a team bot's channel: details with its members, the model, notifications, its bots and delete", () => {
    mountChannelPanel({
      personal: false,
      owner: TEAM_OWNER,
      environmentBots: [
        BOT,
        OTHER_BOT,
        { ...OTHER_BOT, botId: "b3", archivedAt: 5 },
      ],
    });

    expect(groupTitles()).toEqual([
      "Details",
      "Model",
      "Notifications",
      "Bots in this channel",
      "Slack",
    ]);
    const owner = screen.getByTestId("bot-settings-owner");
    expect(owner.textContent).toBe(
      "Managed byAcmeWho can message itMembers of Acme",
    );
    const members = screen.getByTestId("bot-settings-members");
    expect(members.textContent).toContain("2 members");
    expect(
      within(members)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Ada", "user-2"]);
    const bots = screen.getByTestId("bot-settings-bots");
    expect(
      within(bots)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["RBRelease Bot", "TBTriage Bot"]);
    // A team bot always answers in threads: no reply mode here.
    expect(screen.queryByTestId("bot-settings-reply-mode")).toBeNull();
    // The model picker is drawn without a click.
    expect(
      within(screen.getByTestId("bot-settings-model")).getByTestId(
        "stub-harness-model-picker",
      ),
    ).toBeTruthy();
    expectNothingFoldedAndNoMainBot();
    expect(screen.getByTestId("bot-settings-delete")).toBeTruthy();
  });

  it("opens the bot's usage from View usage, as the bot's own epic, where the host can read it", async () => {
    const user = userEvent.setup();
    mocks.usageSupported = true;
    mountChannelPanel({ personal: true, owner: null, environmentBots: null });

    expect(groupTitles()).toContain("Usage");
    // Whether the host can read usage is asked of the tab's own host.
    expect(new Set(mocks.usageSupportHosts)).toEqual(new Set(["host-1"]));
    expect(screen.queryByTestId("stub-usage-dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "View usage" }));

    expect(
      screen.getByTestId("stub-usage-dialog").getAttribute("data-epic-id"),
    ).toBe(BOT.botId);
  });

  it("offers no usage on a host that cannot read it", () => {
    mountChannelPanel({ personal: true, owner: null, environmentBots: null });

    expect(groupTitles()).not.toContain("Usage");
    expect(screen.queryByRole("button", { name: "View usage" })).toBeNull();
    expect(new Set(mocks.usageSupportHosts)).toEqual(new Set(["host-1"]));
  });

  describe("what it knows", () => {
    function mountKnowingPanel(): Mock<() => void> {
      const onClose = vi.fn<() => void>();
      const access: BotMemoryAccess = {
        hostId: "host-1",
        botId: BOT.botId,
        environmentId: BOT.environmentId,
        open: () =>
          useBotOpenThreadStore
            .getState()
            .setRail(
              BOT.botId,
              memoryRailOver(
                useBotOpenThreadStore.getState().byBotId[BOT.botId] ?? null,
              ),
            ),
      };
      render(
        inProviders(
          <BotMemoryContext value={access}>
            <BotChannelSettingsPanel
              bot={BOT}
              personal
              channelId={CHANNEL}
              environmentBots={null}
              onClose={onClose}
            />
          </BotMemoryContext>,
        ),
      );
      return onClose;
    }

    beforeEach(() => {
      useBotOpenThreadStore.setState({ byBotId: {} });
    });

    it("counts the memories and opens them where the bot's card opens them, closing the settings", async () => {
      const user = userEvent.setup();
      mocks.memoryEntries = 3;
      const onClose = mountKnowingPanel();

      const usage = screen.getByTestId("bot-settings-usage");
      expect(
        within(usage).queryByRole("button", { name: "View usage" }),
      ).toBeNull();
      const entry = within(usage).getByTestId("bot-settings-memory-open");
      expect(entry.textContent).toBe("What it knows · 3 memories");
      await user.click(entry);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(useBotOpenThreadStore.getState().byBotId[BOT.botId]).toEqual({
        kind: "memory",
        back: null,
      });
    });

    it("sits beside View usage where the host can read usage", () => {
      mocks.usageSupported = true;
      mocks.memoryEntries = 2;
      mountKnowingPanel();

      expect(
        within(screen.getByTestId("bot-settings-usage"))
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["View usage", "What it knows · 2 memories"]);
    });

    it.each([
      [1, "What it knows · 1 memory"],
      ["loading" as const, "What it knows"],
    ])("reads %s as %s", (entries, label) => {
      mocks.memoryEntries = entries;
      mountKnowingPanel();

      expect(screen.getByTestId("bot-settings-memory-open").textContent).toBe(
        label,
      );
    });

    it("offers nothing on a host that cannot serve the memory, and no empty Usage group", () => {
      mountKnowingPanel();

      expect(screen.queryByTestId("bot-settings-memory-open")).toBeNull();
      expect(groupTitles()).not.toContain("Usage");
    });
  });

  it("groups a personal bot's channel with its reply mode and the model after it, and no members or bots", () => {
    mountChannelPanel({
      personal: true,
      owner: {
        kind: "person",
        userId: "user-1",
        name: "Olive Owner",
        avatarUrl: null,
      },
      environmentBots: [BOT],
    });

    expect(groupTitles()).toEqual([
      "Details",
      "Model",
      "Notifications",
      "Slack",
    ]);
    expect(screen.getByTestId("bot-settings-owner").textContent).toBe(
      "Managed byOlive OwnerWho can message itOnly you",
    );
    // Replies ends Details, so the Model group follows it.
    expect(
      within(screen.getByTestId("bot-settings-details")).getByTestId(
        "bot-settings-reply-mode",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("bot-settings-model")).getByTestId(
        "stub-harness-model-picker",
      ),
    ).toBeTruthy();
    expectNothingFoldedAndNoMainBot();
    expect(screen.queryByTestId("bot-settings-members")).toBeNull();
  });

  it("closes on Escape from inside it, and not on the Escape that closes its delete confirmation", async () => {
    const user = userEvent.setup();
    const onClose = mountChannelPanel({
      personal: true,
      owner: null,
      environmentBots: null,
    });

    const panel = screen.getByTestId("bot-channel-settings");
    expect(panel.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole("button", { name: "Delete bot" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    within(screen.getByTestId("bot-settings-title"))
      .getByRole("textbox")
      .focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  const PERSON_OWNER: BotOwner = {
    kind: "person",
    userId: "user-1",
    name: "Olive Owner",
    avatarUrl: null,
  };

  function checkedLevels(): ReadonlyArray<string> {
    const group = screen.getByRole("radiogroup", { name: "Notifications" });
    return ["All new messages", "Mentions and answers to me", "Nothing"].filter(
      (name) =>
        within(group)
          .getByRole("radio", { name })
          .getAttribute("aria-checked") === "true",
    );
  }

  it("reads a channel with no level set as All for a personal bot", () => {
    mountChannelPanel({
      personal: true,
      owner: PERSON_OWNER,
      environmentBots: null,
    });

    const checked = checkedLevels();
    expect(checked).toEqual(["All new messages"]);
  });

  it("reads a channel with no level set as Mentions for a team bot", () => {
    mountChannelPanel({
      personal: false,
      owner: TEAM_OWNER,
      environmentBots: null,
    });

    const checked = checkedLevels();
    expect(checked).toEqual(["Mentions and answers to me"]);
  });

  it("checks nothing while the owner is unknown", () => {
    mountChannelPanel({ personal: true, owner: null, environmentBots: null });

    expect(checkedLevels()).toEqual([]);
  });

  it.each([
    ["All new messages", "all"],
    ["Mentions and answers to me", "mentions"],
    ["Nothing", "off"],
  ])("choosing %s writes %s for this channel", async (name, level) => {
    const user = userEvent.setup();
    // The other two levels are the ones not currently set.
    mocks.notificationLevels = {
      [CHANNEL]: level === "off" ? "all" : "off",
    };
    mountChannelPanel({
      personal: true,
      owner: PERSON_OWNER,
      environmentBots: null,
    });

    const group = screen.getByRole("radiogroup", { name: "Notifications" });
    await user.click(within(group).getByRole("radio", { name }));
    expect(mocks.setNotificationLevel).toHaveBeenCalledTimes(1);
    expect(mocks.setNotificationLevel.mock.calls[0][0]).toEqual({
      botId: BOT.botId,
      conversationId: CHANNEL,
      level,
    });
  });

  it("checks Nothing for a channel set off, whatever another conversation is set to", () => {
    mocks.notificationLevels = { [CHANNEL]: "off", "other-channel": "all" };
    mountChannelPanel({
      personal: true,
      owner: PERSON_OWNER,
      environmentBots: null,
    });

    expect(
      screen
        .getByRole("radio", { name: "Nothing" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("locks the choice until the levels are read", () => {
    mocks.notificationLevels = undefined;
    mountChannelPanel({
      personal: true,
      owner: PERSON_OWNER,
      environmentBots: null,
    });

    for (const radio of screen.getAllByRole("radio", {
      name: /All new messages|Mentions and answers to me|Nothing/,
    })) {
      expect(radio.getAttribute("aria-checked")).toBe("false");
      expect(radio.hasAttribute("disabled")).toBe(true);
    }
  });

  it("keeps the choice locked while a level is being written", () => {
    mocks.notificationPending = true;
    mountChannelPanel({
      personal: true,
      owner: PERSON_OWNER,
      environmentBots: null,
    });

    const nothing = screen.getByRole("radio", { name: "Nothing" });
    expect(nothing.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("radio", { name: "All new messages" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("says in the group when the levels cannot be read, and the write's own refusal when it is refused", () => {
    mocks.notificationReadError = "host unreachable";
    mocks.notificationLevels = undefined;
    mountChannelPanel({ personal: true, owner: null, environmentBots: null });
    const group = screen.getByTestId("bot-settings-notifications");
    expect(within(group).getByRole("alert").textContent).toBe(
      "Couldn't read this channel's notifications.",
    );

    cleanup();
    mocks.notificationReadError = null;
    mocks.notificationLevels = {};
    mocks.notificationWriteError = "The bot was not found.";
    mountChannelPanel({ personal: true, owner: null, environmentBots: null });
    expect(
      within(screen.getByTestId("bot-settings-notifications")).getByRole(
        "alert",
      ).textContent,
    ).toBe("The bot was not found.");
  });

  it.each([false, null])(
    "draws no notifications for a host whose support for the level is %s",
    (support) => {
      mocks.notificationSupport = support;
      mountChannelPanel({ personal: true, owner: null, environmentBots: null });

      expect(screen.queryByTestId("bot-settings-notifications")).toBeNull();
    },
  );
});

describe("<BotChannelSettingsPanel /> Slack", () => {
  const CREDENTIALS: SlackAppRegisterRequest = {
    botId: BOT.botId,
    appId: "A07K2M9QX4T",
    clientId: "123.456",
    clientSecret: "client-secret-value",
    signingSecret: "signing-secret-value",
  };

  /** The channel panel as a personal bot's owner opens it. */
  function mountSlackPanel(): void {
    render(
      inProviders(
        <BotChannelSettingsPanel
          bot={BOT}
          personal
          channelId={null}
          environmentBots={null}
          onClose={vi.fn()}
        />,
      ),
    );
  }

  function slackGroup(): HTMLElement {
    return screen.getByTestId("bot-settings-slack");
  }

  /** Registers the credentials with the in-memory server, as a past session did. */
  async function seedRegisteredApp(): Promise<void> {
    const result = await slackHost.registerSlackApp(SLACK_BEARER, CREDENTIALS);
    expect(result.kind).toBe("ok");
  }

  /** Installs that app through the mock's own consent page. */
  async function seedInstalledApp(): Promise<void> {
    await seedRegisteredApp();
    const minted = await slackHost.mintSlackAppInstallUrl(
      SLACK_BEARER,
      BOT.botId,
    );
    if (minted.kind !== "ok")
      throw new Error("the mock refused an install URL");
    await slackHost.openExternalLink(minted.url);
  }

  it("shows the three steps, the server's manifest and the two helpers for a bot with no app", async () => {
    mountSlackPanel();

    const setup = await screen.findByTestId("bot-settings-slack-setup");
    const manifest = await within(setup).findByTestId(
      "bot-settings-slack-manifest",
    );
    const served = await slackHost.getSlackAppManifest(SLACK_BEARER, BOT.botId);
    if (served.kind !== "ok") throw new Error("the mock refused a manifest");
    expect(manifest.textContent).toBe(served.manifest);
    expect(
      within(setup)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Create a Slack app from this manifest.",
      "Paste the app's credentials from its Basic Information page.",
      "Install the app to your workspace.",
    ]);
    expect(
      within(setup).getByRole("button", { name: "Copy manifest" }),
    ).toBeTruthy();
    expect(
      within(setup).getByRole("button", { name: "Open api.slack.com/apps" }),
    ).toBeTruthy();
  });

  it("registers the four credentials in place, clears the form and keeps the secrets out of the caches", async () => {
    const user = userEvent.setup();
    const secrets = [CREDENTIALS.clientSecret, CREDENTIALS.signingSecret];
    let sawSecretMutation = false;
    queryClient.getMutationCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        JSON.stringify(event.mutation.state.variables).includes(secrets[0])
      ) {
        sawSecretMutation = true;
      }
    });
    mountSlackPanel();
    const group = slackGroup();
    await screen.findByTestId("bot-settings-slack-setup");

    await user.type(screen.getByLabelText("App ID"), CREDENTIALS.appId);
    await user.type(screen.getByLabelText("Client ID"), CREDENTIALS.clientId);
    await user.type(
      screen.getByLabelText("Client Secret"),
      CREDENTIALS.clientSecret,
    );
    await user.type(
      screen.getByLabelText("Signing Secret"),
      CREDENTIALS.signingSecret,
    );
    await user.click(screen.getByRole("button", { name: "Register" }));

    expect(
      (await screen.findByTestId("bot-settings-slack-status")).textContent,
    ).toBe("Registered, not installed.");
    // The same group element: the panel moved on without a remount.
    expect(slackGroup()).toBe(group);
    for (const label of [
      "App ID",
      "Client ID",
      "Client Secret",
      "Signing Secret",
    ]) {
      const field = screen.getByLabelText(label);
      expect(field instanceof HTMLInputElement && field.value).toBe("");
    }
    expect(sawSecretMutation).toBe(true);
    await waitFor(() => {
      const mutations = queryClient.getMutationCache().getAll();
      for (const mutation of mutations) {
        const variables = JSON.stringify(mutation.state.variables);
        for (const secret of secrets) expect(variables).not.toContain(secret);
      }
    });
    for (const query of queryClient.getQueryCache().getAll()) {
      const data = JSON.stringify(query.state.data);
      for (const secret of secrets) expect(data).not.toContain(secret);
    }
  });

  it("opens the install page from Install to workspace, waits for Slack, then shows the connected workspace", async () => {
    const user = userEvent.setup();
    await seedRegisteredApp();
    mountSlackPanel();

    await user.click(
      await screen.findByRole("button", { name: "Install to workspace" }),
    );

    // The mock's consent lands as the link opens, but the panel only learns
    // of it from its next read: the wait shows until the 2 s poll sees it.
    expect(
      await screen.findByTestId("bot-settings-slack-waiting"),
    ).toBeTruthy();
    expect(slackHost.openedExternalLinks).toHaveLength(1);
    const connected = await screen.findByTestId(
      "bot-settings-slack-connected",
      {},
      { timeout: 6_000 },
    );
    expect(within(connected).getByText("Mock workspace")).toBeTruthy();
    expect(within(connected).getByText(CREDENTIALS.appId)).toBeTruthy();
    expect(screen.queryByTestId("bot-settings-slack-waiting")).toBeNull();
  });

  it("shows the workspace the app left after Disconnect, with Install to workspace to come back", async () => {
    const user = userEvent.setup();
    await seedInstalledApp();
    mountSlackPanel();

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));

    expect(
      (await screen.findByTestId("bot-settings-slack-status")).textContent,
    ).toBe("Not installed in Mock workspace.");
    expect(
      within(slackGroup()).getByRole("button", {
        name: "Install to workspace",
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("bot-settings-slack-connected")).toBeNull();
  });

  it("shows the same line for an app Slack removed, when the settings are opened again", async () => {
    await seedInstalledApp();
    mountSlackPanel();
    await screen.findByTestId("bot-settings-slack-connected");
    cleanup();

    slackHost.uninstallSlackAppInSlack(BOT.botId);
    mountSlackPanel();

    expect(
      (await screen.findByTestId("bot-settings-slack-status")).textContent,
    ).toBe("Not installed in Mock workspace.");
    expect(
      within(slackGroup()).getByRole("button", {
        name: "Install to workspace",
      }),
    ).toBeTruthy();
  });

  it("replaces a connected app with the refusal when a later read says the person is not a member", async () => {
    await seedInstalledApp();
    mountSlackPanel();
    await screen.findByTestId("bot-settings-slack-connected");

    slackOverrides.read = {
      kind: "refused",
      status: 404,
      code: SLACK_APP_REFUSAL_BOT_NOT_FOUND,
    };
    await queryClient.invalidateQueries();

    const refusal = await within(slackGroup()).findByTestId(
      "bot-settings-refusal",
    );
    expect(refusal.textContent).toBe("You can't change this bot's Slack app.");
    expect(screen.queryByTestId("bot-settings-slack-connected")).toBeNull();
  });

  it("keeps the last-read app and says the read failed when a later read cannot reach the server", async () => {
    await seedInstalledApp();
    mountSlackPanel();
    await screen.findByTestId("bot-settings-slack-connected");

    slackOverrides.read = { kind: "network-error", detail: "x" };
    // The hook retries a transport failure twice, on the query client's own
    // backoff (1 s, then 2 s): the failure shows once those are spent.
    await queryClient.invalidateQueries();

    const refusal = await within(slackGroup()).findByTestId(
      "bot-settings-refusal",
    );
    expect(refusal.textContent).toBe(
      "Couldn't read this bot's Slack settings.",
    );
    expect(screen.getByTestId("bot-settings-slack-connected")).toBeTruthy();
  });

  it("shows that Slack settings are unavailable in this app, and sends no Slack request, on a build that cannot reach the server", async () => {
    const slackCalls = {
      readSlackApp: vi.fn<IRunnerHost["readSlackApp"]>(),
      getSlackAppManifest: vi.fn<IRunnerHost["getSlackAppManifest"]>(),
      registerSlackApp: vi.fn<IRunnerHost["registerSlackApp"]>(),
      mintSlackAppInstallUrl: vi.fn<IRunnerHost["mintSlackAppInstallUrl"]>(),
      disconnectSlackApp: vi.fn<IRunnerHost["disconnectSlackApp"]>(),
    };
    // The real AuthService floor over a runner host that reports the reason.
    const auth = new AuthService({
      runnerHost: createFakeRunnerHost({
        ...slackCalls,
        sandboxControlUnavailableReason: "no server here",
      }),
    });
    try {
      mocks.binding = { auth };
      mountSlackPanel();

      const line = await within(slackGroup()).findByTestId(
        "bot-settings-slack-unavailable",
      );
      expect(line.textContent).toBe(SLACK_SETTINGS_UNAVAILABLE_IN_STAGING);
      expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();
      expect(screen.queryByTestId("bot-settings-slack-setup")).toBeNull();
      for (const spy of Object.values(slackCalls)) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      auth.dispose();
    }
  });

  it("says only that Slack is unavailable on a server without it", async () => {
    slackOverrides.manifest = {
      kind: "refused",
      status: 503,
      code: SLACK_APP_REFUSAL_NOT_CONFIGURED,
    };
    mountSlackPanel();

    expect(
      (await screen.findByTestId("bot-settings-slack-unavailable")).textContent,
    ).toBe("Slack isn't available on this server.");
    expect(screen.queryByTestId("bot-settings-slack-manifest")).toBeNull();
    expect(screen.queryByTestId("bot-settings-slack-setup")).toBeNull();
  });

  it("tells a non-member in place that the bot's Slack app is not theirs to change", async () => {
    slackOverrides.read = {
      kind: "refused",
      status: 404,
      code: SLACK_APP_REFUSAL_BOT_NOT_FOUND,
    };
    mountSlackPanel();

    const refusal = await within(slackGroup()).findByTestId(
      "bot-settings-refusal",
    );
    expect(refusal.textContent).toBe("You can't change this bot's Slack app.");
    expect(screen.queryByTestId("bot-settings-slack-setup")).toBeNull();
  });
});
