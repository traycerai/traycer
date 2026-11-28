/**
 * The transcript list as a stub that draws one `ChatMessage` per row; its own
 * module so the `vi.mock` of the real list reaches it without the tab surface.
 */
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

const NO_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

export const chatMessagesStubModule = {
  ChatMessages: (props: {
    messages: ReadonlyArray<ChatMessageModel>;
    instanceId: string;
  }) => (
    <ChatExpansionTestProviders tileInstanceId={props.instanceId}>
      <div data-testid="chat-messages-stub">
        {props.messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            actions={null}
            backgroundToolBlockIds={NO_BACKGROUND_TOOL_BLOCK_IDS}
            nextStepActions={null}
          />
        ))}
      </div>
    </ChatExpansionTestProviders>
  ),
};
