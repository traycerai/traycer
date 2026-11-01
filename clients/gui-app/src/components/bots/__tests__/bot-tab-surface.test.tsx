/**
 * The Tracy surface (Tracy Bots): the surface asks `bot.open` through its own
 * host and follows the answer - serving, or paused with a reason - and never
 * names the machine a bot runs on or moves to it.
 * Also: the stream's states, the re-subscribe and re-open when the pane comes
 * back into view, the surface forgetting a channel's state and selecting the
 * default when the bot is gone from `bot.list`, and a team's main bot still
 * to be set up (T67): a channel on its id shows the channel where the team is
 * set up, with nothing opened, subscribed or forgotten (the real hook, over a
 * scripted `bot.onboarding.read`). Its Enable cloud
 * runs the real sandbox reads and create over a scripted control plane.
 * The three views and the bot's session view are replaced by stubs
 * that expose their props, so what the surface PASSES them is what is
 * asserted. The tab strip's Activity label
 * reads the real summary hook over the real agent-activity store.
 */
import { useAuthStore } from "@/stores/auth/auth-store";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  installShellForm,
  SHELL_WIDTH_COLUMN_256,
  SHELL_WIDTH_MENU,
  type ShellFormHarness,
} from "../../../../__tests__/mobile-level2-form-harness";
import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  SandboxCatalogueFetchResult,
  SandboxCreateFetchResult,
  SandboxListFetchResult,
  TraycerModelsFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  type SandboxCatalogue,
  type SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { SandboxDefaultsRead } from "@/hooks/sandboxes/use-sandbox-defaults";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxAuth,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type {
  BotOpenPausedReason,
  BotOpenResponse,
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { BotOnboardingSetup } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";
import type {
  BotThreadSummary,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import type { BotChannelLanding } from "@/components/bots/bot-channel-view";
import type { BotOpenSession } from "@/components/bots/bot-session-view";
import type {
  BotOpenMemory,
  BotOpenThread,
  BotSessionOpen,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";

type OpenResult =
  | { readonly kind: "answer"; readonly response: BotOpenResponse }
  | { readonly kind: "error"; readonly message: string };

type ReadScript = { setup: BotOnboardingSetup | null } | "fails";

/** The control plane a team's Enable cloud reads and creates through. */
interface TeamCloudBinding extends FakeSandboxBinding {
  readonly auth: FakeSandboxAuth & {
    readonly getTraycerModels: Mock<() => Promise<TraycerModelsFetchResult>>;
    readonly getSandboxCatalogue: Mock<
      () => Promise<SandboxCatalogueFetchResult>
    >;
  };
}

const mocks = vi.hoisted(() => ({
  hostClient: { stub: "tab-host-client" },
  /** The app's host binding; `null` (none) unless a case scripts one. */
  binding: null as TeamCloudBinding | null,
  /** What every configuration's `sandbox_defaults` read answers. */
  sandboxDefaults: { kind: "pending" } as SandboxDefaultsRead,
  resubscribe: vi.fn<() => void>(),
  /** The router's navigate, which the tab-navigation boundary below ignores. */
  navigate: vi.fn(),
  /** Every intent the surface asked the tab-navigation controller to activate. */
  activateTabIntent: vi.fn<(intent: unknown) => void>(),
  open: vi.fn<(variables: { botId: string }) => void>(),
  openMutation: {
    mutate: (
      variables: { botId: string },
      options: {
        onSuccess: (response: BotOpenResponse) => void;
        onError: (error: { message: string }) => void;
      },
    ): void => {
      mocks.open(variables);
      const result = mocks.state.openResult;
      if (result === null) return;
      if (result.kind === "answer") options.onSuccess(result.response);
      else options.onError({ message: result.message });
    },
  },
  /** The bots the tab subscribed to, in order. */
  subscribed: [] as string[],
  /** What `bot.onboarding.read` answers per environment id; absent is pending. */
  reads: {} as Record<string, ReadScript>,
  /** A read's `refetch`, which Retry calls on a failed `bot.onboarding.read`. */
  readRefetch: vi.fn<() => void>(),
  /** The bot list query's `refetch`; a case scripts what a re-read answers. */
  listRefetch: vi.fn<() => void>(),
  /** The environment list query's `refetch`. */
  environmentsRefetch: vi.fn<() => void>(),
  supportQueries: [] as Array<{ hostId: string | null; method: string }>,
  membersQueries: [] as Array<{
    environmentId: string | null;
    enabled: boolean;
  }>,
  useBotListChangedSubscriptionForHost:
    vi.fn<(hostId: string, enabled: boolean) => void>(),
  state: {
    snapshot: null as BotSubscriptionSnapshot | null,
    deleted: false,
    error: null as string | null,
    paneVisible: true,
    connectable: { hostIds: [] as string[], resolved: true },
    listedBotIds: undefined as string[] | undefined,
    /** Titles the list gives its bots; a bot not named is titled by its id. */
    listTitles: new Map<string, string>(),
    mainBotIds: null as Record<string, string> | null,
    support: null as boolean | null,
    /** Whether the host advertises `bot.onboarding.read`; `null` while unknown. */
    onboardingSupport: true,
    /** The line the host negotiated for `bot.onboarding.read`. */
    onboardingVersion: { major: 1, minor: 1 },
    /** When a successful `bot.onboarding.read` answered. */
    readAt: 1_000,
    /** A disabled read still holds what it answered before, as TanStack's
     * cache does across a reconnect. */
    readsCached: false,
    /**
     * The bot list's last read failed: its status is `error`, with the data
     * it had kept, or none when `listedBotIds` is `undefined` (a cold read).
     */
    listFailed: false,
    /** The environment list's status; `pending` carries no data. */
    environmentsStatus: "success",
    /** A failed environment list kept `environments` from before; else none. */
    environmentsKept: false,
    /** The bot list query's freshness, as TanStack reports it. */
    list: {
      dataUpdatedAt: 1_000,
      errorUpdatedAt: 0,
      isFetchedAfterMount: true,
      isFetching: false,
    },
    membersSupport: null as boolean | null,
    openResult: null as OpenResult | null,
    threads: [] as BotThreadSummary[],
    // No bot.thread.list answer is held yet (the first read is in flight).
    threadsHeld: true,
    // A read of bot.thread.list is in flight over the held `threads`.
    threadsFetching: false,
    // The last read of bot.thread.list failed.
    threadsError: false,
    environments: [] as Array<{
      environmentId: string;
      label: string;
      ownerKind: "organization" | "user";
    }>,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
// The tab-navigation controller is the boundary: it commits a selection when
// it acknowledges a navigation, which these cases read off the intents asked.
// The controller accepts and acknowledges at once, as a history push does:
// a Tracy channel is committed when its navigation lands.
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const { useTracySurfaceStore: surfaceStore } =
    await import("@/stores/bots/tracy-surface-store");
  return {
    ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
    activateTabIntent: (
      _navigate: unknown,
      intent: TabNavigationIntent,
      _options: unknown,
    ) => {
      mocks.activateTabIntent(intent);
      if (intent.kind === "tracy") {
        surfaceStore.getState().selectChannel(intent.botId);
      }
      return true;
    },
  };
});
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    if (method === "environment.members") return mocks.state.membersSupport;
    if (method === "bot.onboarding.read") return mocks.state.onboardingSupport;
    return mocks.state.support;
  },
  useHostMethodSchemaVersion: () => mocks.state.onboardingVersion,
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    return true;
  },
}));
// The host RPC boundary: `bot.onboarding.read` answers what the test
// scripted, and a query that is not enabled reads as pending, or as what it
// answered before when that is cached (`readsCached`), as TanStack's does.
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    requests: ReadonlyArray<{ params: { environmentId: string } }>;
    options: { enabled?: boolean } | null;
  }) =>
    args.requests.map((request) => {
      const script =
        args.options?.enabled === true || mocks.state.readsCached
          ? mocks.reads[request.params.environmentId]
          : undefined;
      const pending = {
        status: "pending",
        data: undefined,
        dataUpdatedAt: 0,
        refetch: mocks.readRefetch,
      };
      if (script === undefined) return pending;
      if (script === "fails") return { ...pending, status: "error" };
      return {
        ...pending,
        status: "success",
        data: script,
        dataUpdatedAt: mocks.state.readAt,
      };
    }),
}));
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
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: {},
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
}));
// The members of the bot's environment, as the channel view's resolver:
// one teammate it knows by name.
vi.mock("@/hooks/bots/use-environment-members-query", () => ({
  useEnvironmentMemberDirectory: (
    _client: unknown,
    environmentId: string | null,
    enabled: boolean,
  ) => {
    mocks.membersQueries.push({ environmentId, enabled });
    return {
      resolve: (userId: string) =>
        enabled && userId === "user-teammate"
          ? { displayName: "Tess Teammate", avatarUrl: null }
          : null,
      members: enabled
        ? [
            {
              userId: "user-teammate",
              displayName: "Tess Teammate",
              avatarUrl: null,
            },
          ]
        : null,
    };
  },
}));

