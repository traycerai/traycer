import {
  cleanup,
  render as rtlRender,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import type { SlackUserMessage } from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { queryMountedChatFindUnit } from "@/components/chat/chat-find-highlighter";
import { chatFindMessageContentUnitId } from "@/components/chat/chat-find-projection";
import { UserMessageBody } from "@/components/chat/chat-message-user-body";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRenderedMessages } from "@/stores/chats/rendered-messages";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

afterEach(cleanup);

function render(ui: ReactNode) {
  return rtlRender(
    <ChatExpansionTestProviders tileInstanceId="slack-body-test-tile">
      <TabHostProvider hostId="host-1">
        <TooltipProvider>{ui}</TooltipProvider>
      </TabHostProvider>
    </ChatExpansionTestProviders>,
  );
}

function slackMessage(input: {
  readonly displayName: string | null;
  readonly omitted: SlackUserMessage["omitted"];
}): SlackUserMessage {
  return {
    kind: "slack",
    content: { type: "doc", content: [] },
    author: {
      displayName: input.displayName,
      slackUserId: "U0PRIYA01",
      traycerUserId: null,
    },
    ts: "1760000010.000100",
    trigger: "mention",
    followUp: false,
    omitted: input.omitted,
  };
}

function slackRow(
  slack: SlackUserMessage,
  attachmentNames: readonly string[],
): ChatMessageModel {
  return {
    id: "slack-message:1760000010.000100",
    role: "user",
    content: "why is the nightly red?",
    segments: [],
    structuredContent: null,
    attachments: attachmentNames.map((name) => ({
      kind: "image" as const,
      hash: null,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aW1hZ2U=",
      name,
      size: 128,
    })),
    settings: null,
    createdAt: 1_760_000_010_000,
    completedAt: null,
    stopped: null,
    persistentMessageId: "slack-message:1760000010.000100",
    senderLabel: "You",
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    slackMessage: slack,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

describe("a Slack message row", () => {
  it("shows who wrote it in Slack, its text and its images", () => {
    render(
      <UserMessageBody
        actions={null}
        message={slackRow(slackMessage({ displayName: "Priya", omitted: [] }), [
          "shot.png",
        ])}
      />,
    );

    expect(screen.getByText("Slack message from")).not.toBeNull();
    expect(screen.getByText("Priya")).not.toBeNull();
    expect(screen.getByText("why is the nightly red?")).not.toBeNull();
    expect(screen.getByLabelText(/shot\.png/)).not.toBeNull();
    expect(screen.queryByText(/Not carried/)).toBeNull();
  });

  it("is a unit transcript find can highlight", () => {
    const message = slackRow(
      slackMessage({ displayName: "Priya", omitted: [] }),
      [],
    );
    render(<UserMessageBody actions={null} message={message} />);

    const unit = queryMountedChatFindUnit(
      document.body,
      chatFindMessageContentUnitId(message.id),
    );
    expect(unit?.textContent).toBe("why is the nightly red?");
  });

  it("shows text a composer would read as a mention literally", () => {
    const message: ChatMessageModel = {
      ...slackRow(slackMessage({ displayName: "Priya", omitted: [] }), []),
      content: "bump @scope/package please",
    };
    render(<UserMessageBody actions={null} message={message} />);

    expect(screen.getByText("bump @scope/package please")).not.toBeNull();
  });

  it("reaches the row from the persisted message", () => {
    const persisted: Message = {
      role: "user",
      messageId: "slack-message:1760000010.000100",
      sender: { type: "user", userId: "owner-1" },
      message: {
        ...slackMessage({ displayName: "Priya", omitted: [] }),
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "why is the nightly red?" }],
            },
          ],
        },
      },
      timestamp: 1_760_000_010_000,
      sessionAnchor: null,
    };
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [persisted],
          events: [],
          rowContext: {},
          pendingUserMessages: [],
          withdrawnMessageId: null,
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          setupCardWindows: [],
          epicId: "epic-1",
          ownerId: "owner-1",
          ownerKind: "chat",
          viewTabId: "tab-1",
        },
        {
          resolveUserSenderLabel: () => "You",
          resolveUserSenderAvatarUrl: () => null,
          resolveAgentSenderDisplay: () => ({
            senderLabel: "Agent",
            providerLabel: "Provider",
            modelLabel: null,
          }),
          resolveAgentReasoningLabel: () => null,
          resolveAgentServiceTierLabel: () => null,
          contentBlocksPreview: () => "",
        },
      ),
    );
    const [row] = result.current;
    if (row === undefined) throw new Error("no row rendered");
    render(<UserMessageBody actions={null} message={row} />);

    expect(screen.getByText("Priya")).not.toBeNull();
    expect(screen.getByText("why is the nightly red?")).not.toBeNull();
  });

  it("names an author Slack gave no name for as a Slack user", () => {
    render(
      <UserMessageBody
        actions={null}
        message={slackRow(slackMessage({ displayName: "  ", omitted: [] }), [])}
      />,
    );

    expect(screen.getByText("Slack user")).not.toBeNull();
  });

  it("lists the files the message did not carry", () => {
    render(
      <UserMessageBody
        actions={null}
        message={slackRow(
          slackMessage({
            displayName: "Priya",
            omitted: [
              { fileName: "plans.pdf", reason: "unsupported_type" },
              { fileName: "huge.png", reason: "too_large" },
            ],
          }),
          [],
        )}
      />,
    );

    expect(screen.getByText(/Not carried:/).textContent).toBe(
      "Not carried: plans.pdf, huge.png",
    );
  });
});
