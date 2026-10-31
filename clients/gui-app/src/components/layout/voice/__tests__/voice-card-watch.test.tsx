/**
 * The records a bot's own question is read from (Tracy Bots voice, VT5),
 * through the real `VoiceCards` watcher and the real card desk. The hooks
 * the watcher reads its records from are replaced: the bot's row (a chat
 * handle whose store holds it) and the bot's conversation list, which the
 * card's send needs and which answers later. What is asserted is what the
 * desk is told while the list is pending and once it answers.
 */
import { act, cleanup, render } from "@testing-library/react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceQueueOwner } from "@/hooks/voice/use-voice-queue-owner";
import { createCardDesk } from "@/lib/voice/card-desk";
import type { SpeechItem } from "@/lib/voice/scheduler";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";
import { VoiceCards } from "../voice-card-watch";

const ITEM = "q-1";
const BOT_ID = "bot-1";
const HOST = "host-a";

/** The bot's conversation list as the watcher reads it: pending, then answered. */
interface FakeConversations {
  data:
    | {
        readonly conversations: ReadonlyArray<{
          readonly botId: string;
          readonly conversationId: string;
          readonly createdAt: number;
        }>;
      }
    | undefined;
  isError: boolean;
}

const fake = vi.hoisted(() => {
  const conversations: FakeConversations = { data: undefined, isError: false };
  const listeners = new Set<() => void>();
  let messages: ReadonlyArray<unknown> = [];
  const state = { getState: () => ({ messages }) };
  return {
    store: {
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState: state.getState,
    },
    setMessages: (next: ReadonlyArray<unknown>): void => {
      messages = next;
      for (const listener of listeners) listener();
    },
    conversations,
  };
});

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useChatSessionHandleForContainer: () => ({ store: fake.store }),
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => fake.conversations,
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: () => ({
    snapshot: null,
    deleted: false,
    error: null,
    isPending: true,
    resubscribe: () => undefined,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({}),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/bots/use-bot-send-version", () => ({
  useBotSendTakesAnswers: () => true,
}));
vi.mock("@/hooks/bots/use-environment-members-query", () => ({
  useEnvironmentMemberDirectory: () => ({
    resolve: () => ({ displayName: "Dana" }),
  }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/bots/use-bot-surface-act", () => ({
  useBotSurfaceActMutation: () => ({ mutateAsync: vi.fn() }),
}));

const initial = useVoiceSessionStore.getState();

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-1",
  createdByUserId: "user-me",
  title: "Release bot",
  harness: "claude",
  model: "model-1",
  effort: null,
  profile: null,
  trunkChatId: "trunk-bot-1",
  boundHostId: null,
  hostEpoch: 0,
  createdAt: 1,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: "chan-1",
};

/** A bot row asking two questions: the first already settled by a member, the second open. */
const ROW = {
  role: "assistant",
  messageId: ITEM,
  timestamp: 1,
  blocks: [],
  question: {
    requestId: "req-1",
    questions: [
      {
        text: "Which region?",
        options: ["east", "west"],
        allowFreeText: false,
        settlement: {
          answer: "east",
          skipped: false,
          by: { kind: "person", userId: "user-dana" },
          at: 5,
        },
      },
      {
        text: "Ship it?",
        options: ["Ship", "Hold"],
        allowFreeText: false,
        settlement: null,
      },
    ],
  },
};

const CONVERSATIONS = {
  conversations: [{ botId: BOT_ID, conversationId: "chan-1", createdAt: 1 }],
};

function mount() {
  const spoken: SpeechItem[] = [];
  const desk = createCardDesk({
    store: useVoiceSessionStore,
    speech: {
      enqueue: (item) => spoken.push(item),
      withdraw: () => undefined,
      activity: () => ({
        inputActiveUntil: null,
        outputPlaying: false,
        ackPending: false,
      }),
      subscribe: () => () => undefined,
    },
    schedule: () => () => undefined,
    target: () => ({
      family: "bot-question",
      ids: {
        itemId: ITEM,
        botId: BOT_ID,
        hostId: HOST,
        threadId: null,
        chatId: "chan-1",
        messageId: ITEM,
      },
    }),
    newActionId: () => "act-1",
  });
  const owner: VoiceQueueOwner = {
    queue: null,
    attention: { answers: [], prompts: { approvals: [], questions: [] } },
    hostOf: () => HOST,
    bots: [BOT],
    registerMark: () => undefined,
    voiceSwitch: { current: null },
    statusRequests: [],
    onStatusComposed: () => undefined,
    cardDesk: desk,
    surfaceOpens: [],
    onSurfaceOpened: () => undefined,
    beginQueue: () => "",
    resetQueue: () => undefined,
    noteChannel: () => undefined,
    noteFocused: () => undefined,
    keepsFromFocus: () => false,
    noteAnnouncement: () => undefined,
    noteStopped: () => undefined,
    forgetStopped: () => undefined,
    dropStopped: () => undefined,
  };
  // A new element each time, so a rerender reaches the watcher.
  const tree = () => (
    <VoiceCards
      owner={owner}
      speech={null}
      botTitle={() => "Release bot"}
      placeOf={() => "in its channel"}
    />
  );
  const view = render(tree());
  return {
    desk,
    spoken,
    rerender: () => act(() => view.rerender(tree())),
  };
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  fake.setMessages([ROW]);
  fake.conversations = { data: undefined, isError: false };
});

afterEach(() => {
  cleanup();
});

describe("a bot's question whose first question is settled and whose second is open", () => {
  it("says nobody settled it and keeps the card while the conversation list is pending", () => {
    const { desk, spoken } = mount();

    act(() => {
      desk.open(ITEM, "d-1");
    });

    expect(spoken).toEqual([]);
    expect(useVoiceSessionStore.getState().activeCard).toMatchObject({
      state: "proposed",
    });
  });

  it("reads the open question, not the settled first one, once the list answers", () => {
    const { desk, spoken, rerender } = mount();
    act(() => {
      desk.open(ITEM, "d-1");
    });

    fake.conversations = { data: CONVERSATIONS, isError: false };
    rerender();

    expect(useVoiceSessionStore.getState().activeCard).toMatchObject({
      questionIndex: 1,
      state: "proposed",
    });
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toContain("Ship it?");
    expect(spoken[0]?.text).toContain("1. Ship; 2. Hold");
  });
});
