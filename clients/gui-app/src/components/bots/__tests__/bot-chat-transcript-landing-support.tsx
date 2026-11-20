import { create, type StoreApi, type UseBoundStore } from "zustand";
import { vi, type Mock } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";

/** What a mounted bot transcript reads of a chat's session store, over one scripted conversation. */
export type LandingState = Pick<
  ChatSessionState,
  | "snapshotLoaded"
  | "messages"
  | "events"
  | "transcriptRowContext"
  | "transcriptDerived"
  | "pendingUserMessages"
  | "queue"
  | "turnInProgress"
  | "messageDelivery"
  | "liveAssistantMessage"
  | "activeTurn"
  | "pendingApprovals"
  | "pendingFileEditApprovals"
  | "pendingInterviews"
  | "runStatus"
  | "transcriptWindow"
  | "transcriptBaselineEpoch"
  | "transcriptHydrationSequence"
  | "coldRewrittenMessageIds"
  | "backgroundItems"
  | "reportVisibleTranscriptRange"
  | "requestFindReadOrdinal"
  | "requestTranscriptOrdinal"
>;

export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const CHAT_ID = "conversation-app";
export const REPLY_ID = "reply-uuid";

const ASK: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Please review" }] },
  ],
};

const BOT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

export function resolvedUserMessage(): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId: "ask-1",
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: ASK, browserAnnotations: [] },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: "req-1",
      resolvedAt: 1_000,
      resolvedByMessageId: REPLY_ID,
    },
  };
}

/** A message between a post and its reply, so the reply is not the next row. */
export function otherUserMessage(): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId: "other-1",
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: ASK, browserAnnotations: [] },
    timestamp: 1_500,
    sessionAnchor: null,
  };
}

function textBlock(blockId: string, text: string): ContentBlock {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp: 2_000,
    text,
    providerNotice: null,
  };
}

function assistantMessage(input: {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly timestamp: number;
  readonly text: string;
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: BOT_SENDER,
    blocks: [textBlock(`${input.messageId}:text`, input.text)],
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

export function reply(): Extract<Message, { role: "assistant" }> {
  return assistantMessage({
    messageId: REPLY_ID,
    turnId: null,
    timestamp: 2_000,
    text: "Here is my review",
  });
}

export function createLandingStore(
  messages: ReadonlyArray<Message>,
  requestTranscriptOrdinal: Mock<(ordinal: number | null) => void>,
): UseBoundStore<StoreApi<LandingState>> {
  return create<LandingState>()(() => ({
    snapshotLoaded: true,
    messages,
    events: [],
    transcriptRowContext: {},
    transcriptDerived: null,
    pendingUserMessages: [],
    queue: { status: "idle", items: [] },
    turnInProgress: undefined,
    messageDelivery: null,
    liveAssistantMessage: null,
    activeTurn: null,
    pendingApprovals: [],
    pendingFileEditApprovals: [],
    pendingInterviews: [],
    runStatus: "idle",
    transcriptWindow: emptyTranscriptWindow(),
    transcriptBaselineEpoch: 0,
    transcriptHydrationSequence: 0,
    coldRewrittenMessageIds: new Set<string>(),
    backgroundItems: undefined,
    reportVisibleTranscriptRange: vi.fn(),
    requestFindReadOrdinal: vi.fn(),
    requestTranscriptOrdinal,
  }));
}
