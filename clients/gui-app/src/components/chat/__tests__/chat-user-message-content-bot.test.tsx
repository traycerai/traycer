import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openBotChannel: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: ["host-1"], resolved: true }),
}));
vi.mock("@/lib/bots/open-bot-channel", () => ({
  openBotChannel: mocks.openBotChannel,
}));

import { ChatUserMessageContent } from "@/components/chat/chat-user-message-content";
import { ComposerMentionDecorator } from "@/components/chat/composer/nodes/composer-mention-decorator";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import { mentionAttachmentFromSuggestion } from "@/lib/composer/mentions/attachments";
import type { MentionAttachment } from "@/lib/composer/types";

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.openBotChannel.mockReset();
});

afterEach(() => {
  cleanup();
});

/** A bot as the picker completes it, so the chip reads what a pick carries. */
function botMention(): MentionAttachment {
  const mention = mentionAttachmentFromSuggestion({
    kind: "bot",
    id: "bot:bot-1",
    botId: "bot-1",
    trunkChatId: "trunk-1",
    label: "Tracy · Acme",
    description: "Acme",
    keywords: ["Tracy", "Acme", "tracy", "bot"],
  });
  if (mention === null) throw new Error("a bot entry completes a mention");
  return mention;
}

describe("ChatUserMessageContent bot chip", () => {
  it("draws the bot's picture and name in place of the token", () => {
    render(
      <ChatUserMessageContent
        content="Ask @bot:bot-1 about the release."
        attachments={[botMention()]}
      />,
    );

    expect(screen.getByTestId("bot-avatar")).toBeTruthy();
    const chip = screen.getByText("Tracy · Acme");
    expect(tooltipTextNear(chip)).toBe("Acme");
    expect(screen.queryByText("bot:bot-1")).toBeNull();
  });

  it("opens the bot's channel on a click", async () => {
    const user = userEvent.setup();
    render(
      <ChatUserMessageContent
        content="Ask @bot:bot-1 about the release."
        attachments={[botMention()]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Tracy · Acme" }));

    expect(mocks.openBotChannel).toHaveBeenCalledTimes(1);
    expect(mocks.openBotChannel).toHaveBeenCalledWith(
      mocks.navigate,
      "bot-1",
      expect.objectContaining({ landing: null }),
    );
  });
});

describe("ComposerMentionDecorator bot chip", () => {
  it("draws the bot's picture and name", () => {
    render(
      <ComposerMentionDecorator density="regular" mention={botMention()} />,
    );

    expect(screen.getByTestId("bot-avatar")).toBeTruthy();
    expect(screen.getByText("Tracy · Acme")).toBeTruthy();
  });
});
