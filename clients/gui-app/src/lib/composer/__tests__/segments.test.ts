import { describe, expect, it } from "vitest";
import {
  splitPromptIntoComposerSegments,
  collapsedPromptLength,
} from "../segments";

describe("splitPromptIntoComposerSegments", () => {
  it("empty string returns no segments", () => {
    expect(splitPromptIntoComposerSegments("")).toEqual([]);
  });

  it("plain text one segment", () => {
    expect(splitPromptIntoComposerSegments("hello world")).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("mention at start with trailing space", () => {
    expect(splitPromptIntoComposerSegments("@src/foo.ts hi")).toEqual([
      { type: "mention", path: "src/foo.ts" },
      { type: "text", text: " hi" },
    ]);
  });

  it("mention mid-text", () => {
    expect(splitPromptIntoComposerSegments("hey @a.ts look")).toEqual([
      { type: "text", text: "hey " },
      { type: "mention", path: "a.ts" },
      { type: "text", text: " look" },
    ]);
  });

  it("mention without trailing space stays text", () => {
    expect(splitPromptIntoComposerSegments("hey @a.ts")).toEqual([
      { type: "text", text: "hey @a.ts" },
    ]);
  });

  it("multiple mentions", () => {
    expect(splitPromptIntoComposerSegments("@a.ts @b.ts end")).toEqual([
      { type: "mention", path: "a.ts" },
      { type: "text", text: " " },
      { type: "mention", path: "b.ts" },
      { type: "text", text: " end" },
    ]);
  });

  it("email-like is not a mention", () => {
    expect(
      splitPromptIntoComposerSegments("send to foo@bar.com please"),
    ).toEqual([{ type: "text", text: "send to foo@bar.com please" }]);
  });
});

describe("collapsedPromptLength", () => {
  it("counts mention as 1", () => {
    expect(collapsedPromptLength("@src/foo.ts hi")).toBe(4); // mention(1) + " hi"(3)
  });

  it("plain text length", () => {
    expect(collapsedPromptLength("hello")).toBe(5);
  });
});
