import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  BotRecord,
  BotSubscribeServerFrame,
} from "@traycer/protocol/host/bot/schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { credentialsIdentityFromAuthenticatedUser } from "@traycer-clients/shared/auth/auth-validation";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamParamsProvider } from "@traycer-clients/shared/host-transport/i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ParamsOf,
  StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { createFakeEnvironmentCloudTransport } from "../../../__tests__/create-fake-runner-host";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { publishAgentActivity } from "@/__tests__/agent-activity-harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { MobileBotHeaderSlotProvider } from "@/components/layout/header/mobile-bot-header-slot";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { acquireHostStreamClient } from "@/lib/host/host-stream-client-cache";
import { setMobileApp, setPhoneLayoutOnly } from "@/lib/mobile-app";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import "@/index.css";

/**
 * THE COMPACT CHANNEL ACTIONS MENU, IN THE INSTALLED APP'S PHONE FORM.
 *
 * The real `BotTabSurface` under the real `MobileAppHeader` and its bot slot,
 * over a host that answers one bot with fake data. The claim is real focus:
 * what a choice in the Channel actions menu hands focus to once the menu has
 * closed, which jsdom's focus does not decide. Nothing of the header, the
 * menu, Search or the settings panel is reimplemented.
 *
 * The bot's `bot.subscribe` is a stream, which the mock messenger does not
 * serve, so a stream client that delivers one snapshot is placed in the cache
 * the surface acquires from.
 */

const HOST_ID = "bot-compact-actions-menu-host";
const BOT_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W8Y";
const ENVIRONMENT_ID = "env-personal";
const WEBSOCKET_URL = "ws://127.0.0.1:9/rpc";
const AUTHN_BASE_URL = "http://127.0.0.1:9";
const FIXTURE_TOKEN = "fixture";

useSettingsStore.getState().setTheme("light");
setPhoneLayoutOnly(true);
setMobileApp(true);

// The page offers only what the host advertised in its handshake; this
// fixture's mock messenger makes none, so the methods are recorded here.
recordNegotiatedHostManifest(HOST_ID, {
  "bot.list": { major: 1, minor: 1 },
  "bot.open": { major: 1, minor: 0 },
  "bot.conversation.list": { major: 1, minor: 0 },
  "bot.conversation.search": { major: 1, minor: 0 },
  "bot.thread.list": { major: 1, minor: 2 },
  "bot.threadFollow.read": { major: 1, minor: 0 },
  "bot.readCursor.read": { major: 1, minor: 0 },
  "bot.notificationLevel.read": { major: 1, minor: 0 },
  "bot.turn.locate": { major: 1, minor: 0 },
});

const SIGNED_IN_USER = createAuthenticatedUserFixture(undefined);
const USER_ID = SIGNED_IN_USER.user.id;
const PERSONAL_ENVIRONMENT: EnvironmentDescriptorV11 = {
  environmentId: ENVIRONMENT_ID,
  ownerKind: "user",
  ownerId: USER_ID,
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: ENVIRONMENT_ID,
  createdByUserId: USER_ID,
  title: "Tracy",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: `channel-${BOT_ID}`,
  trunkChatId: `trunk-${BOT_ID}`,
  boundHostId: HOST_ID,
  hostEpoch: 0,
  createdAt: 1_000,
  archivedAt: null,
};

const SNAPSHOT: BotSubscribeServerFrame = {
  kind: "snapshot",
  bot: BOT,
  tasks: [
    {
      taskId: "fixture-task",
      cadence: { kind: "every", seconds: 86400 },
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
      inputNeeded: null,
      pause: null,
      stop: null,
      runRequest: null,
    },
  ],
  openRequestCount: 0,
  conversationsRevision: null,
  boundHost: { hostId: HOST_ID, epoch: 0, isThisHost: true },
  activity: null,
  notificationSubscriptions: null,
  surfaceActions: null,
  stoppedNotificationWatches: null,
  hasBinaryPayload: false,
};

/** One `bot.subscribe` session that opens and delivers the snapshot. */
class SnapshotSession implements IStreamSession {
  readonly close = (): void => undefined;

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    queueMicrotask(() => handler(SNAPSHOT, null));
  }

  onStatusChange(handler: StatusChangeHandler): void {
    queueMicrotask(() => handler("open", null, null, null));
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {}
}

/** A stream client whose every subscribe is a `SnapshotSession`. */
class SnapshotStreamClient implements IHostStreamClient<HostStreamRpcRegistry> {
  readonly instanceId = "bot-compact-actions-menu-stream";

  isReady(): boolean {
    return true;
  }

  subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return new SnapshotSession();
  }

  subscribeWithParamsProvider<
    Method extends keyof HostStreamRpcRegistry & string,
  >(
    _method: Method,
    _paramsProvider: StreamParamsProvider<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return new SnapshotSession();
  }

  getMethodSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {}

  isClosed(): boolean {
    return false;
  }

  getClosedReason(): string | null {
    return null;
  }

  onClosed(): () => void {
    return () => {};
  }

  notifyBearerRotated(): void {}
  notifyCloudVerdictChanged(): void {}

  reconnectAll(_reason: string, _options: ReconnectAllOptions): void {}

  getMethodSupport(): StreamMethodSupport {
    return "unknown";
  }

  subscribeMethodSupport(): () => void {
    return () => {};
  }

  subscribeAvailabilityRecovered(): () => void {
    return () => {};
  }
}

