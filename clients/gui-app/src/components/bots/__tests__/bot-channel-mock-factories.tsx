import { act } from "@testing-library/react";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type {
  BotReadCursorAdvanceRequest,
  BotReadCursorReadResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * The factories behind the mounted bot channel's mocks, for the suites that
 * mount the real `BotChannelView`, transcript and rows: only the virtualised
 * message list, the chat session registry and the channel's neighbouring reads
 * are replaced. A suite declares each `vi.mock` itself, where it hoists, keeps
 * its state in `vi.hoisted` and hands it to the factory here. This module takes
 * nothing of the app at run time, so a factory can be built while the app's own
 * modules are still loading.
 */

export type ScrollOutcome = "landed" | "exhausted" | "cancelled";

export interface ChannelMockState {
  client: HostRequester<HostRpcRegistry> | null;
  sessions: Record<string, ChatSessionStoreHandle>;
  /** The read cursors the host answers, and who is told when they move. */
  read: {
    value: BotReadCursorReadResponse;
    listeners: Set<() => void>;
  };
  /** Whether the pane the channel is in is on screen, and who is told when it changes. */
  pane: { visible: boolean; listeners: Set<() => void> };
  /** Every advance the view sent, in order. */
  advances: BotReadCursorAdvanceRequest[];
  /** What the host has said about the row a jump waits on. */
  locate: { status: "waiting" } | { status: "missing" };
  /** The thread summaries the channel's thread list answers. */
  threads: ReadonlyArray<object>;
  /** Reports how the transcript's scroll request now showing ended. */
  settleScroll: ((outcome: ScrollOutcome) => void) | null;
}

export function setRead(
  state: ChannelMockState,
  next: BotReadCursorReadResponse,
): void {
  state.read.value = next;
  for (const listener of state.read.listeners) listener();
}

export function setPaneVisible(
  state: ChannelMockState,
  visible: boolean,
): void {
  act(() => {
    state.pane.visible = visible;
    for (const listener of state.pane.listeners) listener();
  });
}

export function chatSessionRegistryMock(
  state: ChannelMockState,
  original: object,
): object {
  return {
    ...original,
    useChatSessionHandleForContainer: (
      _botId: string,
      chatId: string,
    ): ChatSessionStoreHandle | null =>
      Object.hasOwn(state.sessions, chatId) ? state.sessions[chatId] : null,
    useExistingChatSessionHandle: (
      _epicId: string,
      chatId: string,
    ): ChatSessionStoreHandle | null =>
      Object.hasOwn(state.sessions, chatId) ? state.sessions[chatId] : null,
  };
}

export function paneVisibilityMock(state: ChannelMockState): object {
  return {
    usePaneVisible: () =>
      useSyncExternalStore(
        (listener) => {
          state.pane.listeners.add(listener);
          return () => state.pane.listeners.delete(listener);
        },
        () => state.pane.visible,
      ),
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  };
}

export function botConversationListQueryMock(channelId: string): object {
  return {
    useBotConversationListQuery: () => ({
      data: { conversations: [{ conversationId: channelId }] },
      isError: false,
      refetch: vi.fn(),
    }),
  };
}

export function botThreadListQueryMock(state: ChannelMockState): object {
  return {
    useBotThreadListQuery: () => ({
      data: { threads: state.threads, threadAnchors: null },
      isError: false,
      refetch: vi.fn(),
    }),
  };
}

export function botReadCursorMock(
  state: ChannelMockState,
  original: object,
): object {
  return {
    ...original,
    useBotReadCursors: () => ({
      data: useSyncExternalStore(
        (listener) => {
          state.read.listeners.add(listener);
          return () => state.read.listeners.delete(listener);
        },
        () => state.read.value,
      ),
    }),
    useBotReadCursorAdvanceMutation: () => ({
      mutateAsync: (
        variables: BotReadCursorAdvanceRequest & {
          readonly signal?: AbortSignal | null;
        },
      ): Promise<void> => {
        const { botId, conversationId, messageId, seq } = variables;
        state.advances.push({ botId, conversationId, messageId, seq });
        setRead(state, {
          cursors: {
            ...state.read.value.cursors,
            [conversationId]: { messageId, seq },
          },
          latest: state.read.value.latest,
        });
        return Promise.resolve();
      },
    }),
  };
}

export function hostSupportsMethodMock(original: object): object {
  return { ...original, useHostMethodSupport: () => true };
}

export function notificationIndicatorsMock(): object {
  return { useNotificationIndicators: () => ({ epics: {}, chats: {} }) };
}

export function markEntityReadMock(): object {
  return { useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }) };
}

export function harnessCatalogMock(): object {
  return { useGuiHarnessCatalogForClient: () => ({ harnesses: [] }) };
}

export function chatLocateRowMock(state: ChannelMockState): object {
  return {
    useChatLocateRow: () => null,
    useChatLocateRowAnswer: () => state.locate,
  };
}

export function resolvedThemeMock(): object {
  return {
    useResolvedTheme: () => ({
      resolvedTheme: "light",
      themePreset: "neutral",
    }),
  };
}

export function botActivityMock(original: object): object {
  return { ...original, useBotActivity: () => null };
}

export function tabHostClientMock(state: ChannelMockState): object {
  return { useTabHostClient: () => state.client };
}

/** The app's pieces the message list stub draws its rows with, imported by the suite. */
export interface ChatMessagesStubParts {
  readonly Providers: (props: {
    readonly tileInstanceId: string;
    readonly children: ReactNode;
  }) => ReactNode;
  readonly ChatMessage: (props: {
    readonly message: ChatMessageModel;
    readonly actions: null;
    readonly backgroundToolBlockIds: ReadonlySet<string>;
    readonly nextStepActions: null;
  }) => ReactNode;
  readonly TimelineHeader: () => ReactNode;
}

/** The message list as a stub: its rows, the request it was asked to scroll to, and a way to settle that request. */
export function chatMessagesStubMock(
  state: ChannelMockState,
  parts: ChatMessagesStubParts,
): object {
  const { Providers, ChatMessage, TimelineHeader } = parts;
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
      scrollRequest?: { requestId?: number; messageId?: string } | null;
      onScrollRequestSettled?:
        | ((requestId: number, outcome: ScrollOutcome) => void)
        | null;
    }): ReactNode => {
      const requestId = props.scrollRequest?.requestId;
      const settled = props.onScrollRequestSettled;
      useEffect(() => {
        if (requestId === undefined || !settled) return;
        state.settleScroll = (outcome) => settled(requestId, outcome);
        return () => {
          state.settleScroll = null;
        };
      }, [requestId, settled]);
      return (
        <Providers tileInstanceId={props.instanceId}>
          <div
            data-testid="chat-messages-stub"
            data-scroll-to={props.scrollRequest?.messageId ?? ""}
          >
            <TimelineHeader />
            {props.messages.map((message) => (
              <div key={message.id} data-row-id={message.persistentMessageId}>
                <ChatMessage
                  message={message}
                  actions={null}
                  backgroundToolBlockIds={noBackgroundToolBlockIds}
                  nextStepActions={null}
                />
              </div>
            ))}
          </div>
        </Providers>
      );
    },
  };
}
