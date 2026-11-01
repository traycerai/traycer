/**
 * The bridge between the host's reads and every standalone name: the real
 * bridge, the real queries and the real consumers, with only the host's
 * transport, its negotiated methods and the serving-host choice faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { NotificationShowOutcome } from "@traycer-clients/shared/platform/runner-host";
import type {
  BotOnboardingReadResponse,
  BotOnboardingSetup,
} from "@traycer/protocol/host/bot/onboarding-schemas";
import type { BotListResponse } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { HostNotificationsCloudFeedRowV16 } from "@traycer/protocol/host/notifications/contracts";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { BotChannelTitle } from "@/components/bots/bot-channel-level2";
import type { BotThreadsViewState } from "@/components/bots/bot-channel-sidebar";
import { TeamSetupChannel } from "@/components/bots/team-setup-channel";
import { StandaloneBotsBridge } from "@/components/layout/bridges/standalone-bots-bridge";
import { Toaster } from "@/components/ui/sonner";
import {
  EMPTY_DIRECTORY_STATE,
  PERSONAL_MAIN_BOT_ID,
  TEAM_MAIN_BOT_ID,
  tracyRecord,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { TILE_CONTENT_BUDGET_MS } from "@/lib/host/bounded-load-budgets";
import {
  displayCloudSnapshotArrivals,
  resetNotificationFeedDisplayReceiptsForTests,
} from "@/lib/notifications/notification-display";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

const host = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  support: true as boolean | null,
  reachability: "reachable",
  leaseStatus: null as string | null,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useSandboxDefaults: () => new Map(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer-1",
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHost: () => ({
    hostId: "host-1",
    client: host.client,
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => host.support,
  useHostMethodSchemaVersion: () =>
    host.support === true ? { major: 1, minor: 1 } : null,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: host.reachability }),
}));
vi.mock("@/hooks/host/use-host-lease", () => ({
  useHostLease: () =>
    host.leaseStatus === null ? null : { status: host.leaseStatus },
}));

type EnvironmentRow = EnvironmentListResponseV11["environments"][number];

const SETUP_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const THREADS_CLOSED: BotThreadsViewState = {
  shown: false,
  onShow: () => undefined,
  onLeave: () => undefined,
};

function personal(): EnvironmentRow {
  return {
    environmentId: "env-me",
    ownerKind: "user",
    ownerId: "viewer-1",
    roomId: "room-me",
    label: "Personal",
    effectiveRole: "owner",
    kind: "personal",
    hostCount: 0,
    providerHandle: null,
  };
}

function team(label: string): EnvironmentRow {
  return {
    ...personal(),
    environmentId: "env-team",
    ownerKind: "organization",
    ownerId: "org-1",
    roomId: "room-team",
    label,
    kind: "team",
  };
}

const PERSONAL_BOTS: BotListResponse = {
  bots: [tracyRecord(PERSONAL_MAIN_BOT_ID, "env-me")],
  mainBotIds: { "env-me": PERSONAL_MAIN_BOT_ID },
};

const BOTH_BOTS: BotListResponse = {
  bots: [
    tracyRecord(PERSONAL_MAIN_BOT_ID, "env-me"),
    tracyRecord(TEAM_MAIN_BOT_ID, "env-team"),
  ],
  mainBotIds: {
    "env-me": PERSONAL_MAIN_BOT_ID,
    "env-team": TEAM_MAIN_BOT_ID,
  },
};

function onboardingWith(setup: BotOnboardingSetup): BotOnboardingReadResponse {
  return {
    github: {
      state: "ok",
      installingAdmin: null,
      repositories: [],
      callerCanConnect: true,
    },
    unlocked: false,
    choice: null,
    catalog: [],
    setup,
  };
}

const NEEDS_HOST: BotOnboardingSetup = {
  botId: SETUP_BOT_ID,
  title: "Tracy",
  state: "needs_host",
  arrival: null,
};

/** The host's answers; a test swaps one to change what the next read sees. */
interface HostAnswers {
  environments: () =>
    | EnvironmentListResponseV11
    | Promise<EnvironmentListResponseV11>;
  bots: () => BotListResponse | Promise<BotListResponse>;
}

function mountHost(answers: HostAnswers): (children: ReactNode) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let requestCounter = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestCounter += 1;
        return `req-${String(requestCounter)}`;
      },
      handlers: {
        "environment.list": () => answers.environments(),
        "bot.list": () => answers.bots(),
        "bot.onboarding.read": () => onboardingWith(NEEDS_HOST),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  host.client = spine.createRequester(mockLocalHostEntry);
  return (children) => (
    <QueryClientProvider client={queryClient}>
      <StandaloneBotsBridge />
      {children}
    </QueryClientProvider>
  );
}

