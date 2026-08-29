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

  // Pinning the heuristic's known limit (see registrable-domain.ts's module
  // comment): with no public suffix list, a hosting suffix that looks like an
  // ordinary two-label domain collapses one level further than it should.
  // That is deliberate over-coalescing - a wasted capture window at worst,
  // never a correctness loss - so this test exists to notice if the heuristic
  // is ever changed to "fix" it without updating that comment too.
  it("over-coalesces a hosting suffix like github.io (documented heuristic limit)", () => {
    expect(registrableDomain("user.github.io")).toBe("github.io");
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