vi.mock("@/components/epic-canvas/tab-host-provider", () => ({
  TabHostProvider: (props: { hostId: string; children: ReactNode }) => (
    <>{props.children}</>
  ),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
  }),
);
// The card's memory row is driven in `bot-memory-pane.test.tsx`.
vi.mock("@/hooks/bots/use-bot-memory", () => ({
  useBotMemory: () => ({ kind: "unsupported" }),
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: (input: { botId: string }) => {
    mocks.subscribed.push(input.botId);
    return {
      snapshot: mocks.state.snapshot,
      deleted: mocks.state.deleted,
      error: mocks.state.error,
      isPending: mocks.state.snapshot === null,
      resubscribe: mocks.resubscribe,
    };
  },
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => mocks.state.connectable,
}));
// The directory still holds host labels: if the tab ever read it to say where
// the bot runs, a label would reach the screen and the no-machine checks below
// would catch it.
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      { hostId: "host-tab", label: "Laptop" },
      { hostId: "host-bound", label: "Studio Mac" },
    ],
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => {
  const listStatus = (): "pending" | "error" | "success" => {
    if (mocks.state.listedBotIds === undefined) {
      return mocks.state.listFailed ? "error" : "pending";
    }
    return mocks.state.listFailed ? "error" : "success";
  };
  return {
    useBotListQuery: () => ({
      status: listStatus(),
      data:
        mocks.state.listedBotIds === undefined
          ? undefined
          : {
              bots: mocks.state.listedBotIds.map((botId) => ({
                botId,
                title: mocks.state.listTitles.get(botId) ?? botId,
                environmentId: "env-team",
                archivedAt: null,
              })),
              mainBotIds: mocks.state.mainBotIds,
            },
      ...mocks.state.list,
      refetch: mocks.listRefetch,
    }),
  };
});
vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForHost: (hostId: string, enabled: boolean) =>
    mocks.useBotListChangedSubscriptionForHost(hostId, enabled),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    status: mocks.state.environmentsStatus,
    data:
      mocks.state.environmentsStatus === "success" ||
      (mocks.state.environmentsStatus === "error" &&
        mocks.state.environmentsKept)
        ? { environments: mocks.state.environments }
        : undefined,
    refetch: mocks.environmentsRefetch,
  }),
}));
// One stable mutation object, like TanStack's `mutate`: the surface re-opens
// from an effect keyed on it.
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotOpenMutation: () => mocks.openMutation,
}));
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: (props: {
    activeBotId: string | null;
    hostId: string;
    threadsView: {
      shown: boolean;
      onShow: () => void;
      onLeave: () => void;
    } | null;
    onChannelOpened: () => void;
  }) => (
    <div
      data-testid="stub-sidebar"
      data-active-bot-id={props.activeBotId ?? "none"}
      data-host-id={props.hostId}
      data-threads-shown={String(props.threadsView?.shown ?? "none")}
    >
      <button
        type="button"
        data-testid="stub-sidebar-pick"
        onClick={props.onChannelOpened}
      />
      <button
        type="button"
        data-testid="stub-sidebar-threads"
        onClick={props.threadsView?.onShow}
      />
      <button
        type="button"
        data-testid="stub-sidebar-own-channel"
        onClick={props.threadsView?.onLeave}
      />
    </div>
  ),
}));
vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: (props: {
    botId: string;
    hostId: string;
    boundHostId: string | null;
    botTitle: string;
    appConversationChatId: string | null;
    openThread: BotOpenThread | null;
    landOn: BotChannelLanding | null;
    trunkChatId: string;
    openMemory: BotOpenMemory | null;
    onOpenMemory: (open: BotOpenMemory | null) => void;
    onOpenActivity: () => void;
    onOpenTurn: BotTurnOpen;
    onOpenSession: BotSessionOpen;
    resolveMember: (
      userId: string,
    ) => { displayName: string | null; avatarUrl: string | null } | null;
    setupHistory: ReactNode;
  }) => (
    <div
      data-testid="stub-channel"
      data-host-id={props.hostId}
      data-bound-host-id={props.boundHostId ?? "none"}
      data-bot-title={props.botTitle}
      data-app-conversation-chat-id={props.appConversationChatId ?? "none"}
      data-open-thread={props.openThread?.anchorMessageId ?? "none"}
      data-land-on={props.landOn?.messageId ?? "none"}
      data-land-on-thread={props.landOn?.threadId ?? "none"}
      data-open-memory={String(props.openMemory !== null)}
      data-trunk-chat-id={props.trunkChatId}
      data-teammate-name={
        props.resolveMember("user-teammate")?.displayName ?? "unresolved"
      }
    >
      <button
        type="button"
        data-testid="stub-channel-open-activity"
        onClick={props.onOpenActivity}
      />
      <button
        type="button"
        data-testid="stub-channel-open-memory"
        onClick={() => props.onOpenMemory({ back: null })}
      />
      <button
        type="button"
        data-testid="stub-channel-open-turn"
        onClick={() => props.onOpenTurn(REPLY_TURN, null)}
      />
      <button
        type="button"
        data-testid="stub-channel-open-thread-session"
        onClick={() =>
          props.onOpenSession({
            chatId: "session-thread-1",
            threadId: "thread-1",
            messageId: null,
            sendPostId: null,
          })
        }
      />
      {props.setupHistory}
    </div>
  ),
}));
// The session view is driven in `bot-session-view.test.tsx`; here, what the
// tab hands it and what its links do to the tab.
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: (props: {
    session: BotOpenSession;
    onClose: () => void;
    onOpenChannel: (messageId: string | null) => void;
    onOpenThread: (threadId: string, messageId: string | null) => void;
  }) => (
    <div
      data-testid="stub-session"
      data-chat-id={props.session.chatId}
      data-thread-id={props.session.threadId ?? "none"}
      data-land-on={props.session.landOn?.messageId ?? "none"}
      data-visit={String(props.session.landOn?.visit ?? "none")}
    >
      <button
        type="button"
        data-testid="stub-session-back"
        onClick={props.onClose}
      />
      <button
        type="button"
        data-testid="stub-session-channel"
        onClick={() => props.onOpenChannel(null)}
      />
      <button
        type="button"
        data-testid="stub-session-post"
        onClick={() => props.onOpenChannel("post-1")}
      />
      <button
        type="button"
        data-testid="stub-session-thread"
        onClick={() => props.onOpenThread("thread-1", null)}
      />
      <button
        type="button"
        data-testid="stub-session-thread-post"
        onClick={() => props.onOpenThread("thread-1", "thread-reply-9")}
      />
    </div>
  ),
}));
// The Activity page takes the bot's bound host, which says where its
// background work can be read, whether or not this host serves the tab.
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: (props: {
    boundHost: { hostId: string | null; isThisHost: boolean };
    onOpenPost: (open: BotOpenThread) => void;
    onOpenTurn: BotTurnOpen;
  }) => (
    <div
      data-testid="stub-activity"
      data-bound-host-id={props.boundHost.hostId ?? "none"}
      data-is-this-host={String(props.boundHost.isThisHost)}
    >
      <button
        type="button"
        data-testid="stub-activity-open-post"
        onClick={() =>
          props.onOpenPost({
            anchorMessageId: "post-1",
            announcement: false,
            anchorKind: null,
            sent: null,
          })
        }
      />
      <button
        type="button"
        data-testid="stub-activity-open-turn"
        onClick={() =>
          props.onOpenTurn(
            {
              chatId: "trunk-1",
              turnIds: ["turn-checkin"],
              userMessageId: "prompt-checkin",
              threadId: null,
              startedAt: 1_000,
              endedAt: 2_000,
              summary: null,
              messageIds: [],
              requestIds: [],
            },
            null,
          )
        }
      />
    </div>
  ),
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: (props: {
    hostId: string;
    channelTitle: string;
    onBack: () => void;
  }) => (
    <div
      data-testid="stub-threads"
      data-host-id={props.hostId}
      data-channel-title={props.channelTitle}
    >
      <button
        type="button"
        data-testid="stub-threads-back"
        onClick={props.onBack}
      />
    </div>
  ),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: mocks.state.threadsHeld
      ? { threads: mocks.state.threads }
      : undefined,
    isFetching: mocks.state.threadsFetching,
    isError: mocks.state.threadsError,
  }),
}));
// The panel takes the bot, whether its environment is a person's own, its
// channel, its environment's bots and how to close, and nothing else: no prop
// says which host serves the tab, so no control can be gated on it. The stub lists the props it was given.
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: (props: {
    personal: boolean;
    channelId: string | null;
    onClose: () => void;
    onDeleted: () => void;
  }) => (
    <div
      data-testid="stub-settings"
      data-prop-names={Object.keys(props).join(",")}
      data-personal={String(props.personal)}
      data-channel-id={props.channelId ?? "none"}
    >
      <button
        type="button"
        data-testid="stub-settings-close"
        onClick={props.onClose}
      />
      <button
        type="button"
        data-testid="stub-settings-deleted"
        onClick={props.onDeleted}
      />
    </div>
  ),
}));

import {
  parseNotificationPayload,
  routeNotificationForHost,
} from "@/lib/notifications/payload";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useBotPaneWidthsStore } from "@/stores/bots/bot-pane-widths-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { rowFromHostEntry } from "@/stores/notifications/merged-notifications";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useTeamCloudCreateStore } from "@/stores/bots/team-cloud-create-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** The trunk's turn behind a reply in the channel. */
const REPLY_TURN: BotTurnRef = {
  chatId: "trunk-1",
  turnIds: ["turn-reply"],
  userMessageId: "prompt-reply",
  threadId: null,
  startedAt: 1_000,
  endedAt: 2_000,
  summary: null,
  messageIds: ["reply-1"],
  requestIds: [],
};

const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
/** The id a new team's main bot will be created under. */
const SETUP_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";
/** The team's main bot, still to be set up, as the onboarding read names it. */
const NEEDS_HOST_SETUP: BotOnboardingSetup = {
  botId: SETUP_BOT_ID,
  title: "Tracy",
  state: "needs_host",
  arrival: null,
};
const TAB_HOST = "host-tab";
const BOUND_HOST = "host-bound";
/** A model a team sandbox runs. */
const TRAYCER_MODEL: GuiAgentModelOption = {
  harnessId: "traycer",
  slug: "first-model",
  label: "First model",
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  defaultReasoningEffort: null,
  supportedReasoningEfforts: [],
  defaultServiceTier: null,
  supportedServiceTiers: [],
  metadata: {},
};
/** One provider in one region, with room for the team's default shape. */
const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      shapes: null,
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
          pricing: null,
        },
      ],
    },
  ],
};

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-team",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: BOUND_HOST,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: "conversation-app",
};

function snapshot(): BotSubscriptionSnapshot {
  return {
    bot: BOT,
    tasks: [],
    openRequestCount: 0,
    conversationsRevision: null,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
    boundHost: { hostId: BOUND_HOST, epoch: 1, isThisHost: false },
    activity: null,
  };
}

function trackingTask(taskId: string): BotTaskEntry {
  return {
    taskId,
    cadence: { kind: "every", seconds: 3_600 },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: true,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    checkins: null,
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
  };
}

function answer(outcome: BotOpenResponse["outcome"]): OpenResult {
  return { kind: "answer", response: { bot: BOT, outcome } };
}

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

function surface(): ReactNode {
  return surfaceFor(BOT_ID);
}

/** Nothing on a tab says where a bot runs or offers to move it. */
function expectNoMachineWording(container: HTMLElement): void {
  expect(container.textContent).not.toMatch(
    /View on|Move it here|Studio Mac|Laptop|host-bound|host-tab|offline/i,
  );
  expect(screen.queryByTestId("bot-tab-bound-elsewhere")).toBeNull();
  expect(screen.queryByTestId("bot-tab-move-here")).toBeNull();
}

function surfaceHostId(): string | null {
  return useTracySurfaceStore.getState().hostId;
}

/**
 * Whether the surface still keeps `botId`'s per-channel state: the unsent
 * draft `openSurfaceOn` left in its thread box, which the surface clears when
 * it forgets the bot.
 */
function isKept(botId: string): boolean {
  return useBotDraftsStore.getState().threadBoxes[botId] !== undefined;
}

/** The surface open on `botId` with a draft kept for it, as an opener leaves it. */
function openSurfaceOn(botId: string): void {
  useTracySurfaceStore.setState({
    open: true,
    hostId: TAB_HOST,
    botId,
    visitedBotIds: [],
  });
  useBotDraftsStore.getState().typeThreadBox(botId, "post-1", "unsent");
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.binding = null;
  mocks.sandboxDefaults = { kind: "pending" };
  mocks.supportQueries.length = 0;
  mocks.membersQueries.length = 0;
  mocks.state.membersSupport = true;
  mocks.state.snapshot = snapshot();
  mocks.state.deleted = false;
  mocks.state.error = null;
  mocks.state.paneVisible = true;
  mocks.state.connectable = { hostIds: [TAB_HOST, BOUND_HOST], resolved: true };
  // The bot is listed, in a team that has bots: nothing is to be set up.
  mocks.state.listedBotIds = [BOT_ID];
  mocks.state.listTitles = new Map([[BOT_ID, "Release Bot"]]);
  mocks.state.mainBotIds = null;
  mocks.state.support = true;
  mocks.state.onboardingSupport = true;
  mocks.state.onboardingVersion = { major: 1, minor: 1 };
  mocks.state.readAt = 1_000;
  mocks.state.readsCached = false;
  mocks.state.listFailed = false;
  mocks.state.environmentsStatus = "success";
  mocks.state.environmentsKept = false;
  mocks.state.list = {
    dataUpdatedAt: 1_000,
    errorUpdatedAt: 0,
    isFetchedAfterMount: true,
    isFetching: false,
  };
  mocks.readRefetch.mockReset();
  mocks.listRefetch.mockReset();
  mocks.environmentsRefetch.mockReset();
  mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
  mocks.state.environments = [
    { environmentId: "env-team", label: "Acme", ownerKind: "organization" },
  ];
  mocks.state.threads = [];
  mocks.state.threadsHeld = true;
  mocks.state.threadsFetching = false;
  mocks.state.threadsError = false;
  mocks.subscribed.length = 0;
  for (const key of Object.keys(mocks.reads)) delete mocks.reads[key];
  useSelectionAuthorityStore.setState({ effectiveHostId: TAB_HOST });
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  useBotOpenThreadStore.setState({ byBotId: {} });
  useTeamCloudCreateStore.setState({ byEnvironmentId: {} });
  __resetAgentActivityStoreForTests();
  openSurfaceOn(BOT_ID);
});