/** A closed phone picker: the one consumer mounted besides the bridge. */
function pickerOn(botId: string): ReactNode {
  return (
    <BotChannelTitle
      level2="menu"
      title="Tracy"
      activeBotId={botId}
      hostId="host-1"
      threadsView={null}
    />
  );
}

function titleText(): string {
  return screen.getByTestId("bot-tab-title").textContent;
}

function verdictArrival(botId: string): HostNotificationsCloudFeedRowV16 {
  return {
    entryId: "verdict-1",
    originHostId: "host-1",
    coalesceKey: "verdict-1",
    entry: {
      id: "verdict-1",
      updatedAt: 1_000,
      readAt: null,
      kind: "host.operation.finished",
      sourceRef: null,
      severity: "done",
      outcome: "completed",
      epicId: botId,
      chatId: "thread-1",
      payload: {
        kind: "bot_thread_verdict",
        operation: "bot.thread.verdict",
        title: "Tracy answered",
        message: "The release is out",
        botId,
        threadId: "thread-1",
        replyMessageId: "message-1",
      },
    },
    presentation: { epicTitle: "Tracy", chatTitle: null },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  resetNotificationFeedDisplayReceiptsForTests();
  host.support = true;
  host.reachability = "reachable";
  host.leaseStatus = null;
  signIn("user-a");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.dismiss();
  useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE);
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("<StandaloneBotsBridge /> on window focus", () => {
  it("shows a team's new name with only the bridge and a closed picker mounted", async () => {
    let label = "traycerai";
    const app = mountHost({
      environments: () => ({ environments: [personal(), team(label)] }),
      bots: () => BOTH_BOTS,
    });
    render(app(pickerOn(TEAM_MAIN_BOT_ID)));
    await waitFor(() => {
      expect(titleText()).toBe("Tracy · traycerai");
    });

    label = "renamed";
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(titleText()).toBe("Tracy · renamed");
    });
  });

  it("drops a team the person left", async () => {
    let environments = [personal(), team("traycerai")];
    const app = mountHost({
      environments: () => ({ environments }),
      bots: () => BOTH_BOTS,
    });
    render(app(pickerOn(TEAM_MAIN_BOT_ID)));
    await waitFor(() => {
      expect(titleText()).toBe("Tracy · traycerai");
    });

    environments = [personal()];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(titleText()).toBe("Tracy");
    });
  });
});

describe("<StandaloneBotsBridge /> and a main bot still to be set up", () => {
  function setupChannel(environmentLabel: string): ReactNode {
    return (
      <TeamSetupChannel
        setup={{
          environmentId: "env-team",
          teamName: environmentLabel,
          botId: SETUP_BOT_ID,
          title: "Tracy",
        }}
        client={host.client}
        hostId={mockLocalHostEntry.hostId}
        level2="menu"
        threadsView={THREADS_CLOSED}
      />
    );
  }

  it("places the setup channel's closed picker when a personal Tracy is also visible", async () => {
    const app = mountHost({
      environments: () => ({
        environments: [personal(), team("traycerai")],
      }),
      bots: () => PERSONAL_BOTS,
    });
    render(app(setupChannel("traycerai")));

    await waitFor(() => {
      expect(titleText()).toBe("Tracy · traycerai");
    });
  });

  it("keeps the setup channel's picker to the name when it is the only main bot", async () => {
    const app = mountHost({
      environments: () => ({ environments: [team("traycerai")] }),
      bots: () => ({ bots: [], mainBotIds: {} }),
    });
    render(app(setupChannel("traycerai")));

    await waitFor(() => {
      expect(useStandaloneBotsStore.getState().settled).toBe(true);
    });
    expect(useStandaloneBotsStore.getState().directory.setups).toHaveLength(1);
    expect(titleText()).toBe("Tracy");
  });
});

