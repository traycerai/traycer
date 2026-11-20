/** Wire-shape fixtures for a bot's feedback draft, shared by the `chat.subscribe` line tests. */

export const STAMP = {
  category: "tool_problem",
  toolName: "traycer_search_chats",
  goal: "find a chat",
  observed: "an opaque error",
  suggestion: null,
  suggestDiagnostics: false,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

export const CHANNEL_ORIGIN = {
  kind: "channel",
  botId: "bot-1",
  hostEpoch: 3,
  conversationId: "conv-1",
  initiatingMessageId: "msg-1",
  initiatingRequestId: "req-1",
};

export const PROJECTION = {
  source: {
    hostId: "host-1",
    epicId: "epic-1",
    chatId: "chat-1",
    blockId: "b-1",
  },
  draft: STAMP,
};
