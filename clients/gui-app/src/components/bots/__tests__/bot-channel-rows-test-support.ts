import { within } from "@testing-library/react";
import { createStore } from "zustand";
import { expect } from "vitest";
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

const QUOTED_TEXT = "implementation not confirmed started.";

/** The first paragraph the host stores when a member types a quote above a plain line. */
export const QUOTE_LINE = `> ${QUOTED_TEXT}`;

/** The second paragraph of that post: the plain line under the quote. */
export const PLAIN_LINE = "can you confirm it?";

/** Expects a row of `QUOTE_LINE` then `PLAIN_LINE` to draw the quote alone in a blockquote. */
export function expectPlainLineOutsideQuote(row: HTMLElement): void {
  const quote = within(row).getByRole("blockquote");
  expect(quote.textContent).toContain(QUOTED_TEXT);
  expect(quote.textContent).not.toContain(PLAIN_LINE);
  expect(
    within(row).getByText(PLAIN_LINE, { exact: false }).closest("blockquote"),
  ).toBeNull();
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
  rows: ReadonlyArray<Message>,
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
    messages: [...rows],
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