describe("a bot's notification before the directory has answered", () => {
  function nativeTarget() {
    return {
      showNotification: vi.fn((_request: { readonly title: string }) =>
        Promise.resolve<NotificationShowOutcome>("presented"),
      ),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
  }

  it("names the native notification and the toast once the lists answer", async () => {
    const lists = deferred<BotListResponse>();
    const app = mountHost({
      environments: () => ({
        environments: [personal(), team("traycerai")],
      }),
      bots: () => lists.promise,
    });
    render(app(<Toaster />));
    const target = nativeTarget();

    const delivery = displayCloudSnapshotArrivals(
      [verdictArrival(TEAM_MAIN_BOT_ID)],
      target,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(target.showNotification).not.toHaveBeenCalled();

    lists.resolve(BOTH_BOTS);
    await act(async () => {
      await delivery;
    });

    expect(target.showNotification.mock.calls[0]?.[0].title).toBe(
      "Tracy · traycerai",
    );
    expect(await screen.findByText("Tracy · traycerai")).toBeTruthy();
  });

  it("falls back to the plain name when a list read fails", async () => {
    const lists = deferred<BotListResponse>();
    const app = mountHost({
      environments: () => ({
        environments: [personal(), team("traycerai")],
      }),
      bots: () => lists.promise,
    });
    render(app(<Toaster />));
    const target = nativeTarget();

    const delivery = displayCloudSnapshotArrivals(
      [verdictArrival(TEAM_MAIN_BOT_ID)],
      target,
    );
    lists.reject(new Error("bot.list failed"));
    await act(async () => {
      await delivery;
    });

    expect(target.showNotification.mock.calls[0]?.[0].title).toBe("Tracy");
  });

  it("shows the old account nothing once it has left, whatever the lists do after", async () => {
    const lists = deferred<BotListResponse>();
    const app = mountHost({
      environments: () => ({
        environments: [personal(), team("traycerai")],
      }),
      bots: () => lists.promise,
    });
    render(app(<Toaster />));
    const target = nativeTarget();

    const delivery = displayCloudSnapshotArrivals(
      [verdictArrival(TEAM_MAIN_BOT_ID)],
      target,
    );
    act(() => {
      signIn("user-b");
    });
    // Ends with the account's departure: nothing keeps waiting on the lists.
    await act(async () => {
      await delivery;
    });

    lists.resolve(BOTH_BOTS);
    await waitFor(() => {
      expect(useStandaloneBotsStore.getState().settled).toBe(true);
    });
    expect(target.showNotification).not.toHaveBeenCalled();
    expect(screen.queryByText("Tracy")).toBeNull();
    expect(screen.queryByText("Tracy · traycerai")).toBeNull();
  });
});

describe("a bot's notification while the serving host has no handshake", () => {
  function nativeTarget() {
    return {
      showNotification: vi.fn((_request: { readonly title: string }) =>
        Promise.resolve<NotificationShowOutcome>("presented"),
      ),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
  }

  function appWithNoAnswers(): ReactNode {
    return mountHost({
      environments: () => ({ environments: [] }),
      bots: () => ({ bots: [], mainBotIds: {} }),
    })(<Toaster />);
  }

  it("shows the plain name when the host is unreachable", async () => {
    host.support = null;
    host.reachability = "unreachable";
    render(appWithNoAnswers());
    const target = nativeTarget();

    await act(async () => {
      await displayCloudSnapshotArrivals(
        [verdictArrival(TEAM_MAIN_BOT_ID)],
        target,
      );
    });

    expect(target.showNotification.mock.calls[0]?.[0].title).toBe("Tracy");
    expect(await screen.findByText("Tracy")).toBeTruthy();
  });

  it("shows the plain name when the host's lease says it is dead", async () => {
    host.support = null;
    host.leaseStatus = "dead";
    render(appWithNoAnswers());
    const target = nativeTarget();

    await act(async () => {
      await displayCloudSnapshotArrivals(
        [verdictArrival(TEAM_MAIN_BOT_ID)],
        target,
      );
    });

    expect(target.showNotification.mock.calls[0]?.[0].title).toBe("Tracy");
  });

  it("keeps waiting while the handshake is still under way, and goes on when it fails", async () => {
    host.support = null;
    host.reachability = "checking";
    const { rerender } = render(appWithNoAnswers());
    const target = nativeTarget();

    const delivery = displayCloudSnapshotArrivals(
      [verdictArrival(TEAM_MAIN_BOT_ID)],
      target,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(target.showNotification).not.toHaveBeenCalled();

    host.reachability = "unreachable";
    rerender(appWithNoAnswers());
    await act(async () => {
      await delivery;
    });

    expect(target.showNotification.mock.calls[0]?.[0].title).toBe("Tracy");
  });

  describe.each([
    ["ready", "ready"],
    ["connecting", null],
  ])("with a reachable host and a %s lease", (_name, leaseStatus) => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the plain name once the host-load budget runs out", async () => {
      host.support = null;
      host.reachability = "reachable";
      host.leaseStatus = leaseStatus;
      render(appWithNoAnswers());
      const target = nativeTarget();

      const delivery = displayCloudSnapshotArrivals(
        [verdictArrival(TEAM_MAIN_BOT_ID)],
        target,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TILE_CONTENT_BUDGET_MS - 1_000);
      });
      expect(target.showNotification).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await act(async () => {
        await delivery;
      });

      expect(target.showNotification.mock.calls[0]?.[0].title).toBe("Tracy");
      expect(await screen.findByText("Tracy")).toBeTruthy();
    });
  });
});
