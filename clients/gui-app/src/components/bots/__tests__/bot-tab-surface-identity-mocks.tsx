/**
 * The identity files' mocked boundaries whose bodies take more than a line or
 * two. Each file keeps its own `vi.mock` calls (they are hoisted per file) and
 * points them at the bodies here. Like `bot-tab-surface-mocks.tsx`, it imports
 * no app module at run time, so a factory can reach it while the app's modules
 * are still loading.
 */
import type { ComponentProps } from "react";
import type * as BotMessageComposerModule from "@/components/bots/bot-message-composer";
import type * as LandingImageStoreModule from "@/lib/composer/landing-image-store";
import type * as ChatSessionRegistryModule from "@/lib/registries/chat-session-registry";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { channelHandles } from "./bot-tab-surface-identity-state";

// The composer, with a probe beside it that records what the tree shows at
// every render and layout effect: the viewer the auth store names, and which of
// A's contents (the parent's edit, A's draft and moved answer, a card answer)
// are on screen at that moment.
export async function composerProbeMock(
  actual: typeof BotMessageComposerModule,
) {
  const { useLayoutEffect } = await import("react");
  const { useAuthStore: auth } = await import("@/stores/auth/auth-store");
  const { useBotDraftsStore: drafts } =
    await import("@/stores/bots/bot-drafts-store");
  const { useBotSurfaceActionsStore: cards } =
    await import("@/stores/bots/bot-surface-actions-store");
  const markersOf = (editText: string | null): ReadonlyArray<string> => {
    const found: string[] = [];
    if (editText !== null && editText.includes("Failed text")) {
      found.push("edit");
    }
    // Anything at all in the drafts store is a marker: it holds A's content.
    const state = drafts.getState();
    const slices = [
      ["answers", state.answers],
      ["unsentBoxes", state.unsentBoxes],
      ["draftMoves", state.draftMoves],
      ["boxNotices", state.boxNotices],
      ["threadBoxes", state.threadBoxes],
      ["boxCarries", state.boxCarries],
    ] as const;
    for (const [name, slice] of slices) {
      if (JSON.stringify(slice) !== "{}") found.push(name);
    }
    if (Object.keys(cards.getState().entries).length > 0) found.push("card");
    return found;
  };
  const commitOf = () => ({
    owner: drafts.getState().owner?.userId ?? null,
    read: drafts.getState().ownDraftsRead,
  });
  function Probe(props: { readonly edit: { readonly text: string } | null }) {
    const viewer = auth((state) => state.profile?.userId ?? null);
    const editText = props.edit === null ? null : props.edit.text;
    channelHandles.commits.push(commitOf());
    channelHandles.observed.push({
      at: "render",
      viewer,
      markers: markersOf(editText),
    });
    useLayoutEffect(() => {
      channelHandles.commits.push(commitOf());
      channelHandles.observed.push({
        at: "layout",
        viewer,
        markers: markersOf(editText),
      });
    });
    return null;
  }
  return {
    ...actual,
    BotMessageComposer: (
      props: ComponentProps<typeof actual.BotMessageComposer>,
    ) => (
      <>
        <Probe edit={props.edit} />
        <actual.BotMessageComposer {...props} />
      </>
    ),
  };
}

// A stored draft's image is read back before its box shows: a case holds the read here.
export function landingImageStoreMock(real: typeof LandingImageStoreModule) {
  return {
    ...real,
    getImageBytes: async (hash: string) => {
      await channelHandles.imageGates.get(hash)?.promise;
      return real.getImageBytes(hash);
    },
  };
}

export function chatSessionRegistryMock(
  actual: typeof ChatSessionRegistryModule,
) {
  return {
    ...actual,
    useChatSessionHandleForContainer: (
      _botId: string,
      chatId: string,
    ): ChatSessionStoreHandle | null => {
      const handle = channelHandles.handles.get(chatId);
      return handle === undefined ? null : (handle as ChatSessionStoreHandle);
    },
  };
}

export async function chatMessagesMock() {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  const { QuoteSinkContext } =
    await import("@/components/chat/quote/quote-sink-context");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  /** Stands for the selection's Quote action, which hands the transcript's quote sink a snapshot. */
  function QuoteProbe(props: { readonly chatId: string }) {
    const sink = use(QuoteSinkContext);
    return (
      <button
        type="button"
        data-testid="stub-quote"
        onClick={() => {
          const root = document.createElement("div");
          const range = document.createRange();
          range.selectNodeContents(root);
          sink?.(props.chatId, {
            text: "A's quoted line",
            fenceLanguage: null,
            range,
            root,
          });
        }}
      />
    );
  }
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div data-testid="chat-messages-stub">
          <QuoteProbe chatId={props.instanceId} />
          {use(ChatTimelineHeaderContext)}
          {props.messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              actions={null}
              backgroundToolBlockIds={noBackgroundToolBlockIds}
              nextStepActions={null}
            />
          ))}
        </div>
      </Providers>
    ),
  };
}