const AUTH_AT_START = useAuthStore.getState();

afterEach(() => {
  cleanup();
  queryClient.clear();
  // A case that signs a viewer in leaves no one signed in for the next.
  useAuthStore.setState({
    profile: null,
    status: AUTH_AT_START.status,
    contextMetadata: AUTH_AT_START.contextMetadata,
  });
});

describe("<BotTabSurface /> on a host without bot.open", () => {
  it("asks about bot.open on the tab's own host", () => {
    render(surface());

    expect(mocks.supportQueries).toContainEqual({
      hostId: TAB_HOST,
      method: "bot.open",
    });
    expect(mocks.supportQueries.every((q) => q.hostId === TAB_HOST)).toBe(true);
  });

  it("shows the update notice, without naming a host, and none of the tab's controls", () => {
    mocks.state.support = false;
    render(surface());

    expect(screen.getByTestId("bot-tab-unavailable").textContent).toContain(
      "Bots aren't available on this host yet",
    );
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("stub-settings")).toBeNull();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("shows the connecting state, never nothing, and opens nothing, until the handshake has answered either way", () => {
    mocks.state.support = null;
    render(surface());

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

/**
 * A tab on a team's main bot before the bot exists: the team (`env-new`) has
 * no bot of its own, another team's bot is the only one listed, and the tab
 * is open as the sidebar's row would have opened it.
 */
function setUpNewTeam(): void {
  mocks.state.environments = [
    { environmentId: "env-team", label: "Acme", ownerKind: "organization" },
    { environmentId: "env-new", label: "Newco", ownerKind: "organization" },
  ];
  mocks.state.listedBotIds = [BOT_ID];
  openSurfaceOn(SETUP_BOT_ID);
}

describe("<BotTabSurface /> a team's main bot still to be set up", () => {
  beforeEach(() => {
    setUpNewTeam();
    mocks.reads["env-new"] = {
      setup: NEEDS_HOST_SETUP,
    };
  });

  it("shows the channel where the team is set up, with the bot's post and the ways to get a host, and none of the starter-bot flow", () => {
    render(surfaceFor(SETUP_BOT_ID));

    const channel = screen.getByTestId("team-setup-channel");
    expect(within(channel).getByTestId("bot-tab-title").textContent).toBe(
      "Tracy",
    );
    expect(within(channel).getByTestId("bot-tab-main")).toBeTruthy();
    expect(screen.getByTestId("stub-sidebar").dataset.activeBotId).toBe(
      SETUP_BOT_ID,
    );
    const post = within(channel).getByTestId("team-setup-post");
    expect(within(post).getByText("Tracy")).toBeTruthy();
    const card = within(post).getByTestId("team-host-options");
    expect(
      within(card)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual([
      "Give the team a host",
      "Enable cloud for the team",
      "Create a team host on a machine",
    ]);
    expect(within(card).queryAllByRole("link")).toHaveLength(0);
    expect(channel.textContent).not.toMatch(/github|starter|seat/i);
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
  });

  describe("level 2 in the installed app", () => {
    let shell: ShellFormHarness;
    beforeEach(() => {
      shell = installShellForm(SHELL_WIDTH_MENU);
    });
    afterEach(() => {
      shell.dispose();
    });

    it("offers Threads from the setup channel's title, which replaces the setup until Threads goes back", async () => {
      const user = userEvent.setup();
      render(surfaceFor(SETUP_BOT_ID));

      expect(screen.queryByTestId("bot-channel-sidebar-pane")).toBeNull();
      await user.click(
        within(screen.getByTestId("team-setup-channel")).getByTestId(
          "bot-channel-picker-trigger",
        ),
      );
      await user.click(
        within(await screen.findByTestId("bot-channel-picker")).getByTestId(
          "stub-sidebar-threads",
        ),
      );

      expect(screen.getByTestId("stub-threads")).toBeTruthy();
      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-channel-picker")).toBeNull();

      await user.click(screen.getByTestId("stub-threads-back"));

      expect(screen.queryByTestId("stub-threads")).toBeNull();
      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    });
  });

  it("draws the machine option's button disabled with a line saying it is not available yet, and a click does nothing", async () => {
    const user = userEvent.setup();
    render(surfaceFor(SETUP_BOT_ID));

    const option = screen.getByTestId("team-host-option-machine");
    const button = within(option).getByRole("button");
    expect([
      button.textContent,
      button.hasAttribute("disabled"),
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ]).toEqual(["Create team host", true, "Not available yet."]);
    await user.click(button);

    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
  });

  it("draws the message box with nothing to type into or send, and says why", () => {
    render(surfaceFor(SETUP_BOT_ID));

    const composer = screen.getByTestId("team-setup-composer");
    const input = within(composer).getByRole("textbox", {
      name: "Message Tracy",
    });
    expect(input).toHaveProperty("disabled", true);
    expect(
      within(composer).getByRole("button", { name: "Send" }),
    ).toHaveProperty("disabled", true);
    expect(
      within(composer).getByTestId("team-setup-composer-reason").textContent,
    ).toBe("Tracy can reply once the team has a host.");
  });

  it("opens, subscribes to and closes nothing: the bot does not exist", () => {
    render(surfaceFor(SETUP_BOT_ID));

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(isKept(SETUP_BOT_ID)).toBe(true);
  });

  it("shows the connecting state, opening nothing, until the team's read answers, then the setup channel", () => {
    delete mocks.reads["env-new"];
    const view = render(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);

    mocks.reads["env-new"] = {
      setup: NEEDS_HOST_SETUP,
    };
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each<readonly [string, ReadScript]>([
    ["the read answers no setup", { setup: null }],
    [
      "the setup names another bot",
      { setup: { ...NEEDS_HOST_SETUP, botId: OTHER_BOT_ID } },
    ],
  ])(
    "opens the tab as any unlisted bot's, which closes itself, when every read has answered, the list was read since the tab mounted, and %s",
    (_name, script) => {
      mocks.reads["env-new"] = script;
      render(surfaceFor(SETUP_BOT_ID));

      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      expect(mocks.listRefetch).not.toHaveBeenCalled();
      expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
      expect(isKept(SETUP_BOT_ID)).toBe(false);
    },
  );

  /**
   * The team's setup read failed, so it cannot be told from a deleted bot.
   * The tab says so, and Retry reads the setup again, and only it.
   */
  it("shows the setup could not be read, never opening, subscribing to or closing the tab, when the setup read fails; Retry reads it again and the setup then shows", async () => {
    mocks.reads["env-new"] = "fails";
    const user = userEvent.setup();
    const view = render(surfaceFor(SETUP_BOT_ID));

    const notice = screen.getByTestId("bot-tab-error");
    expect(notice.textContent).toContain("Couldn't load this channel.");
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(mocks.readRefetch).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);

    mocks.readRefetch.mockImplementation(() => {
      mocks.reads["env-new"] = {
        setup: NEEDS_HOST_SETUP,
      };
    });
    await user.click(within(notice).getByRole("button", { name: "Retry" }));

    expect(mocks.readRefetch).toHaveBeenCalled();
    expect(mocks.listRefetch).not.toHaveBeenCalled();
    expect(mocks.environmentsRefetch).not.toHaveBeenCalled();
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
  });

  /**
   * The host does not answer a team's setup, so the team cannot be told from
   * a deleted bot - not even by the setup it answered before it reconnected,
   * still cached. Nothing failed, so asking again would answer the same: the
   * tab says the channel could not be loaded, with no Retry, and shows the
   * setup once the host's methods answer it.
   */
  it.each<readonly [string, () => void]>([
    [
      "the host lacks bot.onboarding.read",
      () => {
        mocks.state.onboardingSupport = false;
      },
    ],
    [
      "the host answers bot.onboarding.read at 1.0",
      () => {
        mocks.state.onboardingVersion = { major: 1, minor: 0 };
      },
    ],
  ])(
    "shows the channel could not be loaded, without Retry, and never opens, subscribes to or closes the tab, when %s",
    (_name, script) => {
      mocks.state.readsCached = true;
      script();
      const view = render(surfaceFor(SETUP_BOT_ID));

      const notice = screen.getByTestId("bot-tab-error");
      expect(notice.textContent).toContain("Couldn't load this channel.");
      expect(within(notice).queryByRole("button")).toBeNull();
      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.subscribed).toEqual([]);
      expect(isKept(SETUP_BOT_ID)).toBe(true);

      mocks.state.onboardingSupport = true;
      mocks.state.onboardingVersion = { major: 1, minor: 1 };
      view.rerender(surfaceFor(SETUP_BOT_ID));

      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.subscribed).toEqual([]);
    },
  );

  /**
   * The environment list's refresh failed and TanStack kept a list from
   * before the team, so the team's setup is never read and the bot list,
   * fresh, does not carry the bot. Only a list that was read says a bot is
   * absent: the tab does not open the bot, which would find it gone and
   * close the tab, and reads the environments again only on Retry.
   */
  it("shows the channel could not be loaded, never opening or closing the tab, when the environment list's refresh failed over a list from before the team; Retry reads it again and the setup then shows", async () => {
    mocks.state.environments = [
      { environmentId: "env-team", label: "Acme", ownerKind: "organization" },
    ];
    mocks.state.environmentsStatus = "error";
    mocks.state.environmentsKept = true;
    const user = userEvent.setup();
    const view = render(surfaceFor(SETUP_BOT_ID));

    const notice = screen.getByTestId("bot-tab-error");
    expect(notice.textContent).toContain("Couldn't load this channel.");
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(mocks.environmentsRefetch).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);

    mocks.environmentsRefetch.mockImplementation(() => {
      setUpNewTeam();
      mocks.state.environmentsStatus = "success";
    });
    await user.click(within(notice).getByRole("button", { name: "Retry" }));

    expect(mocks.environmentsRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.listRefetch).not.toHaveBeenCalled();
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);
  });

  /**
   * A cold first read failed (no data), where the setup tab was restored:
   * neither list can say the bot is absent, so the tab says the channel could
   * not be loaded, opens and subscribes to nothing, keeps the tab and reads
   * only what failed, and only on Retry.
   */
  it.each<readonly [string, () => void, () => void, () => void]>([
    [
      "the first bot.list failed while environment.list succeeded",
      () => {
        mocks.state.listedBotIds = undefined;
        mocks.state.listFailed = true;
      },
      () => expect(mocks.listRefetch).toHaveBeenCalledTimes(1),
      () => expect(mocks.environmentsRefetch).not.toHaveBeenCalled(),
    ],
    [
      "the bot list answered while the first environment.list failed",
      () => {
        mocks.state.listedBotIds = [];
        mocks.state.environmentsStatus = "error";
      },
      () => expect(mocks.environmentsRefetch).toHaveBeenCalledTimes(1),
      () => expect(mocks.listRefetch).not.toHaveBeenCalled(),
    ],
  ])(
    "shows the channel could not be loaded, opening, subscribing to and closing nothing and refetching nothing on its own, when %s; Retry reads only the failed list",
    async (_name, script, expectFailedRefetched, expectOtherNotRefetched) => {
      mocks.reads["env-new"] = {
        setup: NEEDS_HOST_SETUP,
      };
      script();
      const user = userEvent.setup();
      render(surfaceFor(SETUP_BOT_ID));

      const notice = screen.getByTestId("bot-tab-error");
      expect(notice.textContent).toContain("Couldn't load this channel.");
      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.subscribed).toEqual([]);
      expect(mocks.listRefetch).not.toHaveBeenCalled();
      expect(mocks.environmentsRefetch).not.toHaveBeenCalled();
      expect(isKept(SETUP_BOT_ID)).toBe(true);

      await user.click(within(notice).getByRole("button", { name: "Retry" }));

      expectFailedRefetched();
      expectOtherNotRefetched();
    },
  );

  /**
   * The team's read answers `setup: null` because the bot has been created,
   * but the cached list was read before that. The tab reads the list again
   * before it decides the bot is gone.
   */
  it.each<readonly [string, () => void]>([
    [
      "the list was last read before the setup read answered",
      () => {
        mocks.state.list.dataUpdatedAt = 500;
      },
    ],
    [
      "the list was not fetched since the tab mounted",
      () => {
        mocks.state.list.isFetchedAfterMount = false;
      },
    ],
  ])(
    "reads the list again before closing an unlisted bot whose setup is gone, when %s, and opens the bot once the list carries it",
    (_name, script) => {
      mocks.reads["env-new"] = { setup: null };
      script();
      const view = render(surfaceFor(SETUP_BOT_ID));

      expect(mocks.listRefetch).toHaveBeenCalled();
      expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(isKept(SETUP_BOT_ID)).toBe(true);

      // The re-read answers, now carrying the bot.
      mocks.state.listedBotIds = [BOT_ID, SETUP_BOT_ID];
      mocks.state.list = {
        dataUpdatedAt: 2_000,
        errorUpdatedAt: 0,
        isFetchedAfterMount: true,
        isFetching: false,
      };
      view.rerender(surfaceFor(SETUP_BOT_ID));

      expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
      expect(screen.getByTestId("stub-channel")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expect(isKept(SETUP_BOT_ID)).toBe(true);
    },
  );

  it("draws no setup channel for a bot the read names live before the list carries it: it reads the list again and opens the bot once listed", () => {
    mocks.reads["env-new"] = {
      setup: { ...NEEDS_HOST_SETUP, state: "live", arrival: { kind: "cloud" } },
    };
    mocks.state.list.isFetchedAfterMount = false;
    mocks.listRefetch.mockImplementation(() => {
      mocks.state.listedBotIds = [BOT_ID, SETUP_BOT_ID];
      mocks.state.list = {
        dataUpdatedAt: 2_000,
        errorUpdatedAt: 0,
        isFetchedAfterMount: true,
        isFetching: false,
      };
    });
    const view = render(surfaceFor(SETUP_BOT_ID));

    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.listRefetch).toHaveBeenCalled();

    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });

  /**
   * The team's read answers `setup: null` (the bot has been created), but the
   * list's required refetch failed and TanStack kept the old data, which lacks
   * the bot. Only a successful read can say a bot is absent, so the tab says
   * the setup could not be read - it does not open the bot, which would find
   * it gone and close the tab - and asks the list again only on Retry.
   */
  it("shows the setup could not be read, never opening or closing the tab nor refetching the list on its own, when the list's refresh failed over old data; Retry reads it again and the bot then opens", async () => {
    mocks.reads["env-new"] = { setup: null };
    mocks.state.listFailed = true;
    mocks.state.list = {
      dataUpdatedAt: 500,
      errorUpdatedAt: 2_000,
      isFetchedAfterMount: true,
      isFetching: false,
    };
    const user = userEvent.setup();
    const view = render(surfaceFor(SETUP_BOT_ID));

    const notice = screen.getByTestId("bot-tab-error");
    expect(notice.textContent).toContain("Couldn't load this channel.");
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(mocks.listRefetch).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);

    mocks.listRefetch.mockImplementation(() => {
      mocks.state.listedBotIds = [BOT_ID, SETUP_BOT_ID];
      mocks.state.listFailed = false;
      mocks.state.list = {
        dataUpdatedAt: 3_000,
        errorUpdatedAt: 2_000,
        isFetchedAfterMount: true,
        isFetching: false,
      };
    });
    await user.click(within(notice).getByRole("button", { name: "Retry" }));

    expect(mocks.listRefetch).toHaveBeenCalledTimes(1);
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(mocks.listRefetch).toHaveBeenCalledTimes(1);
    expect(isKept(SETUP_BOT_ID)).toBe(true);
  });

  it("draws the post in a scroller that starts at the top, with the post at the bottom through its own margin", () => {
    render(surfaceFor(SETUP_BOT_ID));

    // jsdom measures no layout, so the classes that decide it are asserted:
    // `justify-end` would put an overflowing post's top out of reach, while
    // `mt-auto` on the post's slot keeps it at the bottom yet lets the
    // overflow run downward from the top.
    const scroller = screen.getByTestId("team-setup-scroller");
    expect(scroller.classList.contains("overflow-y-auto")).toBe(true);
    expect(scroller.classList.contains("justify-end")).toBe(false);
    const slot = screen.getByTestId("team-setup-post-slot");
    expect(slot.parentElement).toBe(scroller);
    expect(slot.classList.contains("mt-auto")).toBe(true);
    expect(within(slot).getByTestId("team-setup-post")).toBeTruthy();
  });

  it("opens the bot normally once it exists under the setup's id", () => {
    mocks.state.listedBotIds = [BOT_ID, SETUP_BOT_ID];
    render(surfaceFor(SETUP_BOT_ID));

    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });

  describe("Enable cloud", () => {
    /** The configuration's defaults: none set means the built-in shape. */
    const TEAM_DEFAULTS = {
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
      idleMinutes: 45,
      restingMinutes: 1_440,
    } as const;

    beforeEach(() => {
      const base = createFakeSandboxBinding();
      mocks.binding = {
        ...base,
        auth: {
          ...base.auth,
          getTraycerModels: vi.fn(() =>
            Promise.resolve<TraycerModelsFetchResult>({
              kind: "ok",
              models: [TRAYCER_MODEL],
            }),
          ),
          getSandboxCatalogue: vi.fn(() =>
            Promise.resolve<SandboxCatalogueFetchResult>({
              kind: "ok",
              catalogue: CATALOGUE,
            }),
          ),
        },
      };
      mocks.sandboxDefaults = {
        kind: "ready",
        value: { defaults: TEAM_DEFAULTS, revision: 3 },
      };
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "user-viewer", username: "olive" },
      });
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

describe("<BotTabSurface /> before the lists answer", () => {
  it("opens nothing and shows no channel until bot.list names the bot's team", () => {
    mocks.state.listedBotIds = undefined;
    render(surface());

    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
  });
});

describe("<BotTabSurface /> bot.open", () => {
  afterEach(() => {
    useBotPaneWidthsStore.getState().resetWidth("sidebar");
  });

  it("opens the bot once on mount, for this bot", () => {
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);

    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith({ botId: BOT_ID });
  });

  it("shows the connecting state until bot.open answers", () => {
    mocks.state.openResult = null;
    render(surface());

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
  });

  it("draws the channel sidebar in a pane as wide as the person set it, with a handle on its channel edge", () => {
    useBotPaneWidthsStore.getState().setWidthPx("sidebar", 300);
    render(surface());

    const pane = screen.getByTestId("bot-channel-sidebar-pane");
    expect(pane.style.getPropertyValue("--bot-pane-width")).toBe("300px");
    expect(within(pane).getByTestId("stub-sidebar")).toBeTruthy();
    expect(
      within(pane)
        .getByTestId("bot-channel-sidebar-pane-resize-handle")
        .getAttribute("aria-label"),
    ).toBe("Resize channels");
  });

  describe("level 2 in the installed app", () => {
    let shell: ShellFormHarness;
    beforeEach(() => {
      shell = installShellForm(SHELL_WIDTH_COLUMN_256);
    });
    afterEach(() => {
      shell.dispose();
    });

    it("draws the bots as the 256 column the resolver answers, with no handle and no container gate", () => {
      render(surface());

      const pane = screen.getByTestId("bot-channel-sidebar-pane");
      expect(pane.style.width).toBe("256px");
      expect(
        screen.queryByTestId("bot-channel-sidebar-pane-resize-handle"),
      ).toBeNull();
      expect(pane.className).not.toContain("@3xl");
      expect(within(pane).getByTestId("stub-sidebar")).toBeTruthy();
      expect(screen.queryByTestId("bot-channel-picker-trigger")).toBeNull();
    });

    it.each([
      ["menu", { width: SHELL_WIDTH_MENU, portrait: false }],
      ["bar", { width: SHELL_WIDTH_COLUMN_256, portrait: true }],
    ])(
      "draws no sidebar at %s, and the bot's name opens the bots list, which a pick or Threads closes",
      async (_form, shape) => {
        shell.set(shape);
        const user = userEvent.setup();
        render(surface());

        expect(screen.queryByTestId("bot-channel-sidebar-pane")).toBeNull();
        const trigger = screen.getByTestId("bot-channel-picker-trigger");
        expect(screen.getByTestId("bot-tab-title").contains(trigger)).toBe(
          true,
        );
        expect(trigger.textContent).toContain("Release Bot");

        await user.click(trigger);
        const picker = await screen.findByTestId("bot-channel-picker");
        expect(
          within(picker).getByTestId("stub-sidebar").dataset.activeBotId,
        ).toBe(BOT_ID);
        await user.click(within(picker).getByTestId("stub-sidebar-pick"));
        expect(screen.queryByTestId("bot-channel-picker")).toBeNull();

        await user.click(trigger);
        await user.click(
          within(await screen.findByTestId("bot-channel-picker")).getByTestId(
            "stub-sidebar-threads",
          ),
        );
        expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
      },
    );

    it("keeps the resizable pane and the plain title off the installed app", () => {
      setPhoneLayoutOnly(false);
      render(surface());

      const pane = screen.getByTestId("bot-channel-sidebar-pane");
      expect(
        within(pane).getByTestId("bot-channel-sidebar-pane-resize-handle"),
      ).toBeTruthy();
      const title = screen.getByTestId("bot-tab-title");
      expect(title.textContent).toBe("Release Bot");
      expect(screen.queryByTestId("bot-channel-picker-trigger")).toBeNull();
    });
  });

  it("lays the channel column and the conversation on the task page's grounds: the column on the page, the conversation on the canvas, the canvas hairline between them", () => {
    render(surface());

    const pane = screen.getByTestId("bot-channel-sidebar-pane");
    expect(pane.classList.contains("border-canvas-border/70")).toBe(true);
    expect(pane.classList.contains("md:bg-canvas")).toBe(false);
    const content = screen.getByTestId("bot-tab-content-pane");
    expect(content.classList.contains("md:bg-canvas")).toBe(true);
    expect(within(content).getByTestId("bot-tab-title")).toBeTruthy();
    expect(within(content).getByTestId("stub-channel")).toBeTruthy();
  });

  it("shows the full tab, with no banner, when this host serves the bot", () => {
    const { container } = render(surface());

    expect(screen.getByTestId("bot-tab-title").textContent).toBe("Release Bot");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expectNoMachineWording(container);
  });

  it("is also the full tab when this host claimed the bot", () => {
    mocks.state.openResult = answer({
      kind: "serve-here",
      claimed: "bound-host-unreachable",
    });
    render(surface());

    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
  });

  it("names no machine anywhere on the tab", () => {
    const { container } = render(surface());

    expectNoMachineWording(container);
  });
});

/** The team's main bot, live: the onboarding read names it with how its host came. */
const LIVE_SETUP: BotOnboardingSetup = {
  botId: BOT_ID,
  title: "Release Bot",
  state: "live",
  arrival: { kind: "cloud" },
};

describe("<BotTabSurface /> a team's main bot once it is live", () => {
  beforeEach(() => {
    mocks.state.mainBotIds = { "env-team": BOT_ID };
    mocks.reads["env-team"] = { setup: LIVE_SETUP };
  });

  it("opens the bot's own channel, with the setup post kept at its top and a line saying how the team's host came", () => {
    render(surface());

    expect(mocks.open).toHaveBeenCalledWith({ botId: BOT_ID });
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    const channel = screen.getByTestId("stub-channel");
    // The setup post is kept whole, with its buttons retired.
    const post = within(channel).getByTestId("team-setup-history-post");
    expect(within(post).getByText("Release Bot")).toBeTruthy();
    expect(post.textContent).toContain("I'm this team's main bot.");
    expect(post.textContent).toContain(
      "Before I can run, the team needs a host",
    );
    expect(
      within(within(post).getByTestId("team-host-options"))
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual([
      "Give the team a host",
      "Enable cloud for the team",
      "Create a team host on a machine",
    ]);
    expect(within(post).queryAllByRole("button")).toEqual([]);
    expect(post.textContent).not.toContain("Not available yet.");
    expect(within(channel).getByTestId("team-setup-arrival").textContent).toBe(
      "Cloud enabled for Acme · bots run on sandboxes",
    );
  });

  it.each<readonly [string, () => void]>([
    [
      "the bot is not its team's main bot",
      () => {
        mocks.state.mainBotIds = { "env-team": OTHER_BOT_ID };
      },
    ],
    [
      "the read names the team's main bot still to be set up",
      () => {
        // With an arrival, so the state alone decides.
        mocks.reads["env-team"] = {
          setup: { ...LIVE_SETUP, state: "needs_host" },
        };
      },
    ],
    [
      "the team's bots pre-date onboarding",
      () => {
        mocks.reads["env-team"] = { setup: null };
      },
    ],
    [
      "the read failed",
      () => {
        mocks.reads["env-team"] = "fails";
      },
    ],
  ])("shows the channel with no setup history when %s", (_name, script) => {
    script();
    render(surface());

    const channel = screen.getByTestId("stub-channel");
    expect(within(channel).queryByTestId("team-setup-history-post")).toBeNull();
    expect(within(channel).queryByTestId("team-setup-arrival")).toBeNull();
  });
});

describe("<BotTabSurface /> another host serves the bot", () => {
  it.each(["reachable", "claimed-concurrently"] as const)(
    "keeps the tab on its own host and renders the channel there (%s)",
    (why) => {
      mocks.state.openResult = answer({
        kind: "serve-on-bound-host",
        hostId: BOUND_HOST,
        why,
      });
      const { container } = render(surface());

      expect(surfaceHostId()).toBe(TAB_HOST);
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-host-id"),
      ).toBe(TAB_HOST);
      expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expectNoMachineWording(container);
    },
  );

  it("keeps the tab on its host while the directory has not answered", () => {
    mocks.state.openResult = answer({
      kind: "serve-on-bound-host",
      hostId: BOUND_HOST,
      why: "reachable",
    });
    mocks.state.connectable = { hostIds: [], resolved: false };
    render(surface());

    expect(surfaceHostId()).toBe(TAB_HOST);
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });
});

describe("<BotTabSurface /> paused", () => {
  const PAUSED_COPY: ReadonlyArray<{
    reason: BotOpenPausedReason;
    text: string;
    retry: boolean;
  }> = [
    {
      reason: "host-not-in-environment",
      text: "Paused: the host this bot runs on is away, and this one doesn't run Acme's bots. Messages you send are delivered when it's back.",
      retry: false,
    },
    {
      reason: "bound-to-sandbox",
      text: "Couldn't check whether this bot is running. Messages you send still reach it.",
      retry: false,
    },
    {
      reason: "bound-host-not-observable",
      text: "Couldn't check whether this bot is running. Messages you send still reach it.",
      retry: false,
    },
    {
      reason: "reachability-unknown",
      text: "Couldn't check whether this bot is running.",
      retry: true,
    },
    {
      reason: "trunk-busy",
      text: "Finishing an earlier turn here. Try again in a moment.",
      retry: true,
    },
  ];

  it.each(PAUSED_COPY)(
    "says $reason in its own words, names no machine, and offers Retry: $retry",
    ({ reason, text, retry }) => {
      mocks.state.openResult = answer({ kind: "paused", reason });
      const { container } = render(surface());

      const banner = screen.getByTestId("bot-tab-paused");
      expect(banner.getAttribute("data-reason")).toBe(reason);
      expect(banner.getAttribute("role")).toBe("status");
      expect(banner.textContent).toContain(text);
      expect(within(banner).queryAllByRole("button")).toHaveLength(
        retry ? 1 : 0,
      );
      expectNoMachineWording(container);
    },
  );

  it("still renders the channel under the paused banner", () => {
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "host-not-in-environment",
    });
    render(surface());

    expect(screen.getByTestId("bot-tab-paused")).toBeTruthy();
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-host-id"),
    ).toBe(TAB_HOST);
  });

  it("hands the channel view the tab's host for its reads and sends, and the bot's bound host for signing a provider in again", () => {
    render(surface());

    const channel = screen.getByTestId("stub-channel");
    expect(channel.getAttribute("data-host-id")).toBe(TAB_HOST);
    expect(channel.getAttribute("data-bound-host-id")).toBe(BOUND_HOST);
  });

  it("hands the channel view the conversation the bot record names as its channel", () => {
    render(surface());

    expect(
      screen
        .getByTestId("stub-channel")
        .getAttribute("data-app-conversation-chat-id"),
    ).toBe("conversation-app");
  });

  it("names the channel's members from the bot's environment when the tab's host lists them", () => {
    render(surface());

    expect(mocks.supportQueries).toContainEqual({
      hostId: TAB_HOST,
      method: "environment.members",
    });
    expect(mocks.membersQueries).toContainEqual({
      environmentId: "env-team",
      enabled: true,
    });
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-teammate-name"),
    ).toBe("Tess Teammate");
  });

  it("leaves the members unresolved on a host without environment.members", () => {
    mocks.state.membersSupport = false;
    render(surface());

    expect(mocks.membersQueries.every((q) => !q.enabled)).toBe(true);
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-teammate-name"),
    ).toBe("unresolved");
  });

  it("hands the Activity page the bound host, paused or not", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-to-sandbox",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-activity"));
    const page = screen.getByTestId("stub-activity");
    expect(page.getAttribute("data-bound-host-id")).toBe(BOUND_HOST);
    expect(page.getAttribute("data-is-this-host")).toBe("false");
  });

  it("keeps the channel settings ungated: the panel is given the bot and whether it is personal, and no editing flag", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-host-not-observable",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-channel-settings-open"));
    expect(
      screen.getByTestId("stub-settings").getAttribute("data-prop-names"),
    ).toBe("bot,personal,channelId,environmentBots,onClose,onDeleted");
  });

  it.each<readonly [string, "user" | "organization", string]>([
    ["a person's own", "user", "true"],
    ["a team's", "organization", "false"],
  ])(
    "tells the settings panel whether the bot's environment is personal: %s",
    async (_name, ownerKind, expected) => {
      const user = userEvent.setup();
      mocks.state.environments = [
        { environmentId: "env-team", label: "Acme", ownerKind },
      ];
      render(surface());

      await user.click(screen.getByTestId("bot-channel-settings-open"));
      expect(
        screen.getByTestId("stub-settings").getAttribute("data-personal"),
      ).toBe(expected);
    },
  );

  it("opens the channel's settings beside the channel from the ⋮, for the bot's channel, and closes them back to the ⋮, from their close or the ⋮ again", async () => {
    const user = userEvent.setup();
    render(surface());

    const open = screen.getByTestId("bot-channel-settings-open");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("stub-settings")).toBeNull();

    await user.click(open);
    const panel = screen.getByTestId("stub-settings");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("data-channel-id")).toBe("conversation-app");
    // The channel stays: the panel sits beside it, not instead of it.
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    await user.click(within(panel).getByTestId("stub-settings-close"));
    expect(screen.queryByTestId("stub-settings")).toBeNull();
    expect(document.activeElement).toBe(open);

    // The ⋮ closes them too.
    await user.click(open);
    expect(screen.getByTestId("stub-settings")).toBeTruthy();
    await user.click(open);
    expect(screen.queryByTestId("stub-settings")).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
  });

  it.each([
    ["a team's", "organization", "Acme", "Members of Acme"],
    ["a person's own", "user", "Olive Owner", "Only you"],
  ] as const)(
    "opens the bot's card from the header for %s bot, naming its owner and who may message it",
    async (_name, ownerKind, owner, access) => {
      const user = userEvent.setup();
      useAuthStore.setState({
        profile: {
          userId: "user-viewer",
          userName: "Olive Owner",
          email: "olive@example.com",
          avatarUrl: null,
        },
      });
      mocks.state.environments = [
        { environmentId: "env-team", label: "Acme", ownerKind },
      ];
      render(surface());

      await user.click(screen.getByTestId("bot-tab-avatar"));
      const card = await screen.findByTestId("bot-profile-card");
      expect(card.textContent).toContain(`Managed by ${owner}`);
      expect(within(card).getByTestId("bot-profile-access").textContent).toBe(
        access,
      );
    },
  );

  it("treats the environment as not personal until the environment list names it", async () => {
    const user = userEvent.setup();
    mocks.state.environments = [
      { environmentId: "env-other", label: "Mine", ownerKind: "user" },
    ];
    render(surface());

    await user.click(screen.getByTestId("bot-channel-settings-open"));
    expect(
      screen.getByTestId("stub-settings").getAttribute("data-personal"),
    ).toBe("false");
  });

  it("asks again on Retry and drops the banner when the answer changes", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "reachability-unknown",
    });
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);
    expect(mocks.open).toHaveBeenCalledTimes(1);

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });
});

