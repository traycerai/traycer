/**
 * The external boundaries the Activity page's suites replace, and the state a
 * case sets on them. A suite registers each replacement with a `vi.mock` that
 * loads the factory from here, and reads the same `mocks` through the support
 * module: this file imports nothing the page imports, so a factory can load it
 * while the page is still being imported.
 */
import { useState } from "react";
import { vi, type Mock } from "vitest";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import type { BotSessionOpen } from "@/stores/bots/bot-open-thread-store";

type IndicatorParams = {
  readonly epicIds: ReadonlyArray<string>;
  readonly chatIds: ReadonlyArray<string>;
};

const emptyFlags = {
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadFailure: false,
  unreadDone: false,
  unreadCount: 0,
};

const state = {
  /** The optional methods the tab's host advertised. */
  supported: new Set<string>(),
  /** Read the real negotiated-manifest registry instead of `supported`. */
  realManifest: false,
  /** Task titles by task id, as the task-context read answers them. */
  taskTitles: {} as Record<string, string>,
  /** What the host's indicator read holds per task and per agent chat. */
  epicFlags: {} as Record<string, Partial<typeof emptyFlags>>,
  chatFlags: {} as Record<string, Partial<typeof emptyFlags>>,
  /**
   * What a named host's indicator read holds per agent chat, for a case
   * whose hosts answer differently; a host not named here answers
   * `chatFlags`.
   */
  chatFlagsByHost: {} as Record<
    string,
    Record<string, Partial<typeof emptyFlags>>
  >,
  /** Hosts the directory reports unreachable. */
  unreachable: new Set<string>(),
  /** How the host's indicator read stands: answered, still pending, or failed. */
  indicatorRead: "ok" as "ok" | "pending" | "error" | "unanswered",
  /** The feed mode the notification session negotiated. */
  feedMode: "cloud" as "local" | "cloud" | "upgrade-required",
};
const answers = new Map<string, unknown>();
/** Each agent chat id an enabled indicator read asked a host about. */
const asked: Array<{ hostId: string | null; chatId: string }> = [];

export const mocks = {
  state,
  client: { stub: "tab-host-client" },
  navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
  /** Each session the page was asked to open. */
  openSession: vi.fn<BotSessionOpen>(),
  /** Each member action the page sent, by method. */
  actions: [] as Array<{ method: string; variables: unknown }>,
  /**
   * The stop call's outcome: answered at once as a success, or, while
   * `hold` is set, only when the case calls `settle`.
   */
  stop: {
    hold: false,
    settle: null as ((outcome: "success" | "failure") => void) | null,
  },
  /** Check in now and pause/resume: answered at once, or held until `settle`. */
  runNow: {
    hold: false,
    settle: null as (() => void) | null,
    /** The held call fails: the request stops pending and nothing else changes. */
    fail: null as (() => void) | null,
  },
  setPaused: {
    hold: false,
    settle: null as (() => void) | null,
    fail: null as (() => void) | null,
  },
  asked,
  /** `hostId`'s `host.notifications.indicatorState` answer for a request. */
  answerIndicators(
    hostId: string | null,
    requests: ReadonlyArray<{ params: IndicatorParams }>,
  ): HostNotificationsIndicatorStateResponse {
    const epics: HostNotificationsIndicatorStateResponse["epics"] = {};
    const chats: HostNotificationsIndicatorStateResponse["chats"] = {};
    const chatFlags =
      hostId !== null && Object.hasOwn(state.chatFlagsByHost, hostId)
        ? state.chatFlagsByHost[hostId]
        : state.chatFlags;
    for (const { params } of requests) {
      for (const id of params.epicIds) {
        if (Object.hasOwn(state.epicFlags, id)) {
          epics[id] = { ...emptyFlags, ...state.epicFlags[id] };
        }
      }
      for (const id of params.chatIds) {
        asked.push({ hostId, chatId: id });
        if (Object.hasOwn(chatFlags, id)) {
          chats[id] = { ...emptyFlags, ...chatFlags[id] };
        }
      }
    }
    return { epics, chats, complete: true };
  },
  /** One answer object per request set, as a query cache holds it. */
  cached(key: string, make: () => unknown): unknown {
    if (!answers.has(key)) answers.set(key, make());
    return answers.get(key);
  },
  forgetAnswers: () => {
    answers.clear();
    asked.length = 0;
  },
};

export function routerMock(): { useNavigate: () => Mock } {
  return { useNavigate: () => vi.fn() };
}

export function tabNavigationMock<T extends object>(actual: T): T {
  return {
    ...actual,
    navigateToTabIntent: mocks.navigateToTabIntent,
    activateTabIntent: vi.fn(),
  };
}

export function tabHostClientMock(): { useTabHostClient: () => object } {
  return { useTabHostClient: () => mocks.client };
}

