import { describe, expect, it } from "vitest";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { splitPromptIntoComposerSegments } from "@/lib/composer/segments";
import {
  collectMentionAttachmentsFromJSONContent,
  mentionAttrsFromAttachment,
} from "@/lib/composer/tiptap-json-content";
import type { BotMentionEntry, MentionAttachment } from "@/lib/composer/types";
import { mentionAttachmentFromSuggestion } from "../attachments";

const ENTRY: BotMentionEntry = {
  kind: "bot",
  id: "bot:bot-1",
  botId: "bot-1",
  trunkChatId: "trunk-1",
  label: "Tracy · Acme",
  description: "Acme",
  keywords: ["Tracy", "Acme", "tracy", "bot"],
};

function pickedMention(): MentionAttachment {
  const mention = mentionAttachmentFromSuggestion(ENTRY);
  if (mention === null) throw new Error("a bot entry completes a mention");
  return mention;
}

function sentDocument(): JsonContent {
  const attachment = pickedMention();
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "ask " },
          { type: "mention", attrs: mentionAttrsFromAttachment(attachment) },
          { type: "text", text: " for status" },
        ],
      },
    ],
  };
}

describe("a bot mention from pick to prompt", () => {
  it("reaches the agent as the bot id and the trunk agent id", () => {
    expect(
      jsonContentToMarkdown(sentDocument(), {
        mentionFormat: "llm",
        platform: "POSIX",
      }),
    ).toBe("ask @bot:Tracy · Acme (bot bot-1, trunk agent trunk-1) for status");
  });

  it("comes back from the document as the picked attachment, ids included", () => {
    expect(collectMentionAttachmentsFromJSONContent(sentDocument())).toEqual([
      pickedMention(),
    ]);
    expect(pickedMention()).toMatchObject({
      contextType: "bot",
      path: "bot:bot-1",
      epicId: "bot-1",
      botId: "bot-1",
      botTrunkChatId: "trunk-1",
    });
  });
});

describe("a bot token in sent text", () => {
  it("splits into a mention segment at the end of the prompt", () => {
    expect(splitPromptIntoComposerSegments("ask @bot:bot-1")).toEqual([
      { type: "text", text: "ask " },
      { type: "mention", path: "bot:bot-1" },
    ]);
  });
});