describe("<BotTabSurface /> bot.open fails", () => {
  it("shows the error with a Retry, and no tab, when there is no earlier answer", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = { kind: "error", message: "the host is busy" };
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);

    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.textContent).toContain(
      "Couldn't open this bot: the host is busy",
    );
    expect(screen.queryByTestId("bot-tab-title")).toBeNull();
    expect(screen.queryByTestId("stub-channel")).toBeNull();

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });

  it("keeps the tab and shows the error above it when a re-open fails after an answer", async () => {
    const user = userEvent.setup();
    const view = render(surface());
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    mocks.state.openResult = { kind: "error", message: "network down" };
    mocks.state.paneVisible = false;
    view.rerender(surface());
    mocks.state.paneVisible = true;
    view.rerender(surface());

    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.textContent).toContain("Couldn't open this bot: network down");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(screen.getByTestId("bot-tab-title")).toBeTruthy();

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    const callsBefore = mocks.open.mock.calls.length;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(mocks.open.mock.calls.length).toBe(callsBefore + 1);
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
  });
});

describe("<BotTabSurface /> re-subscribe on return", () => {
  it("asks for the stream again when the pane goes from hidden to visible, and only then", () => {
    const view = render(surface());
    expect(mocks.resubscribe).not.toHaveBeenCalled();

    mocks.state.paneVisible = false;
    view.rerender(surface());
    expect(mocks.resubscribe).not.toHaveBeenCalled();

    mocks.state.paneVisible = true;
    view.rerender(surface());
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);

    view.rerender(surface());
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("opens the bot again when the pane comes back, since its host may have come or gone", () => {
    const view = render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    mocks.state.paneVisible = false;
    view.rerender(surface());
    expect(mocks.open.mock.calls.length).toBe(callsAfterMount);

    mocks.state.paneVisible = true;
    view.rerender(surface());
    expect(mocks.open.mock.calls.length).toBe(callsAfterMount + 1);
  });

  it("opens the bot again when the window returns to view while this tab is the one showing", () => {
    render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    document.dispatchEvent(new Event("visibilitychange"));

    expect(mocks.open.mock.calls.length).toBe(callsAfterMount + 1);
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("leaves a hidden tab alone when the window returns, since an open can claim the bot onto this host", () => {
    mocks.state.paneVisible = false;
    render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    document.dispatchEvent(new Event("visibilitychange"));

    expect(mocks.open.mock.calls.length).toBe(callsAfterMount);
    expect(mocks.resubscribe).not.toHaveBeenCalled();
  });
});

describe("<BotTabSurface /> main bot", () => {
  it("draws the header as the bot's picture, the channel's name with the main bot's star, its two views and the settings ⋮ only", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    mocks.state.mainBotIds = { "env-team": BOT_ID };
    render(surface());

    const header = screen.getByTestId("bot-tab-title").closest("header");
    if (header === null) throw new Error("expected the channel header");
    expect(
      within(header)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Messages", "Activity"]);
    expect(header.textContent).toBe(
      `${screen.getByTestId("bot-tab-avatar").textContent}${screen.getByTestId("bot-tab-title").textContent}MessagesActivity`,
    );
    expect(
      within(header).getByRole("button", { name: "Channel settings" }),
    ).toBe(screen.getByTestId("bot-channel-settings-open"));
    expect(screen.queryByTestId("bot-channel-mark-read")).toBeNull();
    expect(screen.getByTestId("bot-tab-title").nextElementSibling).toBe(
      within(header).getByRole("img", { name: "Main bot" }).parentElement,
    );
  });

  it.each([
    ["is not main", { "env-team": OTHER_BOT_ID }],
    ["is not known", null],
  ])("draws no star in the header when the bot %s", (_name, mainBotIds) => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    mocks.state.mainBotIds = mainBotIds;
    render(surface());

    const header = screen.getByTestId("bot-tab-title").closest("header");
    if (header === null) throw new Error("expected the channel header");
    expect(within(header).queryByRole("img", { name: "Main bot" })).toBeNull();
  });
});

describe("<BotTabSurface /> views", () => {
  function activityTab(): HTMLElement {
    return screen.getByTestId("bot-tab-view-activity");
  }

  it("shows Messages first, with Activity beside it and no Threads tab, and no counts for a quiet bot", () => {
    render(surface());

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Messages",
      "Activity",
    ]);
    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(
      activityTab().querySelector("[data-testid^='bot-tab-activity-']"),
    ).toBeNull();
  });

  it("counts what stopped, in red and first, what runs and the tasks the bot tracks, leaving out a zero", () => {
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [trackingTask("task-1"), trackingTask("task-2")],
      activity: {
        trunk: {
          state: "failed",
          startedAt: null,
          step: null,
          requestId: "req-1",
          reason: null,
        },
        threads: {},
      },
    };
    __setAgentActivityStateForTests(
      { "task-1": { working: ["agent-1"], turn: [] } },
      "local",
      null,
    );
    render(surface());

    expect(activityTab().textContent).toBe(
      "Activity · 1 stopped · 1 running · 2 tasks",
    );
    const parts = within(activityTab()).getAllByTestId(/^bot-tab-activity-/);
    expect(parts.map((part) => part.dataset.testid)).toEqual([
      "bot-tab-activity-stopped",
      "bot-tab-activity-running",
      "bot-tab-activity-tasks",
    ]);
    expect(parts[0].className).toContain("text-destructive");
    expect(parts[1].className).not.toContain("text-destructive");
  });

  it("leaves out the stopped and running counts when nothing has stopped or runs", () => {
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [trackingTask("task-1")],
    };
    render(surface());

    expect(activityTab().textContent).toBe("Activity · 1 task");
  });

  it("shows Threads from the column in place of the channel and its views, through the tab's host, and its own channel row lands back where it was", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(activityTab());

    await user.click(screen.getByTestId("stub-sidebar-threads"));

    expect(
      screen.getByTestId("stub-threads").getAttribute("data-host-id"),
    ).toBe(TAB_HOST);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByTestId("stub-activity")).toBeNull();
    const sidebar = screen.getByTestId("stub-sidebar");
    expect(sidebar.getAttribute("data-threads-shown")).toBe("true");
    expect(sidebar.getAttribute("data-active-bot-id")).toBe(BOT_ID);

    await user.click(screen.getByTestId("stub-sidebar-own-channel"));

    expect(screen.queryByTestId("stub-threads")).toBeNull();
    expect(activityTab().getAttribute("aria-selected")).toBe("true");
    expect(sidebar.getAttribute("data-threads-shown")).toBe("false");
  });

  it.each([
    ["the view's back control", "stub-threads-back"],
    ["the column's row for this channel", "stub-sidebar-own-channel"],
  ])(
    "leaves Threads for the channel, not for a session open before it, through %s",
    async (_way, testId) => {
      const user = userEvent.setup();
      render(surface());
      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      expect(screen.getByTestId("stub-session")).toBeTruthy();
      await user.click(screen.getByTestId("stub-sidebar-threads"));

      await user.click(screen.getByTestId(testId));

      expect(screen.queryByTestId("stub-threads")).toBeNull();
      expect(screen.queryByTestId("stub-session")).toBeNull();
      expect(screen.getByTestId("stub-channel")).toBeTruthy();
      expect(
        screen
          .getByTestId("bot-tab-view-messages")
          .getAttribute("aria-selected"),
      ).toBe("true");
    },
  );

  it("goes back from Threads to the channel where it was through the view's own back control, which names the tab's channel", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(activityTab());
    await user.click(screen.getByTestId("stub-sidebar-threads"));
    expect(
      screen.getByTestId("stub-threads").getAttribute("data-channel-title"),
    ).toBe(snapshot().bot.title);

    await user.click(screen.getByTestId("stub-threads-back"));

    expect(screen.queryByTestId("stub-threads")).toBeNull();
    expect(activityTab().getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByTestId("stub-sidebar").getAttribute("data-threads-shown"),
    ).toBe("false");
  });

  it("opens a thread chosen in Threads beside the channel, through the tab's landing, and leaves Threads", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      {
        threadId: "thread-1",
        conversationId: "conversation-app",
        sessionChatId: "session-thread-1",
        anchor: {
          messageId: "post-7",
          requestId: "req-7",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: null,
          excerpt: null,
        },
        replyCount: 1,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ];
    useBotTabLandingStore.setState({ byBotId: {} });
    render(surface());
    await user.click(screen.getByTestId("stub-sidebar-threads"));

    act(() =>
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: "thread-1",
        messageId: null,
      }),
    );

    expect(screen.queryByTestId("stub-threads")).toBeNull();
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
    ).toBe("post-7");
    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("stub-sidebar").getAttribute("data-threads-shown"),
    ).toBe("false");
    expect(useBotTabLandingStore.getState().byBotId).toEqual({});
  });

  it("switches to Activity from the open thread's Activity link", async () => {
    const user = userEvent.setup();
    render(surface());

    await user.click(screen.getByTestId("stub-channel-open-activity"));

    expect(activityTab().getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("stub-activity")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
  });

  it("returns to Messages with the thread open when Activity opens a post", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(activityTab());

    await user.click(screen.getByTestId("stub-activity-open-post"));

    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
    ).toBe("post-1");
  });
});

