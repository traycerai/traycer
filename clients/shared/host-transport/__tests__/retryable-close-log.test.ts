import { describe, expect, it } from "vitest";
import { describeRetryableClose } from "../retryable-close-log";

describe("describeRetryableClose", () => {
  it("renders a short ordinary reason verbatim, with no ellipsis", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME_CODE",
      reason: "Chat store is not usable by this build",
    });

    expect(result.line).toContain("Chat store is not usable by this build");
    expect(result.line).not.toContain("…");
  });

  it("bounds a long multiline reason to one line ending in an ellipsis", () => {
    const longSentence = "a".repeat(400);
    const reason =
      `${longSentence}\r\n` +
      `second sentence with\ta tab and more filler ${longSentence}`;

    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME_CODE",
      reason,
    });

    expect(result.line).not.toContain("\n");
    expect(result.line).not.toContain("\r");
    expect(result.line.length).toBeLessThan(400);
    expect(result.line.endsWith("…")).toBe(true);
  });

  it("replaces control characters with spaces instead of deleting them, so sentences do not glue together", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME_CODE",
      reason: "first sentence\nsecond sentence",
    });

    expect(result.line).not.toContain("sentencesecond");
    expect(result.line).toContain("first sentence second sentence");
  });

  it("collapses whitespace runs to a single space", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME_CODE",
      reason: "first    sentence     second",
    });

    expect(result.line).toContain("first sentence second");
  });

  it("renders a whitespace-only reason as <empty>", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME_CODE",
      reason: "   \n\t  ",
    });

    expect(result.line).toContain(": <empty>");
  });

  it("passes an ordinary code through unchanged", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME_CODE",
      reason: "ordinary reason",
    });

    expect(result.line).toContain("code=SOME_CODE");
  });

  it("renders an empty or whitespace-only code as <empty>", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "   ",
      reason: "ordinary reason",
    });

    expect(result.line).toContain("code=<empty>");
  });

  it("renders a code over 64 characters as <oversized>", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "X".repeat(65),
      reason: "ordinary reason",
    });

    expect(result.line).toContain("code=<oversized>");
  });

  it("renders a code containing a space as <unprintable>", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME CODE",
      reason: "ordinary reason",
    });

    expect(result.line).toContain("code=<unprintable>");
  });

  it("renders a code containing a newline as <unprintable>", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME\nCODE",
      reason: "ordinary reason",
    });

    expect(result.line).toContain("code=<unprintable>");
  });

  it("renders a code containing a colon as <unprintable>", () => {
    const result = describeRetryableClose({
      method: "chat.subscribe",
      code: "SOME:CODE",
      reason: "ordinary reason",
    });

    expect(result.line).toContain("code=<unprintable>");
  });

  describe("fingerprint", () => {
    it("is bounded", () => {
      const result = describeRetryableClose({
        method: "chat.subscribe",
        code: "SOME_CODE",
        reason: "a".repeat(10_000),
      });

      expect(result.fingerprint.length).toBeLessThan(400);
    });

    it("is equal for the same {method, code, reason} called twice", () => {
      const input = {
        method: "chat.subscribe",
        code: "SOME_CODE",
        reason: "ordinary reason",
      };

      expect(describeRetryableClose(input).fingerprint).toBe(
        describeRetryableClose({ ...input }).fingerprint,
      );
    });

    it("is the same for two reasons that differ only past the rendered budget", () => {
      const base = "a".repeat(300);
      const first = describeRetryableClose({
        method: "chat.subscribe",
        code: "SOME_CODE",
        reason: `${base}TAIL_ONE`,
      });
      const second = describeRetryableClose({
        method: "chat.subscribe",
        code: "SOME_CODE",
        reason: `${base}TAIL_TWO`,
      });

      // Both reasons render identically once truncated - the fingerprint is
      // derived from the same bounded, rendered pieces, so it is intended to
      // collide here.
      expect(first.line).toBe(second.line);
      expect(first.fingerprint).toBe(second.fingerprint);
    });

    it("differs for two closes that render differently", () => {
      const first = describeRetryableClose({
        method: "chat.subscribe",
        code: "SOME_CODE",
        reason: "first reason",
      });
      const second = describeRetryableClose({
        method: "chat.subscribe",
        code: "SOME_CODE",
        reason: "second reason",
      });

      expect(first.fingerprint).not.toBe(second.fingerprint);
    });
  });
});
