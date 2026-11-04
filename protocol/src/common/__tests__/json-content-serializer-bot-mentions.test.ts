import { describe, expect, it } from "vitest";

import { mentionAttachmentFromAttrs } from "../composer-mention-attrs";
import type { JsonContent } from "../registry";
import { ContextType, jsonContentToMarkdown } from "../json-content-serializer";

/**
 * A bot mention names a bot, which is not an agent of the open task: an agent
 * cannot list bots, so the two ids it needs to message one
 * (`traycer_send_message(taskId: <botId>, toAgentId: <trunk>)`) travel in the
 * projected text.
 */

function mentionDoc(attrs: Record<string, unknown>): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "ask " },
          { type: "mention", attrs },
          { type: "text", text: " for status" },
        ],
      },
    ],
  };
}

const BOT_ATTRS = {
  contextType: ContextType.Bot,
  id: "bot-1",
  epicId: "bot-1",
  botId: "bot-1",
  botTrunkChatId: "trunk-1",
  label: "Tracy · Acme",
};

describe("Bot mention serialization", () => {
  it("projects the bot's id and trunk agent id for the LLM", () => {
    expect(
      jsonContentToMarkdown(mentionDoc(BOT_ATTRS), {
        mentionFormat: "llm",
        platform: "POSIX",
      }),
    ).toBe("ask @bot:Tracy · Acme (bot bot-1, trunk agent trunk-1) for status");
  });

  it("projects only the bot id when the trunk agent is unknown", () => {
    expect(
      jsonContentToMarkdown(
        mentionDoc({ ...BOT_ATTRS, botTrunkChatId: undefined }),
        { mentionFormat: "llm", platform: "POSIX" },
      ),
    ).toBe("ask @bot:Tracy · Acme (bot bot-1) for status");
  });

  it("shows a person the bot by title, without its ids", () => {
    expect(
      jsonContentToMarkdown(mentionDoc(BOT_ATTRS), {
        mentionFormat: "user",
        platform: "POSIX",
      }),
    ).toBe("ask `bot:Tracy · Acme` for status");
  });
});

describe("Bot mention attachment decoding", () => {
  it("decodes a bot node to an entity attachment carrying both ids", () => {
    expect(
      mentionAttachmentFromAttrs({ ...BOT_ATTRS, description: "Acme" }),
    ).toEqual({
      kind: "mention",
      contextType: "bot",
      path: "bot:bot-1",
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: "Tracy · Acme",
      description: "Acme",
      epicId: "bot-1",
      artifactId: null,
      artifactType: null,
      chatId: null,
      terminalAgentId: null,
      terminalId: null,
      botId: "bot-1",
      botTrunkChatId: "trunk-1",
      status: null,
    });
  });

  it("leaves both bot ids null on a chat node", () => {
    expect(
      mentionAttachmentFromAttrs({
        contextType: ContextType.Chat,
        id: "chat-1",
        epicId: "epic-1",
        label: "Refactor",
      }),
    ).toMatchObject({
      contextType: "chat",
      chatId: "chat-1",
      botId: null,
      botTrunkChatId: null,
    });
  });
});
