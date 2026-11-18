import { describe, expect, it } from "vitest";
import {
  BOT_MENTION_TOKEN,
  botMentionToken,
  mentionOfToken,
} from "@/lib/bots/bot-mentions";

const BOT_ID = "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M0";
const TASK_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

describe("bot mention tokens", () => {
  it("round trips the three mention kinds through their wire tokens", () => {
    const cases = [
      { kind: "person", id: "u-bob" },
      { kind: "bot", id: BOT_ID },
      { kind: "task", id: TASK_ID },
    ] as const;

    for (const mention of cases) {
      expect(mentionOfToken(botMentionToken(mention.kind, mention.id))).toEqual(
        mention,
      );
    }
  });

  it("recognises only valid bot and task ids as tokens", () => {
    const text = `<#include> <#${BOT_ID}> <~not-a-uuid> <~${TASK_ID}>`;
    expect(text.match(BOT_MENTION_TOKEN)).toEqual([
      `<#${BOT_ID}>`,
      `<~${TASK_ID}>`,
    ]);
  });
});
