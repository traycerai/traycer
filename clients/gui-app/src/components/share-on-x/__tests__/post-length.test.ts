import { describe, expect, it } from "vitest";
import {
  xPostIntentUrl,
  xPostLength,
} from "@/components/share-on-x/post-length";

describe("xPostLength", () => {
  it("counts plain text one per character", () => {
    expect(xPostLength("hello")).toBe(5);
  });

  it("counts a bare domain as a 23-character link", () => {
    expect(xPostLength("traycer.ai")).toBe(23);
  });

  it("counts a long http URL as a 23-character link", () => {
    expect(
      xPostLength("http://example.com/a/very/long/path/that/goes/on?q=1"),
    ).toBe(23);
  });

  it("adds the surrounding text to the link weight", () => {
    expect(xPostLength("try traycer.ai now")).toBe(4 + 23 + 4);
  });

  it("counts CJK characters as two", () => {
    expect(xPostLength("日本語")).toBe(6);
  });
});

describe("xPostIntentUrl", () => {
  it("encodes the text into the post intent", () => {
    const url = new URL(xPostIntentUrl("a&b #1 é"));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe("a&b #1 é");
  });
});