export function taskContextsMock(): { useEpicGetTaskContexts: () => object } {
  return {
    useEpicGetTaskContexts: () => ({
      tasksById: new Map(
        Object.entries(mocks.state.taskTitles).map(([taskId, title]) => [
          taskId,
          { epic: { light: { title } } },
        ]),
      ),
      resolutionsById: new Map(),
      pendingTaskIds: new Set<string>(),
    }),
  };
}

export function hostSupportsMethodMock(actual: {
  useHostMethodSupport: (
    hostId: string | null,
    method: string,
  ) => boolean | null;
}): object {
  return {
    ...actual,
    // A case sets `realManifest` to read the negotiated-manifest registry
    // itself, so a change to it reaches only the components that subscribe.
    useHostMethodSupport: (hostId: string | null, method: string) =>
      mocks.state.realManifest
        ? actual.useHostMethodSupport(hostId, method)
        : mocks.state.supported.has(method),
  };
}

export function botActivityMock(): { useBotActivity: () => null } {
  return { useBotActivity: () => null };
}

export function hostReachabilityMock(): {
  useHostReachability: (hostId: string) => { status: string };
} {
  return {
    useHostReachability: (hostId: string) => ({
      status: mocks.state.unreachable.has(hostId) ? "unreachable" : "reachable",
    }),
  };
}

/** The member actions' writes: each records the method and what it was sent. */
export function taskActionMutationsMock(): object {
  const held =
    (
      method: string,
      control: {
        hold: boolean;
        settle: (() => void) | null;
        fail: (() => void) | null;
      },
    ) =>
    () => {
      const [isPending, setPending] = useState(false);
      return {
        mutate: (variables: unknown) => {
          mocks.actions.push({ method, variables });
          if (!control.hold) return;
          setPending(true);
          control.settle = () => setPending(false);
          control.fail = () => setPending(false);
        },
        isPending,
        variables: undefined,
      };
    };
  return {
    useBotTaskRunNowMutation: held("bot.task.runNow", mocks.runNow),
    useBotTaskSetPausedMutation: held("bot.task.setPaused", mocks.setPaused),
    useBotTaskStopMutation: () => {
      const [isPending, setPending] = useState(false);
      return {
        mutate: (
          variables: unknown,
          options: {
            onSuccess: (() => void) | undefined;
            onError: ((error: Error) => void) | undefined;
          },
        ) => {
          mocks.actions.push({ method: "bot.task.stop", variables });
          if (!mocks.stop.hold) {
            options.onSuccess?.();
            return;
          }
          setPending(true);
          mocks.stop.settle = (outcome) => {
            setPending(false);
            if (outcome === "success") options.onSuccess?.();
            else options.onError?.(new Error("refused"));
          };
        },
        isPending,
        variables: undefined,
      };
    },
  };
}

/** Opening an agent in its task is the chat row's own seam, driven elsewhere. */
export function chatRowOpenRefMock(): {
  useChatRowOpenRef: () => () => { type: string; id: string };
} {
  return { useChatRowOpenRef: () => () => ({ type: "chat", id: "opened" }) };
}

export function notificationHostMock(): {
  useNotificationResolveHostId: () => string;
} {
  return { useNotificationResolveHostId: () => "host-notifications" };
}

/** A host's client names the host, so a read answers as the host it went to. */
export function hostClientForHostIdMock(): {
  useHostClientForHostId: (hostId: string | null) => { hostId: string | null };
} {
  return { useHostClientForHostId: (hostId) => ({ hostId }) };
}

/**
 * The host's query transport: `host.notifications.indicatorState` answers the
 * flags a case holds for the ids it was asked about, in TanStack's result shape.
 */
export function hostQueriesMock(): object {
  return {
    useHostQueries: (args: {
      client: { hostId: string | null };
      requests: ReadonlyArray<{ params: IndicatorParams }>;
      options: { enabled?: boolean } | null;
      combine: (results: ReadonlyArray<unknown>) => unknown;
    }) => {
      const enabled = args.options?.enabled === true;
      const hostId = args.client.hostId;
      const key = JSON.stringify([
        enabled,
        hostId,
        args.requests.map((r) => r.params),
      ]);
      return mocks.cached(key, () =>
        args.combine(
          args.requests.map(() => ({
            // "unanswered": settled with no error and no data, as a host that
            // does not serve the method leaves it.
            data:
              enabled && mocks.state.indicatorRead !== "unanswered"
                ? mocks.answerIndicators(hostId, args.requests)
                : undefined,
            isPending: mocks.state.indicatorRead === "pending",
            isFetching: false,
            error:
              mocks.state.indicatorRead === "error"
                ? new Error("indicator read failed")
                : null,
            refetch: () => Promise.resolve(),
          })),
        ),
      );
    },
  };
}
