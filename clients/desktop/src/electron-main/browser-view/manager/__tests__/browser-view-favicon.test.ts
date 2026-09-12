import { describe, expect, it } from "vitest";
import { firstWebFaviconUrl } from "../browser-view-entry-factory";

describe("firstWebFaviconUrl", () => {
  it("takes the first icon a page declared", () => {
    expect(
      firstWebFaviconUrl([
        "https://example.com/a.png",
        "https://example.com/b.png",
      ]),
    ).toBe("https://example.com/a.png");
  });

  it("accepts plain http as well as https", () => {
    expect(firstWebFaviconUrl(["http://localhost:5173/favicon.ico"])).toBe(
      "http://localhost:5173/favicon.ico",
    );
  });

  it("refuses a scheme that has no business reaching an app image element", () => {
    // A page controls this list, so the scheme is checked rather than assumed.
    expect(
      firstWebFaviconUrl([
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "file:///etc/passwd",
      ]),
    ).toBeNull();
  });

  it("skips a refused entry and takes a later usable one", () => {
    expect(
      firstWebFaviconUrl(["data:image/png;base64,AA", "https://example.com/c.svg"]),
    ).toBe("https://example.com/c.svg");
  });

  it("refuses an unparseable URL rather than passing it on", () => {
    expect(firstWebFaviconUrl(["not a url", "://nope"])).toBeNull();
  });

  it("keeps a pathological URL out of the status frame", () => {
    const huge = `https://example.com/${"a".repeat(4_000)}.png`;
    expect(firstWebFaviconUrl([huge])).toBeNull();
  });

  it("answers null for a page that declared nothing", () => {
    expect(firstWebFaviconUrl([])).toBeNull();
  });
});