const streamClient = new SnapshotStreamClient();
acquireHostStreamClient(
  {
    kind: "local",
    hostId: HOST_ID,
    userId: USER_ID,
    websocketUrl: WEBSOCKET_URL,
    publicKey: "",
    authnBaseUrl: AUTHN_BASE_URL,
    authRecovery: "revalidate",
  },
  () => streamClient,
);

publishAgentActivity([
  {
    hostId: HOST_ID,
    byEpic: { "fixture-task": { working: ["agent"], turn: ["agent"] } },
  },
]);

const tracyRef = { kind: "tracy", id: "tracy" } as const;
useTabsStore.setState({
  items: [{ kind: "tab", id: tabItemId(tracyRef), ref: tracyRef }],
  activeItemId: tabItemId(tracyRef),
  stripOrder: [tracyRef],
});

const localHost = {
  hostId: HOST_ID,
  websocketUrl: WEBSOCKET_URL,
  version: "1.2.3",
  pid: 4547,
  systemHostName: "bot-compact-actions-menu-fixture",
  displayName: "bot-compact-actions-menu-fixture",
  availability: "available",
} as const;

const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `bot-compact-actions-menu-${String(++requestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
        updatesExternallyManaged: null,
        previousExit: null,
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
      "bot.list": () => ({ bots: [BOT], mainBotIds: null }),
      "bot.open": () => ({
        bot: BOT,
        outcome: { kind: "serve-here", claimed: null },
      }),
      "bot.conversation.list": (request) => ({
        conversations: [
          {
            conversationId: `channel-${request.botId}`,
            botId: request.botId,
            title: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      "bot.thread.list": () => ({
        threads: [],
        trunkCostUsd: null,
        threadAnchors: null,
        nextCursor: null,
        total: 0,
      }),
      "bot.conversation.search": () => ({
        hits: [],
        nextCursor: null,
        indexState: "complete",
        total: 0,
        unreachable: [],
      }),
      "bot.threadFollow.read": () => ({ follows: {} }),
      "bot.readCursor.read": () => ({ cursors: {}, latest: {} }),
      "bot.notificationLevel.read": () => ({ levels: {} }),
      "bot.turn.locate": () => ({ turns: [] }),
    },
  });

/** The real AuthService validates the stored fixture session before rendering. */
function SignedIn(props: { readonly children: ReactNode }): ReactNode {
  const authStatus = useAuthStore((state) => state.status);
  return authStatus === "signed-in" ? props.children : null;
}

function Page(): ReactElement {
  return (
    <ResolvedThemeContext.Provider
      value={{ resolvedTheme: "light", themePreset: "neutral" }}
    >
      <MobileBotHeaderSlotProvider>
        <div className="flex h-safe-dvh min-h-0 flex-col bg-background">
          <MobileAppHeader />
          <div className="flex min-h-0 flex-1">
            <ChatOpenStoreScopeProvider value="compact-actions-menu">
              <ActivityGroupOpenStoreProvider store={null}>
                <A2AOpenStoreProvider store={null}>
                  <ChatFindForceStoreProvider tileInstanceId="compact-actions-menu">
                    <div className="h-full w-full">
                      <BotTabSurface botId={BOT_ID} hostId={HOST_ID} />
                    </div>
                  </ChatFindForceStoreProvider>
                </A2AOpenStoreProvider>
              </ActivityGroupOpenStoreProvider>
            </ChatOpenStoreScopeProvider>
          </div>
        </div>
      </MobileBotHeaderSlotProvider>
    </ResolvedThemeContext.Provider>
  );
}

/** Authn and the directory name the same person the stored session validates. */
class CompactActionsRunnerHost extends MockRunnerHost {
  override readonly environmentTransport = createFakeEnvironmentCloudTransport({
    environments: () => [PERSONAL_ENVIRONMENT],
  });

  override validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult> {
    return Promise.resolve(
      token === FIXTURE_TOKEN
        ? { kind: "valid", user: SIGNED_IN_USER }
        : { kind: "rejected" },
    );
  }

  override listEnvironments(
    bearerToken: string,
  ): Promise<EnvironmentDirectoryResult> {
    return Promise.resolve(
      bearerToken === FIXTURE_TOKEN
        ? { kind: "ok", list: { environments: [PERSONAL_ENVIRONMENT] } }
        : { kind: "unauthorized" },
    );
  }
}

const runnerHost = new CompactActionsRunnerHost({
  signInUrl: `${AUTHN_BASE_URL}/sign-in`,
  authnBaseUrl: AUTHN_BASE_URL,
  localHost,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: new MockTraycerCli(),
});
const storedSession = runnerHost.tokenStore.signIn(
  { token: FIXTURE_TOKEN, refreshToken: "fixture-refresh" },
  credentialsIdentityFromAuthenticatedUser(SIGNED_IN_USER),
);

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={messengerFactory}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="bot-compact-actions-menu-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <SignedIn>
                  <Page />
                </SignedIn>
              </TooltipProvider>
            </WindowsBridgeContext.Provider>
          </HostRuntimeProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

const router = buildRouter();

export function CompactActionsFixture(): ReactElement | null {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    void storedSession.then(() => {
      if (!disposed) setReady(true);
    });
    return () => {
      disposed = true;
    };
  }, []);
  return ready ? <RouterProvider router={router} /> : null;
}
