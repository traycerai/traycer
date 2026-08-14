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

describe("GitHub entity tokens and trailing punctuation", () => {
  it("keeps a trailing comma out of the token", () => {
    // The path IS the attachment key. With the comma inside it, the sent
    // message looks up `github-pr:acme/widgets#123,`, misses the real
    // attachment, and renders a generic chip that has eaten the punctuation.
    expect(
      splitPromptIntoComposerSegments("see @github-pr:acme/widgets#123, then"),
    ).toEqual([
      { type: "text", text: "see " },
      { type: "mention", path: "github-pr:acme/widgets#123" },
      { type: "text", text: ", then" },
    ]);
  });

  it("returns the trimmed punctuation to the text at end of input", () => {
    expect(
      splitPromptIntoComposerSegments("fixed by @github-issue:acme/widgets#7."),
    ).toEqual([
      { type: "text", text: "fixed by " },
      { type: "mention", path: "github-issue:acme/widgets#7" },
      { type: "text", text: "." },
    ]);
  });

  it("keeps a host-qualified token whole", () => {
    // The host segment adds slashes and dots; the terminator is still `#\d+`.
    expect(
      splitPromptIntoComposerSegments("@github-pr:ghe.acme.dev/acme/api#42)"),
    ).toEqual([
      { type: "mention", path: "github-pr:ghe.acme.dev/acme/api#42" },
      { type: "text", text: ")" },
    ]);
  });

  it("leaves an unpunctuated token exactly as it was", () => {
    // The control. Trimming must not shorten a token that ends at its
    // reference already.
    expect(
      splitPromptIntoComposerSegments("@github-pr:acme/widgets#123"),
    ).toEqual([{ type: "mention", path: "github-pr:acme/widgets#123" }]);
  });

  it("leaves other entity kinds untouched", () => {
    // The other control, and the deliberate scope: only GitHub tokens state
    // where they end, so only they are trimmed. The pre-existing behaviour for
    // every other kind is unchanged rather than guessed at.
    expect(splitPromptIntoComposerSegments("@spec:epic-1/design,")).toEqual([
      { type: "mention", path: "spec:epic-1/design," },
    ]);
  });
});
