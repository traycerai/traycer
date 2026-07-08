import "../../../../__tests__/test-browser-apis";

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VirtuosoMessageListProps } from "@virtuoso.dev/message-list";
import type { ChatMessageActions } from "@/components/chat/chat-message";
import type { ChatUserMinimapItem } from "@/components/chat/chat-user-message-minimap-items";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpen: () => ({ mutate: () => undefined }),
}));

vi.mock("@virtuoso.dev/message-list", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@virtuoso.dev/message-list")>();

  return {
    ...actual,
    VirtuosoMessageList: VirtuosoMessageListMock,
    VirtuosoMessageListLicense: VirtuosoMessageListLicenseMock,
  };
});

import { ChatMessages } from "@/components/chat/chat-messages";

import { makeMessage } from "./chat-message-fixtures";

type MockVirtuosoItem = ChatMessageModel | undefined;

interface MockChatListContext {
  readonly taskTitle: string;
  readonly hasContent: boolean;
  readonly getMessageActions: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions: NextStepActionHandler | null;
}

function VirtuosoMessageListLicenseMock(props: {
  readonly children: ReactNode;
}) {
  return <>{props.children}</>;
}

function VirtuosoMessageListMock(
  props: VirtuosoMessageListProps<MockVirtuosoItem, MockChatListContext>,
) {
  const ItemContent = props.ItemContent;
  const context = props.context;
  if (ItemContent === undefined || context === undefined) return null;

  const messages = props.data?.data?.filter(isMockChatMessage) ?? [];
  const firstMessage = messages.at(0) ?? null;

  return (
    <div data-testid="mock-virtuoso">
      <ItemContent
        index={0}
        data={undefined}
        prevData={null}
        nextData={firstMessage}
        context={context}
      />
      {messages.map((message, index) => (
        <ItemContent
          key={message.id}
          index={index + 1}
          data={message}
          prevData={messages.at(index - 1) ?? null}
          nextData={messages.at(index + 1) ?? null}
          context={context}
        />
      ))}
    </div>
  );
}

describe("ChatMessages transient Virtuoso rows", () => {
  afterEach(() => {
    cleanup();
  });

  it("skips the transient undefined item content row and keeps rendering real rows", () => {
    const message = makeMessage(1, "user");

    render(
      <ChatMessages
        taskTitle="Transcript"
        taskId="test-task"
        messages={[message]}
        backgroundItems={undefined}
        minimapItems={minimapItemsFor([message])}
        scrollStateKey="transient-row-test"
        getMessageActions={() => null}
        nextStepActions={null}
        instanceId="test-instance"
        visible
        systemOverlayActive={false}
        scrollRequest={null}
      />,
    );

    expect(screen.getByTestId("mock-virtuoso")).not.toBeNull();
    expect(screen.getByText(message.content)).not.toBeNull();
  });
});

function minimapItemsFor(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatUserMinimapItem> {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => ({
      id: message.id,
      content: message.content,
      structuredContent: message.structuredContent,
      attachments: message.attachments,
    }));
}

function isMockChatMessage(
  message: MockVirtuosoItem,
): message is ChatMessageModel {
  return message !== undefined;
}