describe("<BotTabSurface /> a bot's session in place of its channel", () => {
  function sessionShown(): HTMLElement {
    return screen.getByTestId("stub-session");
  }

  it("opens a check-in's turn from Activity as the trunk session landed on it, in place of the views, and back returns to Activity", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(screen.getByTestId("bot-tab-view-activity"));

    await user.click(screen.getByTestId("stub-activity-open-turn"));

    expect(sessionShown().dataset.chatId).toBe("trunk-1");
    expect(sessionShown().dataset.threadId).toBe("none");
    expect(sessionShown().dataset.landOn).toBe("prompt-checkin");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("stub-activity")).toBeNull();

    await user.click(screen.getByTestId("stub-session-back"));

    expect(screen.queryByTestId("stub-session")).toBeNull();
    expect(
      screen.getByTestId("bot-tab-view-activity").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("opens a reply's turn from the channel, each open a new visit, and its channel link brings Messages back where the channel was", async () => {
    const user = userEvent.setup();
    render(surface());

    await user.click(screen.getByTestId("stub-channel-open-turn"));
    expect(sessionShown().dataset.landOn).toBe("prompt-reply");
    const firstVisit = sessionShown().dataset.visit;
    await user.click(screen.getByTestId("stub-session-back"));
    await user.click(screen.getByTestId("stub-channel-open-turn"));
    expect(sessionShown().dataset.visit).not.toBe(firstVisit);

    await user.click(screen.getByTestId("stub-session-channel"));

    expect(screen.queryByTestId("stub-session")).toBeNull();
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-land-on"),
    ).toBe("none");
  });

  it("shows the channel on the post a send followed, from Activity too, and the next session's back leaves it where it was", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(screen.getByTestId("bot-tab-view-activity"));
    await user.click(screen.getByTestId("stub-activity-open-turn"));

    await user.click(screen.getByTestId("stub-session-post"));

    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-land-on"),
    ).toBe("post-1");

    await user.click(screen.getByTestId("stub-channel-open-turn"));
    await user.click(screen.getByTestId("stub-session-back"));

    expect(
      screen.getByTestId("stub-channel").getAttribute("data-land-on"),
    ).toBe("none");
  });

  it.each([
    { leaveBy: "the Activity tab", leave: "bot-tab-view-activity" },
    {
      leaveBy: "the channel's Activity link",
      leave: "stub-channel-open-activity",
    },
  ])(
    "lands the channel on a send's post once: leaving Messages by $leaveBy and coming back does not land again",
    async ({ leave }) => {
      const user = userEvent.setup();
      render(surface());
      await user.click(screen.getByTestId("stub-channel-open-turn"));
      await user.click(screen.getByTestId("stub-session-post"));
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-land-on"),
      ).toBe("post-1");

      await user.click(screen.getByTestId(leave));
      expect(screen.queryByTestId("stub-channel")).toBeNull();
      await user.click(screen.getByTestId("bot-tab-view-messages"));

      expect(
        screen.getByTestId("stub-channel").getAttribute("data-land-on"),
      ).toBe("none");
    },
  );

  it("opens a thread's session from its panel, and shows that thread beside the channel by its post from the session", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      {
        threadId: "thread-1",
        conversationId: "conversation-app",
        sessionChatId: "session-thread-1",
        anchor: {
          messageId: "post-7",
          requestId: "req-7",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: 1_001,
          excerpt: null,
        },
        replyCount: 1,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ];
    render(surface());

    await user.click(screen.getByTestId("stub-channel-open-thread-session"));
    expect(sessionShown().dataset.chatId).toBe("session-thread-1");
    expect(sessionShown().dataset.threadId).toBe("thread-1");
    expect(sessionShown().dataset.landOn).toBe("none");

    await user.click(screen.getByTestId("stub-session-thread"));

    expect(screen.queryByTestId("stub-session")).toBeNull();
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
    ).toBe("post-7");
  });

  it("shows a thread beside the channel landed on the post a session's send wrote in it", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      {
        threadId: "thread-1",
        conversationId: "conversation-app",
        sessionChatId: "session-thread-1",
        anchor: {
          messageId: "post-7",
          requestId: "req-7",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: 1_001,
          excerpt: null,
        },
        replyCount: 1,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ];
    render(surface());

    await user.click(screen.getByTestId("stub-channel-open-thread-session"));
    await user.click(screen.getByTestId("stub-session-thread-post"));

    const channel = screen.getByTestId("stub-channel");
    expect(channel.getAttribute("data-open-thread")).toBe("post-7");
    expect(channel.getAttribute("data-land-on")).toBe("thread-reply-9");
    expect(channel.getAttribute("data-land-on-thread")).toBe("thread-1");
  });

  describe("an unrelated thread open beside the channel", () => {
    const OTHER_THREAD_RAIL = {
      kind: "thread",
      anchorMessageId: "post-other",
      announcement: false,
      anchorKind: null,
      sent: null,
    } as const;

    beforeEach(() => {
      useBotOpenThreadStore.getState().setRail(BOT_ID, OTHER_THREAD_RAIL);
      useBotTabLandingStore.setState({ byBotId: {} });
    });

    function openThreadBeside(): string | null {
      return screen
        .getByTestId("stub-channel")
        .getAttribute("data-open-thread");
    }

    it("is closed when a session opens a row of the channel, and kept when it goes back to the channel", async () => {
      const user = userEvent.setup();
      render(surface());
      expect(openThreadBeside()).toBe("post-other");

      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      await user.click(screen.getByTestId("stub-session-channel"));
      expect(openThreadBeside()).toBe("post-other");

      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      await user.click(screen.getByTestId("stub-session-post"));
      expect(openThreadBeside()).toBe("none");
    });

    it("is closed when a session opens a thread the list does not name", async () => {
      const user = userEvent.setup();
      mocks.state.threads = [];
      render(surface());

      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      await user.click(screen.getByTestId("stub-session-thread"));

      expect(openThreadBeside()).toBe("none");
    });

    it("is closed by a requested landing on a row of the channel", () => {
      mocks.state.threads = [];
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: null,
        messageId: "post-1",
      });
      render(surface());

      expect(openThreadBeside()).toBe("none");
    });

    it("is closed by a tapped push of the channel itself, from its payload through its route to the surface", () => {
      mocks.state.threads = [];
      const payload = parseNotificationPayload({
        kind: "chat",
        epicId: BOT_ID,
        chatId: "conversation-app",
        botId: BOT_ID,
      });
      expect(payload).toMatchObject({
        kind: "chat",
        bot: { botId: BOT_ID, threadId: null, messageId: null },
      });
      if (payload === null) throw new Error("the payload did not parse");

      expect(
        routeNotificationForHost(vi.fn(), payload, 1_000, {
          originHostId: null,
          effectiveHostId: "host-1",
        }),
      ).toBe(true);
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "thread",
        threadId: null,
        messageId: null,
      });
      render(surface());

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(openThreadBeside()).toBe("none");
    });

    it("is closed by a requested landing on a thread the list does not name", () => {
      mocks.state.threads = [];
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: "thread-gone",
        messageId: "reply-3",
      });
      render(surface());

      expect(openThreadBeside()).toBe("none");
    });
  });

  describe("a landing requested from outside, as a tapped push does", () => {
    const LISTED_THREAD: BotThreadSummary = {
      threadId: "thread-1",
      conversationId: "conversation-app",
      sessionChatId: "session-thread-1",
      anchor: {
        messageId: "post-7",
        requestId: "req-7",
        senderUserId: "user-1",
        sentAt: 1_000,
        resolvedAt: 1_001,
        excerpt: null,
      },
      replyCount: 1,
      lastReplyAt: 2_000,
      openRequestCount: 0,
      costUsd: null,
    };

    beforeEach(() => {
      useBotTabLandingStore.setState({ byBotId: {} });
    });

    it("opens the listed thread beside the channel on the row, and is spent, so a later render does not land it again", () => {
      mocks.state.threads = [LISTED_THREAD];
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: "thread-1",
        messageId: "reply-3",
      });
      const { rerender } = render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("post-7");
      expect(channel.getAttribute("data-land-on")).toBe("reply-3");
      expect(channel.getAttribute("data-land-on-thread")).toBe("thread-1");
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});

      // The person closes the thread; rendering again does not reopen it.
      act(() => useBotOpenThreadStore.getState().setRail(BOT_ID, null));
      rerender(surface());
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
      ).toBe("none");
    });

    it("shows the channel when the list does not name the thread", () => {
      mocks.state.threads = [LISTED_THREAD];
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: "thread-gone",
        messageId: "reply-3",
      });
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });
  });

  describe("a chat search hit landing in the bot's tab", () => {
    const LISTED_THREAD: BotThreadSummary = {
      threadId: "thread-1",
      conversationId: "conversation-app",
      sessionChatId: "session-thread-1",
      anchor: {
        messageId: "post-7",
        requestId: "req-7",
        senderUserId: "user-1",
        sentAt: 1_000,
        resolvedAt: 1_001,
        excerpt: null,
      },
      replyCount: 1,
      lastReplyAt: 2_000,
      openRequestCount: 0,
      costUsd: null,
    };

    beforeEach(() => {
      useBotTabLandingStore.setState({ byBotId: {} });
      mocks.state.threads = [LISTED_THREAD];
    });

    function openSearchHit(chatId: string, messageId: string): void {
      openChatSearchResult(
        vi.fn(),
        { epicId: BOT_ID, chatId, hostId: TAB_HOST, messageId },
        { effectiveHostId: TAB_HOST, now: 1_000 },
      );
    }

    function expectNoSession(): void {
      expect(screen.queryByTestId("stub-session")).toBeNull();
    }

    it("lands the channel on the row when the hit is in the channel's chat", () => {
      openSearchHit(BOT.appConversationChatId ?? "", "post-1");
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-land-on")).toBe("post-1");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("opens the thread beside the channel on the row when the hit is in a thread's record", () => {
      openSearchHit("thread-1", "reply-3");
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("post-7");
      expect(channel.getAttribute("data-land-on")).toBe("reply-3");
      expect(channel.getAttribute("data-land-on-thread")).toBe("thread-1");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("opens the thread's session on the row when the hit is in a thread's session", () => {
      openSearchHit("session-thread-1", "session-row-1");
      render(surface());

      const session = screen.getByTestId("stub-session");
      expect(session.getAttribute("data-chat-id")).toBe("session-thread-1");
      expect(session.getAttribute("data-thread-id")).toBe("thread-1");
      expect(session.getAttribute("data-land-on")).toBe("session-row-1");
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("opens the trunk session on the row when the hit is in the bot's trunk chat", () => {
      openSearchHit(BOT.trunkChatId, "turn-1");
      render(surface());

      const session = screen.getByTestId("stub-session");
      expect(session.getAttribute("data-chat-id")).toBe(BOT.trunkChatId);
      expect(session.getAttribute("data-thread-id")).toBe("none");
      expect(session.getAttribute("data-land-on")).toBe("turn-1");
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("lands nowhere, and is spent, when the hit's chat is none of the bot's", () => {
      openSearchHit("chat-unknown", "post-1");
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("shows the thread whose session sent beside the channel, with no session opened, for a sender landing", () => {
      useBotTabLandingStore
        .getState()
        .request(BOT_ID, { kind: "sender", chatId: "session-thread-1" });
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("post-7");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("keeps a sender landing while the thread list is read again, and opens the thread the fresh list brings", () => {
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      const { rerender } = render(surface());

      // The held list lacks the sender's thread, and a read of it starts.
      mocks.state.threadsFetching = true;
      rerender(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );

      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });
      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");

      // The read answers with the thread.
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      rerender(surface());

      expect(
        screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
      ).toBe("post-8");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("spends a waiting sender landing unlanded when the person moves the tab, and opens no thread when the list answers", async () => {
      const user = userEvent.setup();
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      const { rerender } = render(surface());

      // The held list lacks the sender's thread, and a read of it starts.
      mocks.state.threadsFetching = true;
      rerender(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });

      // The person opens Activity while the landing waits.
      await user.click(screen.getByRole("tab", { name: /^Activity/ }));

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(
        screen.getByRole("tab", { name: /^Activity/, selected: true }),
      ).toBeTruthy();

      // The read answers with the thread.
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      rerender(surface());

      expect(
        screen.getByRole("tab", { name: /^Activity/, selected: true }),
      ).toBeTruthy();
      expect(screen.getByTestId("stub-activity")).toBeTruthy();
      expectNoSession();

      await user.click(screen.getByRole("tab", { name: /^Messages/ }));

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
    });

    it("spends a waiting sender landing unlanded when the person opens Threads, which stays open when the list answers", async () => {
      const user = userEvent.setup();
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      const { rerender } = render(surface());

      // The held list lacks the sender's thread, and a read of it starts.
      mocks.state.threadsFetching = true;
      rerender(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });

      // The person opens Threads from the column while the landing waits.
      await user.click(screen.getByTestId("stub-sidebar-threads"));

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(screen.getByTestId("stub-threads")).toBeTruthy();

      // The read answers with the thread.
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      rerender(surface());

      expect(screen.getByTestId("stub-threads")).toBeTruthy();
      expect(
        screen.getByTestId("stub-sidebar").getAttribute("data-threads-shown"),
      ).toBe("true");
      expect(screen.queryByTestId("stub-channel")).toBeNull();
      expectNoSession();
    });

    it("spends a sender landing waiting on the first thread-list read when the person opens Activity, which stays when the list answers", async () => {
      const user = userEvent.setup();
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      // No list is held yet, and its first read is in flight.
      mocks.state.threadsHeld = false;
      mocks.state.threadsFetching = true;
      const view = render(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });

      // The person opens Activity while the landing waits on the first read.
      await user.click(screen.getByRole("tab", { name: /^Activity/ }));

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(
        screen.getByRole("tab", { name: /^Activity/, selected: true }),
      ).toBeTruthy();

      // The first read answers with the sender's thread.
      mocks.state.threadsHeld = true;
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      view.rerender(surface());

      expect(
        screen.getByRole("tab", { name: /^Activity/, selected: true }),
      ).toBeTruthy();
      expect(screen.getByTestId("stub-activity")).toBeTruthy();
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});

      await user.click(screen.getByRole("tab", { name: /^Messages/ }));

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
    });

    it("spends a waiting sender landing unlanded when the person opens the bot's memory, which stays when the list answers", async () => {
      const user = userEvent.setup();
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      const { rerender } = render(surface());

      // The held list lacks the sender's thread, and a read of it starts.
      mocks.state.threadsFetching = true;
      rerender(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });

      // The person opens the bot's memory beside the channel while it waits.
      await user.click(screen.getByTestId("stub-channel-open-memory"));

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-open-memory"),
      ).toBe("true");

      // The read answers with the thread.
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      rerender(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-memory")).toBe("true");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("lands the channel for a sender landing when the first thread-list read fails", async () => {
      const user = userEvent.setup();
      // No list is held, and its first read has failed.
      mocks.state.threadsHeld = false;
      mocks.state.threadsFetching = false;
      mocks.state.threadsError = true;
      render(surface());
      await user.click(screen.getByRole("tab", { name: /^Activity/ }));
      expect(screen.getByTestId("stub-activity")).toBeTruthy();

      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(
        screen.getByRole("tab", { name: /^Messages/, selected: true }),
      ).toBeTruthy();
      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
    });

    it("lands the channel, with no thread or session, for a sender landing on the trunk chat", () => {
      useBotTabLandingStore
        .getState()
        .request(BOT_ID, { kind: "sender", chatId: BOT.trunkChatId });
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it.each([
      ["the trunk session", "trunk-1"],
      ["a thread's session", "session-thread-1"],
    ])(
      "leaves Threads for %s, with the channel under it for Back",
      async (_kind, chatId) => {
        const user = userEvent.setup();
        render(surface());
        await user.click(screen.getByTestId("stub-sidebar-threads"));
        expect(screen.getByTestId("stub-threads")).toBeTruthy();

        act(() => openSearchHit(chatId, "session-row-1"));

        expect(useBotTabLandingStore.getState().byBotId).toEqual({});
        expect(screen.queryByTestId("stub-threads")).toBeNull();
        expect(screen.getByTestId("stub-session").dataset.chatId).toBe(chatId);

        await user.click(screen.getByTestId("stub-session-back"));

        expect(screen.queryByTestId("stub-threads")).toBeNull();
        expect(screen.getByTestId("stub-channel")).toBeTruthy();
      },
    );

    // A row can name a host that has since gone; a surface that opens for it
    // takes the window's host instead, which routes the bot to wherever it is
    // served.
    it.each(["a search hit", "a notification"])(
      "opens the surface on the window's host when %s names a host that is gone",
      (source) => {
        // The surface is closed: an open one keeps its own host.
        useTracySurfaceStore.setState({
          open: false,
          hostId: null,
          botId: null,
          visitedBotIds: [],
        });
        if (source === "a search hit") {
          openChatSearchResult(
            vi.fn(),
            {
              epicId: BOT_ID,
              chatId: BOT.appConversationChatId ?? "",
              hostId: "host-retired",
              messageId: "post-1",
            },
            { effectiveHostId: TAB_HOST, now: 1_000 },
          );
        } else {
          const { payload } = rowFromHostEntry({
            id: "old-agent-stop",
            updatedAt: 10,
            readAt: null,
            kind: "agent.stopped",
            sourceRef: BOT.trunkChatId,
            severity: "done",
            outcome: "completed",
            epicId: BOT_ID,
            chatId: BOT.trunkChatId,
            payload: {
              kind: "chat",
              epicId: BOT_ID,
              chatId: BOT.trunkChatId,
              hostId: "host-retired",
              agentName: "Tracy",
              taskTitle: "Tracy",
              outcome: "completed",
            },
          });
          if (payload === null) throw new Error("the row carried no payload");
          routeNotificationForHost(vi.fn(), payload, 1_000, {
            originHostId: null,
            effectiveHostId: TAB_HOST,
          });
        }

        expect(useTracySurfaceStore.getState()).toMatchObject({
          open: true,
          hostId: TAB_HOST,
        });
        expect(mocks.activateTabIntent).toHaveBeenCalledWith({
          kind: "tracy",
          botId: BOT_ID,
        });
        render(surface());
        expect(
          screen.queryByTestId(
            source === "a search hit" ? "stub-channel" : "stub-session",
          ),
        ).not.toBeNull();
      },
    );
  });

  it("gives the channel the bot's trunk session", () => {
    render(surface());

    expect(
      screen.getByTestId("stub-channel").getAttribute("data-trunk-chat-id"),
    ).toBe("trunk-1");
  });
});

describe("<BotTabSurface /> channel lifetime", () => {
  /**
   * The last bot of a team is deleted: the list no longer carries it and its
   * team has no bot, which is what a team still to be set up looks like. A
   * channel that showed the bot listed is that bot's, so it is forgotten and
   * the default channel is selected - it never shows the setup notice,
   * whatever the host answers about the team's onboarding.
   */
  it.each<readonly [string, () => void]>([
    [
      "the host answers bot.onboarding.read at 1.0",
      () => {
        mocks.state.onboardingVersion = { major: 1, minor: 0 };
      },
    ],
    [
      "the setup read fails",
      () => {
        mocks.reads["env-team"] = "fails";
      },
    ],
  ])(
    "forgets the channel, never showing the setup notice, when bot.list no longer carries the last bot of its team and %s",
    (_name, script) => {
      script();
      const view = render(surface());
      expect(screen.getByTestId("stub-channel")).toBeTruthy();
      expect(isKept(BOT_ID)).toBe(true);

      mocks.state.listedBotIds = [];
      view.rerender(surface());

      expect(isKept(BOT_ID)).toBe(false);
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    },
  );

  it("forgets a channel that was never listed, and selects the default, when the list carries another bot of its team", () => {
    mocks.state.listedBotIds = [OTHER_BOT_ID];
    render(surface());

    expect(isKept(BOT_ID)).toBe(false);
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: OTHER_BOT_ID,
    });
  });

  it("keeps the channel while bot.list carries the bot or has not answered", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    const view = render(surface());
    expect(isKept(BOT_ID)).toBe(true);

    view.unmount();
    mocks.state.listedBotIds = undefined;
    render(surface());
    expect(isKept(BOT_ID)).toBe(true);
  });

  it("forgets the channel on the stream's deleted frame", () => {
    mocks.state.deleted = true;
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    render(surface());

    expect(isKept(BOT_ID)).toBe(false);
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: OTHER_BOT_ID,
    });
  });

  it("forgets the channel when the settings panel reports the bot deleted", async () => {
    const user = userEvent.setup();
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    render(surface());
    await user.click(screen.getByTestId("bot-channel-settings-open"));

    await user.click(screen.getByTestId("stub-settings-deleted"));

    expect(isKept(BOT_ID)).toBe(false);
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: OTHER_BOT_ID,
    });
  });

  it("commits the default channel at once while the surface is out of view, where there is no route to move", () => {
    mocks.state.paneVisible = false;
    mocks.state.listedBotIds = [OTHER_BOT_ID];
    render(surface());

    expect(useTracySurfaceStore.getState().botId).toBe(OTHER_BOT_ID);
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
  });

  it("keeps the column and the previous channel's state across a switch, opening and subscribing to the new channel", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    const view = render(surface());
    const column = screen.getByTestId("stub-sidebar");

    useTracySurfaceStore.getState().selectChannel(OTHER_BOT_ID);
    view.rerender(surfaceFor(OTHER_BOT_ID));

    expect(screen.getByTestId("stub-sidebar")).toBe(column);
    expect(column.getAttribute("data-active-bot-id")).toBe(OTHER_BOT_ID);
    expect(mocks.open).toHaveBeenCalledWith({ botId: OTHER_BOT_ID });
    expect(mocks.subscribed).toContain(OTHER_BOT_ID);
    expect(isKept(BOT_ID)).toBe(true);
  });

  it("forgets an inactive visited channel when the list stops carrying it, leaving the selected one alone", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    const view = render(surface());
    useTracySurfaceStore.getState().selectChannel(OTHER_BOT_ID);
    useBotDraftsStore
      .getState()
      .typeThreadBox(OTHER_BOT_ID, "post-1", "unsent");
    view.rerender(surfaceFor(OTHER_BOT_ID));
    expect(useTracySurfaceStore.getState().visitedBotIds).toEqual([
      BOT_ID,
      OTHER_BOT_ID,
    ]);

    mocks.state.listedBotIds = [OTHER_BOT_ID];
    view.rerender(surfaceFor(OTHER_BOT_ID));

    expect(isKept(BOT_ID)).toBe(false);
    expect(isKept(OTHER_BOT_ID)).toBe(true);
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
  });

  it("keeps bot.list current through the change stream on the surface's own host", () => {
    render(surface());

    expect(mocks.useBotListChangedSubscriptionForHost).toHaveBeenLastCalledWith(
      TAB_HOST,
      true,
    );
  });
});

