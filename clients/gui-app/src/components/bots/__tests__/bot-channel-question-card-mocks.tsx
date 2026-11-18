/**
 * The question-card files' mocked boundaries whose bodies take more than a
 * line or two. Each file keeps its own `vi.mock` calls (they are hoisted per
 * file) and points them at the bodies here. Like
 * `bot-channel-question-card-state.ts`, it imports no app module at run time,
 * so a factory can reach it while the app's modules are still loading.
 */
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

export async function chatMessagesMock() {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div data-testid="chat-messages-stub">
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
