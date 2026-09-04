import { describe, expect, it } from "vitest";
import {
  hashOf,
  isSecurityUpgrade,
  samePageKey,
} from "@/lib/links/normalize-url";

describe("samePageKey", () => {
  it.each([
    ["https://example.test/docs", "example.test/docs"],
    // A trailing slash and a fragment are not part of the page's identity.
    ["https://example.test/docs/", "example.test/docs"],
    ["https://example.test/docs#anchor", "example.test/docs"],
    ["https://example.test/", "example.test"],
    // The query IS: two searches are two pages.
    ["https://example.test/docs?q=1", "example.test/docs?q=1"],
    // The port is part of the host; the scheme is not.
    ["http://example.test:8080/a", "example.test:8080/a"],
    ["https://EXAMPLE.test/Docs", "example.test/Docs"],
  ])("keys %s", (url, key) => {
    expect(samePageKey(url)).toBe(key);
  });

  it.each(["mailto:someone@example.test", "about:blank", "not a url"])(
    "refuses %s",
    (url) => {
      expect(samePageKey(url)).toBeNull();
    },
  );

  it("keys http and https to the same page - a link survives an https upgrade", () => {
    expect(samePageKey("http://github.com/")).toBe(
      samePageKey("https://github.com/"),
    );
  });

  it("keeps credentials in the key - two users are two pages", () => {
    // `URL.origin` drops the user-info, so keying on it alone would hand
    // alice's tab to bob.
    expect(samePageKey("https://alice@example.test/docs")).not.toBe(
      samePageKey("https://bob@example.test/docs"),
    );
    expect(samePageKey("https://alice@example.test/docs")).not.toBe(
      samePageKey("https://example.test/docs"),
    );
    expect(samePageKey("https://alice:pw@example.test/docs")).toBe(
      "alice:pw@example.test/docs",
    );
  });

  it("separates pages that differ anywhere but the hash and scheme", () => {
    expect(samePageKey("https://example.test/a")).not.toBe(
      samePageKey("https://example.test/b"),
    );
    expect(samePageKey("https://example.test/a?x=1")).not.toBe(
      samePageKey("https://example.test/a?x=2"),
    );
    expect(samePageKey("https://a.example.test/x")).not.toBe(
      samePageKey("https://b.example.test/x"),
    );
  });
});

describe("isSecurityUpgrade", () => {
  it("is the http tab -> https request of the same page", () => {
    expect(isSecurityUpgrade("http://ex.test/a", "https://ex.test/a")).toBe(
      true,
    );
    // Ignores the fragment and a trailing slash, like samePageKey.
    expect(isSecurityUpgrade("http://ex.test/a/", "https://ex.test/a#x")).toBe(
      true,
    );
  });

  it("is NOT the reverse - an http link never downgrades an https tab", () => {
    expect(isSecurityUpgrade("https://ex.test/a", "http://ex.test/a")).toBe(
      false,
    );
  });

  it("is false for same-scheme, a different page, or a non-http url", () => {
    expect(isSecurityUpgrade("https://ex.test/a", "https://ex.test/a")).toBe(
      false,
    );
    expect(isSecurityUpgrade("http://ex.test/a", "https://ex.test/b")).toBe(
      false,
    );
    expect(isSecurityUpgrade("http://ex.test/a", "mailto:x@ex.test")).toBe(
      false,
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
