/**
 * The scripted state the Tracy surface's mocked boundaries answer from, and
 * those boundaries' module bodies, for `bot-tab-surface.test.tsx` and
 * `team-setup-channel.test.tsx`. Each file keeps its own `vi.mock` calls (they
 * are hoisted per file) and points them at the bodies here. It imports no
 * app module at run time, so a mock factory can reach it while the app's
 * modules are still loading.
 */
import type { ReactNode } from "react";
import { vi, type Mock } from "vitest";
import type {
  SandboxCatalogueFetchResult,
  TraycerModelsFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { SandboxDefaultsRead } from "@/hooks/sandboxes/use-sandbox-defaults";
import type {
  FakeSandboxAuth,
  FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import type {
  BotAppearance,
  BotOpenResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { BotOnboardingSetup } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";

export type OpenResult =
  | { readonly kind: "answer"; readonly response: BotOpenResponse }
  | { readonly kind: "error"; readonly message: string };

export type ReadScript = { setup: BotOnboardingSetup | null } | "fails";

/**
 * The control plane a team's Enable cloud reads and creates through, and a
 * team host's install token is minted on.
 */
export interface TeamCloudBinding extends FakeSandboxBinding {
  readonly auth: FakeSandboxAuth & {
    readonly getTraycerModels: Mock<() => Promise<TraycerModelsFetchResult>>;
    readonly getSandboxCatalogue: Mock<
      () => Promise<SandboxCatalogueFetchResult>
    >;
  };
}

export interface HostClientChange {
  readonly reason: "auth-changed" | "availability-recovered";
  readonly currentHostId: string | null;
}
type HostClientChangeListener = (event: HostClientChange) => void;

export const mocks = {
  hostClient: {
    stub: "tab-host-client",
    onChange: (listener: HostClientChangeListener): (() => void) => {
      mocks.changeListeners.add(listener);
      return () => mocks.changeListeners.delete(listener);
    },
  },
  /** The host client's change subscribers, fired by `emitHostChange`. */
  changeListeners: new Set<HostClientChangeListener>(),
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
  /** The task titles `epic.getTaskContexts` found for the bot's stream tasks. */
  taskContexts: new Map<string, ListTaskLight>(),
  /** Home's `epic.listTasks` rows. */
  homeTasks: [] as ListTaskLight[],
  /** How far the tab's two task reads have got; answered unless a case says otherwise. */
  taskReads: {
    contextsPending: false,
    homePending: false,
    homeRefused: false,
  },
  /**
   * What the host's `indicatorState` read answers per task: the tasks whose
   * result the person has not seen. One answer object per request set, as a
   * query cache holds it.
   */
  unreadTaskIds: new Set<string>(),
  indicatorAnswers: new Map<string, unknown>(),
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
    /** The appearance the list gives a bot; a bot not named has none. */
    listAppearance: new Map<string, BotAppearance>(),
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
    // Whether a bot.thread.list answer is held: true serves `threads` as that
    // list; false means no answer yet, so the query has no data.
    threadsHeld: true,
    // Whether a bot.thread.list read is in flight, over the held answer if any.
    threadsFetching: false,
    // The last read of bot.thread.list failed.
    threadsError: false,
    environments: [] as Array<{
      environmentId: string;
      label: string;
      ownerKind: "organization" | "user";
      providerHandle: string | null;
    }>,
  },
};

export const hostSupportsMethodMock = {
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
};

// The tasks a bot's channel can name come from two host reads, scripted here:
// the titles of the stream's tasks, and Home's task list.
const taskContextsRead = () => ({
  tasksById: mocks.taskContexts,
  isPending: mocks.taskReads.contextsPending,
  error: null,
});

export const epicTaskContextsMock = {
  useEpicGetTaskContexts: taskContextsRead,
  useEpicGetTaskContextsForClient: taskContextsRead,
};

export function cloudEpicTasksMock<T extends object>(original: T): T {
  return {
    ...original,
    useCloudEpicTasksQuery: () => ({ tasks: mocks.homeTasks }),
    useCloudEpicTasksQueryForClient: () => ({
      tasks: mocks.homeTasks,
      presentsCachedPage: false,
      firstPagePending: mocks.taskReads.homePending,
      firstPageError: null,
      initialLegRefused: mocks.taskReads.homeRefused,
    }),
  };
}

// The Activity count reads the notification indicators through the notification
// host; the query transport below answers them.
export const notificationHostMock = {
  useNotificationResolveHostId: () => "host-notifications",
};

export const hostClientForHostIdMock = {
  useHostClientForHostId: () => null,
};

// The host RPC boundary: `bot.onboarding.read` answers what the test
// scripted, and a query that is not enabled reads as pending, or as what it
// answered before when that is cached (`readsCached`), as TanStack's does.
export const hostQueriesMock = {
  useHostQueries: (args: {
    requests: ReadonlyArray<{
      params: { environmentId?: string; epicIds?: ReadonlyArray<string> };
    }>;
    options: { enabled?: boolean } | null;
    combine?: (results: ReadonlyArray<unknown>) => unknown;
  }) => {
    if (args.combine !== undefined) {
      // `host.notifications.indicatorState` for the Activity count.
      const combine = args.combine;
      const enabled = args.options?.enabled === true;
      const epicIds = args.requests.flatMap((r) => r.params.epicIds ?? []);
      const key = JSON.stringify([enabled, epicIds]);
      if (!mocks.indicatorAnswers.has(key)) {
        const unread = {
          pendingFork: false,
          pendingApproval: false,
          pendingInterview: false,
          unreadFailure: false,
          unreadDone: true,
          unreadCount: 1,
        };
        mocks.indicatorAnswers.set(
          key,
          combine(
            args.requests.map(() => ({
              data: enabled
                ? {
                    epics: Object.fromEntries(
                      epicIds
                        .filter((id) => mocks.unreadTaskIds.has(id))
                        .map((id) => [id, unread]),
                    ),
                    chats: {},
                    complete: true,
                  }
                : undefined,
              isPending: false,
              isFetching: false,
              error: null,
              refetch: () => Promise.resolve(),
            })),
          ),
        );
      }
      return mocks.indicatorAnswers.get(key);
    }
    return args.requests.map((request) => {
      const script =
        args.options?.enabled === true || mocks.state.readsCached
          ? mocks.reads[request.params.environmentId ?? ""]
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
    });
  },
};

export const hostEnvironmentBindingsMock = {
  useHostEnvironmentBindings: () => ({
    byHostId: {},
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
};

// The members of the bot's environment, as the channel view's resolver:
// one teammate it knows by name.
export const environmentMembersMock = {
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
};

export const tabHostClientMock = {
  useTabHostClient: () => mocks.hostClient,
};

export const botMemoryMock = {
  useBotMemory: () => ({ kind: "unsupported" }),
};

export const botSubscriptionMock = {
  useBotSubscriptionForHost: (input: { botId: string }) => {
    mocks.subscribed.push(input.botId);
    return {
      snapshot: mocks.state.snapshot,
      // A held snapshot is one the live stream delivered.
      snapshotFresh: mocks.state.snapshot !== null,
      deleted: mocks.state.deleted,
      error: mocks.state.error,
      isPending: mocks.state.snapshot === null,
      resubscribe: mocks.resubscribe,
    };
  },
};

export const connectableHostIdsMock = {
  useConnectableHostIds: () => mocks.state.connectable,
};

// The directory still holds host labels: if the tab ever read it to say where
// the bot runs, a label would reach the screen and the no-machine checks below
// would catch it.
const DIRECTORY_HOSTS = [
  { hostId: "host-tab", label: "Laptop" },
  { hostId: "host-bound", label: "Studio Mac" },
];

export const hostDirectoryListMock = {
  useHostDirectoryList: () => ({ data: DIRECTORY_HOSTS }),
  // The mention menu's host entries read the same list, answered.
  useHostDirectoryListQuery: () => ({
    data: DIRECTORY_HOSTS,
    isPending: false,
    isError: false,
  }),
};

export const botListChangedMock = {
  useBotListChangedSubscriptionForHost: (hostId: string, enabled: boolean) =>
    mocks.useBotListChangedSubscriptionForHost(hostId, enabled),
};

export const botMutationsMock = {
  useBotOpenMutation: () => mocks.openMutation,
};

export const botThreadListQueryMock = {
  useBotThreadListQuery: () => ({
    data: mocks.state.threadsHeld
      ? { threads: mocks.state.threads }
      : undefined,
    isFetching: mocks.state.threadsFetching,
    isError: mocks.state.threadsError,
  }),
};

export const tabHostProviderMock = {
  TabHostProvider: (props: { hostId: string; children: ReactNode }) => (
    <>{props.children}</>
  ),
};

export const botListQueryMock = {
  useBotListQuery: () => {
    const listStatus = (): "pending" | "error" | "success" => {
      if (mocks.state.listedBotIds === undefined) {
        return mocks.state.listFailed ? "error" : "pending";
      }
      return mocks.state.listFailed ? "error" : "success";
    };
    return {
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
                ...(mocks.state.listAppearance.has(botId)
                  ? { appearance: mocks.state.listAppearance.get(botId) }
                  : {}),
              })),
              mainBotIds: mocks.state.mainBotIds,
            },
      ...mocks.state.list,
      refetch: mocks.listRefetch,
    };
  },
};

export const environmentListMock = {
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
};

/**
 * The tab-navigation controller is the boundary: it commits a selection when
 * it acknowledges a navigation, which these cases read off the intents asked.
 * The controller accepts and acknowledges at once, as a history push does:
 * a Tracy channel is committed when its navigation lands.
 */
export async function tabNavigationMock<T extends object>(
  original: T,
): Promise<T & { activateTabIntent: ActivateTabIntent }> {
  const { useTracySurfaceStore } =
    await import("@/stores/bots/tracy-surface-store");
  return {
    ...original,
    activateTabIntent: (_navigate, intent) => {
      mocks.activateTabIntent(intent);
      if (intent.kind === "tracy") {
        useTracySurfaceStore.getState().selectChannel(intent.botId);
      }
      return true;
    },
  };
}

type ActivateTabIntent = (
  navigate: unknown,
  intent: TabNavigationIntent,
  options: unknown,
) => boolean;
