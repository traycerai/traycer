/**
 * The Tracy surface and the signed-in account: the REAL `BotTabSurface`
 * with its REAL channel view, box, question cards and send mutation, under
 * `BotDraftsPersistLifecycleBridge`, over a host client that records and
 * answers `bot.conversation.send`. An account switch goes through the auth
 * store. What is asserted is what the next account sees in its channel, and
 * what the drafts store and the mutation cache keep of the last one.
 *
 * The `bot-tab-surface-identity-*.test.tsx` files share what is here: the
 * host, the fixtures, the tree and the per-case lifecycle. Their `vi.mock`
 * calls read `bot-tab-surface-identity-state.ts` and
 * `bot-tab-surface-identity-mocks.tsx`.
 */
import { mocks } from "./bot-tab-surface-mocks";
import { channelHandles } from "./bot-tab-surface-identity-state";
import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "zustand";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotSurfaceActResponse } from "@traycer/protocol/host/bot/surface-schemas";
import { useBotSurfaceActionsStore } from "@/stores/bots/bot-surface-actions-store";
import { botQuestionsText } from "@traycer/protocol/persistence/epic/messages";
import type {
  BotQuestionItem,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { installLegendListTestClock } from "@/components/chat/__tests__/legend-list-test-environment";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type {
  BotActivity,
  BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";
import {
  editableIn,
  textOf,
} from "@/components/bots/__tests__/bot-box-test-support";
import {
  chatSessionWithThreadRows,
  postRow,
} from "@/components/bots/__tests__/bot-channel-rows-test-support";
import { botReply } from "@/components/bots/__tests__/bot-turn-test-support";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  BOT,
  BOT_ID,
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  snapshot,
  TAB_HOST,
} from "./bot-tab-surface-harness";

export const CHANNEL = "conversation-app";
export const ACCOUNT_A = "user-1";
export const ACCOUNT_B = "user-2";
const FAILED_POST = "post-failed";
const QUESTION_ID = "bot-question:req-q";
const HOLD = "Anything to hold back from the train?";

export const activityStore = create<{ activity: BotActivity | null }>()(() => ({
  activity: null,
}));

export let queryClient = new QueryClient();
export let sent: ReadonlyArray<BotConversationSendRequest>;
/** While set, the host refuses every send. */
let refuseSends: boolean;
/** While set, the host holds every send until `refuseHeldSend` refuses it. */
let holdSends: boolean;
/** Refuses the send the host holds. */
export let refuseHeldSend: (() => void) | null;
/** While set, the host holds every card action, answering it when `answerAct` is called. */
export let answerAct: ((response: BotSurfaceActResponse) => void) | null;

/** Sets whether the host refuses every send. */
export function setRefuseSends(refuse: boolean): void {
  refuseSends = refuse;
}

/** Sets whether the host holds every send until `refuseHeldSend` refuses it. */
export function setHoldSends(hold: boolean): void {
  holdSends = hold;
}

function hostClient(): HostRequester<HostRpcRegistry> {
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${String(++seq)}`,
    handlers: {
      "bot.surface.act": () =>
        new Promise<BotSurfaceActResponse>((resolve) => {
          answerAct = resolve;
        }),
      "bot.conversation.send": (params) => {
        sent = [...sent, params];
        if (refuseSends) return Promise.reject(new Error("the host refused"));
        if (holdSends) {
          return new Promise<BotConversationSendResponse>((_, reject) => {
            refuseHeldSend = () => reject(new Error("the host refused"));
          });
        }
        const response: BotConversationSendResponse = {
          messageId: "message-new",
          requestId: "req-new",
          delivery: "written",
          threadId: null,
        };
        return Promise.resolve(response);
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(requestContextOf(ACCOUNT_A));
  hostSpine = spine;
  return spine.createRequester(mockRemoteHostEntry);
}

/** The host client's spine the case sends through, whose request context follows the signed-in account. */
let hostSpine: HostClient<HostRpcRegistry> | null = null;

/** The request context of `userId`, as the auth service sets it before the store follows. */
function requestContextOf(userId: string) {
  return createRequestContextFixture({
    origin: "renderer",
    bearerToken: "tok-1",
    identity: { userId, username: userId, providerHandle: null },
  });
}

export function question(settled: boolean): Message {
  const questions: BotQuestionItem[] = [
    {
      text: HOLD,
      options: [],
      allowFreeText: true,
      settlement: settled
        ? {
            answer: "Nothing",
            skipped: false,
            by: { kind: "person", userId: "user-teammate" },
            at: 3_000,
          }
        : null,
    },
  ];
  return {
    ...botReply({
      messageId: QUESTION_ID,
      text: botQuestionsText(questions),
      timestamp: 2_000,
    }),
    question: { requestId: "req-q", questions },
  };
}

export const FAILED_ON_POST: BotSessionActivity = {
  state: "failed",
  startedAt: 1_500,
  step: null,
  requestId: FAILED_POST,
  reason: null,
};

/** The channel's session: the viewer's failed post and an open question. */
export function channelRows(settled: boolean): ReadonlyArray<Message> {
  return [postRow(FAILED_POST, "Failed text"), question(settled)];
}

export function signInAs(userId: string): void {
  hostSpine?.setRequestContext(requestContextOf(userId));
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      signedOutCause: null,
      signingInAttempt: null,
      profile: {
        userId,
        userName: userId,
        email: `${userId}@example.com`,
        avatarUrl: null,
      },
      contextMetadata: { userId, username: userId },
    });
  });
}

export function signOut(): void {
  hostSpine?.setRequestContext(null);
  act(() => {
    useAuthStore.setState({
      status: "signed-out",
      signedOutCause: "retired",
      signingInAttempt: null,
      profile: null,
      contextMetadata: null,
    });
  });
}

export function surfaceTree(): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotDraftsPersistLifecycleBridge>
          <BotTestRunnerHost>
            <TooltipProvider>
              <ChatExpansionTestProviders tileInstanceId="tile-1">
                <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
              </ChatExpansionTestProviders>
            </TooltipProvider>
          </BotTestRunnerHost>
        </BotDraftsPersistLifecycleBridge>
      </QueryClientProvider>
    </StrictMode>
  );
}

/** Mounts the surface; the result draws it again, as a hook's new answer would. */
export function mountSurface(): { readonly redraw: () => void } {
  const view = render(surfaceTree());
  return { redraw: () => view.rerender(surfaceTree()) };
}

export function channelBox(): HTMLElement {
  return editableIn(screen.getByTestId("bot-channel-composer-input"));
}

/** Every read of the stored drafts a case starts, as the drafts store reports it. */
let rehydrations: MockInstance<typeof useBotDraftsStore.persist.rehydrate>;

/**
 * Registers the per-case setup and teardown of the identity cases. A test file
 * calls it once at its top level: this module is shared by every file of a
 * worker, so its own top level registers no hook.
 */
export function installIdentityCaseLifecycle(): void {
  beforeEach(() => {
    rehydrations = vi.spyOn(useBotDraftsStore.persist, "rehydrate");
    installLegendListTestClock();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    resetBotTabSurfaceMocks();
    // The bot runs on the tab's host: the card's answers are taken here.
    mocks.state.snapshot = {
      ...snapshot(),
      bot: { ...BOT, boundHostId: TAB_HOST },
    };
    // The host takes a card's answers and a set of them.
    mocks.state.onboardingVersion = { major: 1, minor: 5 };
    sent = [];
    refuseSends = false;
    holdSends = false;
    refuseHeldSend = null;
    answerAct = null;
    useBotSurfaceActionsStore.setState({ entries: {} });
    channelHandles.handles.clear();
    activityStore.setState({ activity: null });
    localStorage.clear();
    useBotDraftsStore.setState({
      answers: {},
      threadBoxes: {},
      unsentBoxes: {},
      boxCarries: {},
      boxNotices: {},
      // Whose drafts the store holds, and whether their read finished: a case that
      // retires an identity leaves the next case's tab waiting on the last one's.
      owner: null,
      ownDraftsRead: true,
    });
    // The reset above reads to the writer as boxes cleared, which an earlier
    // case's loaded drafts make a pending write: the page hiding lands it now,
    // before the case stores its own entries.
    window.dispatchEvent(new Event("pagehide"));
    localStorage.clear();
    channelHandles.client = hostClient();
    negotiateBotSend(TAB_HOST, { major: 1, minor: 2 });
    signInAs(ACCOUNT_A);
  });

  afterEach(async () => {
    // Every image read a case held ends before its tree goes, so it cannot
    // land in the next case's store: the drafts store's own reads are what
    // end, each only once every box of it is handed over or refused.
    for (const gate of channelHandles.imageGates.values()) gate.resolve();
    const reads = rehydrations.mock.results.flatMap((result) =>
      result.type === "return" ? [result.value] : [],
    );
    await act(async () => {
      await Promise.allSettled(reads.map((read) => Promise.resolve(read)));
    });
    rehydrations.mockRestore();
    endBotTabSurfaceCase(queryClient);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    resetBotFailedRequestSupport();
    channelHandles.handles.clear();
    channelHandles.imageGates.clear();
    localStorage.clear();
  });
}

/**
 * A's channel box editing a failed post, an answer moved in below it by a
 * teammate's settlement, and the replacement refused: the document is back
 * as the edit.
 */
export async function refusedEditWithMovedAnswer(): Promise<void> {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  refuseSends = true;
  activityStore.setState({
    activity: { trunk: FAILED_ON_POST, threads: {} },
  });
  const handle = chatSessionWithThreadRows(channelRows(false));
  channelHandles.handles.set(CHANNEL, handle);
  mountSurface();
  await user.click(await screen.findByTestId("bot-message-edit"));
  expect(textOf(channelBox())).toBe("Failed text");
  await user.type(
    within(screen.getByTestId("question-card")).getByRole("textbox", {
      name: "Your answer",
    }),
    "Hold the migration",
  );
  act(() => handle.store.setState({ messages: channelRows(true) }));
  await vi.waitFor(() =>
    expect(textOf(channelBox())).toBe(`Failed text\n\nHold the migration`),
  );
  await user.click(screen.getByTestId("bot-channel-composer-send"));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  await vi.waitFor(() =>
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy(),
  );
}

/** A thread the host lists, opened on the post `postId` by account A. */
export function listedThreadOf(
  threadId: string,
  postId: string,
): BotThreadSummary {
  return {
    threadId,
    conversationId: CHANNEL,
    sessionChatId: "session-1",
    anchor: {
      messageId: postId,
      requestId: "req-post",
      senderUserId: ACCOUNT_A,
      sentAt: 1_000,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: 1,
    lastReplyAt: 2_000,
    openRequestCount: 1,
    costUsd: null,
  };
}