describe("<BotTabSurface /> with no channel selected", () => {
  it("selects the default channel once the lists answer, and shows the column meanwhile", () => {
    mocks.state.listedBotIds = [BOT_ID];
    render(surfaceFor(null));

    expect(
      screen.getByTestId("stub-sidebar").getAttribute("data-active-bot-id"),
    ).toBe("none");
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: BOT_ID,
    });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("says there are no bots yet, with the column still drawn, when the team has none", () => {
    mocks.state.listedBotIds = [];
    render(surfaceFor(null));

    expect(screen.getByTestId("bot-tab-no-channel").textContent).toBe(
      "No bots yet. Create one from Home.",
    );
    expect(screen.getByTestId("stub-sidebar")).toBeTruthy();
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  describe("level 2 in the installed app", () => {
    let shell: ShellFormHarness;
    beforeEach(() => {
      shell = installShellForm(SHELL_WIDTH_MENU);
    });
    afterEach(() => {
      shell.dispose();
    });

    it("heads the pane with Tracy as the picker, to reach a team still to be set up that the default channel does not see", async () => {
      mocks.state.listedBotIds = [];
      mocks.state.environments = [
        { environmentId: "env-new", label: "Newco", ownerKind: "organization" },
      ];
      mocks.reads["env-new"] = { setup: NEEDS_HOST_SETUP };
      const user = userEvent.setup();
      const view = render(surfaceFor(null));

      expect(screen.queryByTestId("bot-channel-sidebar-pane")).toBeNull();
      expect(screen.getByTestId("bot-tab-no-channel")).toBeTruthy();
      const trigger = screen.getByTestId("bot-channel-picker-trigger");
      expect(screen.getByTestId("bot-tab-title").contains(trigger)).toBe(true);
      expect(trigger.textContent).toBe("Tracy");

      await user.click(trigger);
      const picker = await screen.findByTestId("bot-channel-picker");
      expect(
        within(picker).getByTestId("stub-sidebar").dataset.activeBotId,
      ).toBe("none");
      await user.click(within(picker).getByTestId("stub-sidebar-pick"));
      expect(screen.queryByTestId("bot-channel-picker")).toBeNull();

      // The pick navigates to the setup channel, which the route then shows.
      view.rerender(surfaceFor(SETUP_BOT_ID));
      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-no-channel")).toBeNull();
    });
  });
});

describe("<BotTabSurface /> stream error", () => {
  it("keeps the retained snapshot on screen and puts a retry on top of it", async () => {
    const user = userEvent.setup();
    mocks.state.error = "the stream closed";
    render(surface());

    expect(screen.getByTestId("bot-tab-title").textContent).toBe("Release Bot");
    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("the stream closed");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    expect(mocks.resubscribe).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows only the error and its retry when no snapshot ever arrived", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = null;
    mocks.state.error = "the stream closed";
    render(surface());

    expect(screen.getByTestId("bot-tab-error")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-title")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows no error and no connecting state for a healthy stream", () => {
    render(surface());

    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
  });

  it("shows the connecting state before the first snapshot", () => {
    mocks.state.snapshot = null;
    render(surface());

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
  });
});
