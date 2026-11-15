/**
 * The state one case of the sent-post suites shares with the mocked
 * boundaries and the probes, and the factories the suites' `vi.mock` calls
 * name. A leaf on purpose: a mock factory runs while the real tab surface is
 * still being imported, so everything it reaches is here and imports nothing
 * of the app but types.
 */
import { vi } from "vitest";
import type {
  HostClient,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import type { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  BotConversationSendRequest,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { BotSentPost } from "@/stores/bots/bot-open-thread-store";

/** The channel's conversation and a thread's chat, as the surface's bot names them. */
export const CHANNEL_CHAT_ID = "conversation-app";

/** One send the fake host holds, until the case settles it. */
export interface HeldSend {
  readonly request: BotConversationSendRequest;
  /** The account the request left under. */
  readonly sentBy: string | null;
  readonly resolve: (threadId: string | null) => void;
  readonly reject: (error: Error) => void;
}

/** A host that holds each send and logs every request it is asked. */
export interface HeldHost {
  readonly requester: HostRequester<HostRpcRegistry>;
  readonly spine: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly sends: HeldSend[];
}

/** What one commit drew, read from the DOM before any passive effect ran. */
export interface DomReading {
  readonly text: string;
  readonly images: ReadonlyArray<string>;
}

/** The state one case shares with the mocked boundaries and the probes. */
export const scene = {
  host: null as HeldHost | null,
  channelHandle: null as ChatSessionStoreHandle | null,
  threadHandle: null as ChatSessionStoreHandle | null,
  threads: [] as BotThreadSummary[],
  /** Every commit of the surface, in order. */
  commits: [] as DomReading[],
  /** The `thread.kind` the real thread panel was rendered with, in order. */
  panelKinds: [] as string[],
  /** The `sent` each call of `threadOriginRow` was given, in order. */
  originSents: [] as Array<BotSentPost | null>,
  /** The line the host negotiated for `bot.conversation.send`. */
  sendLine: { major: 1, minor: 7 } as {
    readonly major: number;
    readonly minor: number;
  },
};

/**
 * The tab suite's method-support mock, with the schema version of
 * `bot.conversation.send` the case negotiated: the box draws a send at Send
 * only where the host takes its nonce.
 */
export function sendLineScripted(base: {
  readonly useHostMethodSchemaVersion: () => {
    readonly major: number;
    readonly minor: number;
  };
}) {
  return {
    ...base,
    useHostMethodSchemaVersion: (_hostId: string | null, method: string) =>
      method === "bot.conversation.send"
        ? scene.sendLine
        : base.useHostMethodSchemaVersion(),
  };
}

export function heldHost(): HeldHost {
  if (scene.host === null) throw new Error("no host in this case");
  return scene.host;
}

export function firstSend(): HeldSend {
  const held = heldHost().sends.at(0);
  if (held === undefined) throw new Error("the host was sent nothing");
  return held;
}

/** The `bot.conversation.send` requests the host was asked for, as logged. */
export function sendRequestsLogged(): ReadonlyArray<unknown> {
  return heldHost()
    .messenger.calls.filter((call) => call.method === "bot.conversation.send")
    .map((call) => call.params);
}

/** The host the surface's tab reads, for the `use-tab-host-client` mock. */
export function tabHostRequester(): HostRequester<HostRpcRegistry> {
  return heldHost().requester;
}

// ---- the factories the suites' `vi.mock` calls name ------------------------ //

/** The chat session registry, answering the channel's and the thread's stores. */
export function chatSessionRegistryMock<T extends object>(original: T): T {
  const handleFor = (chatId: string): ChatSessionStoreHandle | null =>
    chatId === CHANNEL_CHAT_ID ? scene.channelHandle : scene.threadHandle;
  return {
    ...original,
    useChatSessionHandleForContainer: (_botId: string, chatId: string) =>
      handleFor(chatId),
    useExistingChatSessionHandle: (_epicId: string, chatId: string) =>
      handleFor(chatId),
  };
}

export const botConversationListMock = {
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_CHAT_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
};

export const botThreadListChannelMock = {
  useBotThreadListQuery: () => ({
    data: { threads: scene.threads, threadAnchors: null },
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
};

export const notificationMarkReadMock = {
  useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }),
};

export const guiHarnessCatalogMock = {
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
};

export const chatLocateRowMock = {
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
};

export const resolvedThemeMock = {
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
};
