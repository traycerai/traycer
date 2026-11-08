import { createStore } from "zustand";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";

/** A member's post, as a chat's session holds it. */
export function postRow(messageId: string, text: string): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "user-1" },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [],
    },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: messageId,
      resolvedAt: null,
      resolvedByMessageId: null,
    },
  };
}

/** A chat's session holding the posts in `textByMessageId`, for a `ChannelPost`. */
export function chatSessionWithPosts(
  textByMessageId: Readonly<Record<string, string>>,
): ChatSessionStoreHandle {
  const store = createStore<
    Pick<
      ChatSessionState,
      "messages" | "transcriptWindow" | "holdTranscriptOrdinal"
    >
  >(() => ({
    transcriptWindow: emptyTranscriptWindow(),
    holdTranscriptOrdinal: () => () => undefined,
    messages: Object.entries(textByMessageId).map(([id, text]) =>
      postRow(id, text),
    ),
  }));
  return { store } as ChatSessionStoreHandle;
}

/**
 * A thread's session holding `rows` as the thread's replies, for the real
 * transcript: the channel's session fields plus what the transcript reads of
 * a thread chat.
 */
export function chatSessionWithThreadRows(
  rows: ReadonlyArray<{ readonly messageId: string; readonly text: string }>,
): ChatSessionStoreHandle {
  const store = createStore<
    Pick<
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
      | "holdTranscriptOrdinal"
    >
  >(() => ({
    snapshotLoaded: true,
    messages: rows.map((row) => postRow(row.messageId, row.text)),
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
    reportVisibleTranscriptRange: () => undefined,
    requestFindReadOrdinal: () => undefined,
    requestTranscriptOrdinal: () => undefined,
    holdTranscriptOrdinal: () => () => undefined,
  }));
  return { store } as ChatSessionStoreHandle;
}
