/**
 * A bot's session holding a message FROM a task agent (Tracy Bots T108): the
 * REAL `BotSessionView` over the REAL `BotChatTranscript` and `ChatMessages`,
 * with no `<EpicSessionProvider>` anywhere above it, as a bot tab mounts it.
 * Tracy's trunk answers every A2A request a task agent sends it, so its
 * session holds these cards; reaching for the open task there threw
 * "useOpenEpicHandle must be called inside <EpicSessionProvider>" into the
 * tile's error boundary. Only the session registry, the host reads and the
 * top-level navigation seam are replaced.
 */
import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessagePeer } from "@traycer/protocol/host/agent/message-peer";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

interface PeerQueryArgs {
  readonly method: string;
  readonly params: {
    readonly epicId: string;
    readonly chatId: string;
    readonly agentId: string;
  };
  readonly options: { readonly enabled: boolean };
}

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  /** Every `agent.resolveMessagePeer` read the card made. */
  peerQueries: [] as PeerQueryArgs[],
  peer: null as AgentMessagePeer | null,
  navigate: vi.fn(),
  activateTabIntent:
    vi.fn<(navigate: unknown, intent: unknown, extra: unknown) => void>(),
  openTile: vi.fn(() => null),
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/host/use-host-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/host/use-host-query")>();
  return {
    ...actual,
    useHostQuery: (args: Parameters<typeof actual.useHostQuery>[0]) => {
      if (args.method !== "agent.resolveMessagePeer") {
        return actual.useHostQuery(args);
      }
      const peerArgs = args as PeerQueryArgs;
      mocks.peerQueries.push(peerArgs);
      return {
        data: peerArgs.options.enabled ? { peer: mocks.peer } : undefined,
        error: null,
      };
    },
  };
});
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: mocks.activateTabIntent,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: mocks.openTile }),
}));

import { BotSessionView } from "@/components/bots/bot-session-view";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  BOT_ID,
  HOST_ID,
  TRUNK_ID,
  scriptedSession,
  textDoc,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";

const IDENTITY: BotIdentity = { botId: BOT_ID, title: "Tracy", owner: null };

const SENDER_ID = "agent-task-sender";
const REQUEST_TEXT = "Which branch carries the pool image fix?";

const TASK_PEER: AgentMessagePeer = {
  epicId: "epic-task",
  agentId: SENDER_ID,
  hostId: "host-task",
  title: "Pool Image Agent",
  surface: "gui",
};

/** A task agent's A2A request, as the bot's trunk persisted it. */
function inboundRequest(): Extract<Message, { role: "user" }> {
  const content = textDoc([REQUEST_TEXT]);
  return {
    role: "user",
    messageId: "inbound-request-1",
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: SENDER_ID,
      displayName: "Stamped Sender",
      reply: { expectsReply: true, responseId: "response-1" },
      inReplyTo: null,
    },
    message: {
      kind: "agent",
      content,
      fromAgentId: SENDER_ID,
      senderTitle: "Stamped Sender",
      senderHarnessId: "codex",
      reply: { expectsReply: true, responseId: "response-1" },
    },
    timestamp: 1_000,
    sessionAnchor: null,
  };
}

/** Wrapped as the bot tab wraps it (`BotTabSurface`): a tab host, no task. */
function mountTrunk(): void {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TabHostProvider hostId={HOST_ID}>
          <TooltipProvider>
            <BotIdentityContext value={IDENTITY}>
              <BotSessionView
                botId={BOT_ID}
                hostId={HOST_ID}
                botTitle="Tracy"
                session={{ chatId: TRUNK_ID, threadId: null, landOn: null }}
                threads={[]}
                resolveMember={UNRESOLVED_BOT_MEMBERS}
                onClose={vi.fn()}
                onOpenChannel={vi.fn()}
                onOpenThread={vi.fn()}
              />
            </BotIdentityContext>
          </TooltipProvider>
        </TabHostProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function view(): HTMLElement {
  return screen.getByTestId("bot-session-view");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.peerQueries = [];
  mocks.peer = null;
  installLegendListViewportMetrics();
  mocks.sessions = {
    [TRUNK_ID]: scriptedSession(TRUNK_ID, [inboundRequest()]).handle,
  };
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
});

describe("a bot's session holding an inbound agent message (no task open)", () => {
  it("renders the received card and asks the host for the sender with the bot as the conversation's container", async () => {
    mocks.peer = TASK_PEER;
    mountTrunk();
    await settleLegendList();

    expect(within(view()).getByText("Received message")).not.toBeNull();
    expect(mocks.peerQueries.length).toBeGreaterThan(0);
    const primary = mocks.peerQueries.at(-2);
    expect(primary?.params).toEqual({
      epicId: BOT_ID,
      chatId: TRUNK_ID,
      agentId: SENDER_ID,
      origin: null,
    });
    expect(primary?.options.enabled).toBe(true);
  });

  it("opens a resolved sender's tile in its own task through the top-level navigation", async () => {
    mocks.peer = TASK_PEER;
    mountTrunk();
    await settleLegendList();

    await userEvent.click(
      within(view()).getByRole("button", { name: "Pool Image Agent" }),
    );

    expect(mocks.activateTabIntent).toHaveBeenCalledTimes(1);
    const [navigate, intent] = mocks.activateTabIntent.mock.calls[0] ?? [];
    expect(navigate).toBe(mocks.navigate);
    expect(intent).toMatchObject({
      kind: "open-epic",
      epicId: "epic-task",
      includeNestedFocus: true,
      preparation: {
        kind: "open-tile",
        gesture: "explicit",
        node: { id: SENDER_ID, type: "chat", hostId: "host-task" },
      },
    });
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("keeps an unresolved sender as an inert chip under its stamped title", async () => {
    mountTrunk();
    await settleLegendList();

    expect(within(view()).getByText("Stamped Sender")).not.toBeNull();
    expect(
      within(view()).queryByRole("button", { name: "Stamped Sender" }),
    ).toBeNull();
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
  });
});
