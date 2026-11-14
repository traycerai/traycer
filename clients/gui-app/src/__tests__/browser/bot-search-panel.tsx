import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BotConversationSearchHit,
  BotConversationSearchResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { BotSearchPanel } from "@/components/bots/bot-search-panel";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { openBotSearch } from "@/stores/bots/bot-search-store";
import "@/index.css";

/**
 * THE SEARCH PANEL IN THE PANE THE CHANNEL'S SLOT GIVES IT, AND ON A PHONE.
 *
 * The real `BotSearchPanel` fills a window-high pane `?width=<px>` wide, as the
 * slot beside the channel does (576 by default, 320 at the narrowest) or as
 * the phone's full screen does, over a search the store holds already: the
 * query `release`, in all bots, with the filter row drawn and four results.
 * The host answers `bot.list`, `environment.members` and
 * `bot.conversation.search` and nothing else. One result carries a snippet of
 * many lines, which the row holds to two; the others are short. Nothing of the
 * panel is reimplemented; the fixture supplies the provider stack and the
 * host's answers only.
 */
const HOST_ID = "bot-search-panel-host";
const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "env-team";

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4547,
  systemHostName: "bot-search-panel-fixture",
  displayName: "bot-search-panel-fixture",
  availability: "available",
} as const;

const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function bot(botId: string, title: string): BotRecord {
  return {
    botId,
    environmentId: ENVIRONMENT_ID,
    createdByUserId: "user-1",
    title,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: HOST_ID,
    hostEpoch: 1,
    createdAt: 1_000,
    archivedAt: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: `conversation-${botId}`,
  };
}

const LONG_SNIPPET = Array.from(
  { length: 12 },
  () => "the release train leaves at noon unless the canary pages anyone",
).join(" ");

function hit(
  messageId: string,
  overrides: Partial<BotConversationSearchHit>,
): BotConversationSearchHit {
  return {
    botId: BOT_ID,
    conversationId: `conversation-${BOT_ID}`,
    threadId: null,
    messageId,
    senderUserId: "user-teammate",
    rowKind: "post",
    createdAt: Date.now() - 3_600_000,
    snippet: {
      text: "ship the release today",
      highlights: [{ start: 9, end: 16 }],
    },
    replyCount: null,
    threadExcerpt: null,
    score: 1,
    ...overrides,
  };
}

const HITS: ReadonlyArray<BotConversationSearchHit> = [
  hit("long", {
    snippet: {
      text: LONG_SNIPPET,
      highlights: [{ start: 4, end: 11 }],
    },
    replyCount: 3,
    score: 9,
  }),
  hit("thread", {
    threadId: "thread-1",
    senderUserId: null,
    rowKind: "reply",
    threadExcerpt:
      "Is the release train still leaving at noon given the canary pages from last night?",
    score: 8,
  }),
  hit("question", { rowKind: "question", botId: OTHER_BOT_ID, score: 7 }),
  hit("short", { score: 6 }),
];

const searchAnswer: BotConversationSearchResponse = {
  hits: [...HITS],
  nextCursor: null,
  indexState: "complete",
  total: HITS.length,
  unreachable: [],
};

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `bot-search-panel-${String(++requestCounter)}`,
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
      "bot.list": () => ({
        bots: [bot(BOT_ID, "Release Bot"), bot(OTHER_BOT_ID, "Notes Bot")],
        mainBotIds: null,
      }),
      "environment.members": () => ({
        members: [
          {
            userId: "user-teammate",
            displayName: "Tess Teammate",
            avatarUrl: null,
            effectiveRole: "editor",
            linkedPlan: false,
            inviteState: "accepted",
            invitedAddress: null,
            email: null,
          },
        ],
        nextCursor: null,
        legacyRoleNoticeSeenAt: null,
        legacyMembers: [],
      }),
      "bot.conversation.search": () => searchAnswer,
    },
  });

const width = new URLSearchParams(window.location.search).get("width");

useAuthStore.setState({
  profile: {
    userId: "user-viewer",
    userName: "Vee Viewer",
    email: "vee@example.com",
  },
});
openBotSearch(BOT_ID, { kind: "all" }, "release");

/** Holds the panel back until the host client has its request context. */
function RequestContext(props: { readonly children: ReactNode }): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => setReady(true));
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "fixture" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  return ready ? props.children : null;
}

export function Pane(): ReactElement {
  return (
    <div
      className="flex h-safe-dvh flex-col border-x border-border"
      style={width === null ? undefined : { width: `${width}px` }}
      data-testid="pane"
    >
      <TabHostContext.Provider value={HOST_ID}>
        <BotSearchPanel
          botId={BOT_ID}
          botTitle="Release Bot"
          environmentId={ENVIRONMENT_ID}
          onClose={noop}
        />
      </TabHostContext.Provider>
    </div>
  );
}

function noop(): void {}

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: new MockTraycerCli(),
});

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
            fallback={<div data-testid="bot-search-panel-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <RequestContext>
                  <Pane />
                </RequestContext>
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

const root = document.querySelector("#root");
if (root === null) throw new Error("bot search panel fixture root missing");
createRoot(root).render(<RouterProvider router={buildRouter()} />);
