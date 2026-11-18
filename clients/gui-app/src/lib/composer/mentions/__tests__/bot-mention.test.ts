import { describe, expect, it } from "vitest";
import { splitPromptIntoComposerSegments } from "@/lib/composer/segments";

describe("a bot token in sent text", () => {
  it("splits into a mention segment at the end of the prompt", () => {
    expect(splitPromptIntoComposerSegments("ask @bot:bot-1")).toEqual([
      { type: "text", text: "ask " },
      { type: "mention", path: "bot:bot-1" },
    ]);
  });
});
