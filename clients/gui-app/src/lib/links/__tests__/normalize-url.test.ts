import { describe, expect, it } from "vitest";
import { hashOf, samePageKey } from "@/lib/links/normalize-url";

describe("samePageKey", () => {
  it.each([
    ["https://example.test/docs", "https://example.test/docs"],
    // A trailing slash and a fragment are not part of the page's identity.
    ["https://example.test/docs/", "https://example.test/docs"],
    ["https://example.test/docs#anchor", "https://example.test/docs"],
    ["https://example.test/", "https://example.test"],
    // The query IS: two searches are two pages.
    ["https://example.test/docs?q=1", "https://example.test/docs?q=1"],
    // Origin includes the scheme and port.
    ["http://example.test:8080/a", "http://example.test:8080/a"],
    ["https://EXAMPLE.test/Docs", "https://example.test/Docs"],
  ])("keys %s", (url, key) => {
    expect(samePageKey(url)).toBe(key);
  });

  it.each(["mailto:someone@example.test", "about:blank", "not a url"])(
    "refuses %s",
    (url) => {
      expect(samePageKey(url)).toBeNull();
    },
  );

  it("separates pages that differ anywhere but the hash", () => {
    expect(samePageKey("https://example.test/a")).not.toBe(
      samePageKey("https://example.test/b"),
    );
    expect(samePageKey("https://example.test/a?x=1")).not.toBe(
      samePageKey("https://example.test/a?x=2"),
    );
    expect(samePageKey("http://example.test/a")).not.toBe(
      samePageKey("https://example.test/a"),
    );
  });
});

describe("hashOf", () => {
  it.each([
    ["https://example.test/docs#anchor", "#anchor"],
    ["https://example.test/docs", ""],
    ["https://example.test/docs#", ""],
    ["mailto:someone@example.test", ""],
  ])("reads the fragment of %s", (url, hash) => {
    expect(hashOf(url)).toBe(hash);
  });
});
