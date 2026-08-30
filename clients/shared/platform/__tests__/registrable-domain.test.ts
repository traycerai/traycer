import { describe, expect, it } from "vitest";
import {
  cookieDomainInScope,
  registrableDomain,
  registrableDomainForUrl,
} from "../registrable-domain";

describe("registrableDomain", () => {
  it("collapses a multi-label host to its registrable domain", () => {
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("keeps three labels under a two-letter ccTLD's generic second level", () => {
    expect(registrableDomain("www.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
  });

  it("answers single-label hosts and IP literals with themselves - they have no registrable parent", () => {
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("[::1]")).toBe("::1");
    expect(registrableDomain("::1")).toBe("::1");
  });

  it("strips the RFC 6265 leading dot and a trailing root dot before deriving", () => {
    expect(registrableDomain(".example.com")).toBe("example.com");
    expect(registrableDomain("example.com.")).toBe("example.com");
  });

  it("lowercases the host", () => {
    expect(registrableDomain("EXAMPLE.COM")).toBe("example.com");
  });

  it("returns null for empty or whitespace-only input, and for an empty label", () => {
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain("   ")).toBeNull();
    // The leading-dot strip only removes one dot, so a genuinely empty label
    // (a stray second dot) survives to the label check and is rejected.
    expect(registrableDomain("..a.com")).toBeNull();
  });

  it("keeps a private-suffix tenant to itself - the clear-site blast radius", () => {
    // The public suffix list's private section is what makes these separate
    // sites: collapsing to `github.io` would put every GitHub Pages login in
    // one clear-site scope.
    expect(registrableDomain("app.github.io")).toBe("app.github.io");
    expect(registrableDomain("user.github.io")).toBe("user.github.io");
    expect(registrableDomain("page.user.github.io")).toBe("user.github.io");
  });

  it("keeps a registry's own second level whole", () => {
    expect(registrableDomain("foo.co.uk")).toBe("foo.co.uk");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
  });

  // The list has no entry for an invented TLD, so the fallback heuristic is
  // what answers - two labels, as it always did.
  it("falls back to the heuristic for a host the list cannot place", () => {
    expect(registrableDomain("a.b.example.invalidtld")).toBe(
      "example.invalidtld",
    );
  });
});

describe("registrableDomainForUrl", () => {
  it("derives the registrable domain of a URL's host", () => {
    expect(registrableDomainForUrl("https://a.example.com/path?q=1")).toBe(
      "example.com",
    );
  });

  it("returns null for a string that is not a URL", () => {
    expect(registrableDomainForUrl("not a url")).toBeNull();
  });
});

describe("cookieDomainInScope", () => {
  it("matches a domain-cookie form of the scope itself", () => {
    expect(cookieDomainInScope(".example.com", "example.com")).toBe(true);
  });

  it("matches a subdomain of the scope", () => {
    expect(cookieDomainInScope("a.example.com", "example.com")).toBe(true);
  });

  it("matches the scope host exactly", () => {
    expect(cookieDomainInScope("example.com", "example.com")).toBe(true);
  });

  it("rejects a host that merely shares a suffix with the scope", () => {
    expect(cookieDomainInScope("notexample.com", "example.com")).toBe(false);
  });

  it("rejects the scope's own parent (in-scope is one-directional)", () => {
    expect(cookieDomainInScope("example.com", "a.example.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(cookieDomainInScope(".EXAMPLE.com", "Example.COM")).toBe(true);
  });
});
