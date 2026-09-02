import { describe, expect, it } from "vitest";
import {
  cookieDomainInScope,
  registrableDomain,
  registrableDomainForUrl,
} from "../registrable-domain";

describe("registrableDomain", () => {
  it("collapses a multi-label host to its registrable domain", () => {
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("a.b.c.d.example.org")).toBe("example.org");
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("keeps three labels under a ccTLD second level", () => {
    expect(registrableDomain("x.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("www.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
    // A registry's own second level is itself a registrable domain.
    expect(registrableDomain("foo.co.uk")).toBe("foo.co.uk");
  });

  it("answers single-label hosts and IP literals with themselves - the list has no answer and they have no registrable parent", () => {
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("intranet")).toBe("intranet");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("192.168.1.1")).toBe("192.168.1.1");
    expect(registrableDomain("[::1]")).toBe("::1");
    expect(registrableDomain("::1")).toBe("::1");
    // A bare public suffix is not a registrable domain either.
    expect(registrableDomain("github.io")).toBe("github.io");
  });

  it("strips the RFC 6265 leading dot and a trailing root dot before deriving", () => {
    expect(registrableDomain(".example.com")).toBe("example.com");
    expect(registrableDomain("example.com.")).toBe("example.com");
  });

  it("lowercases the host and leaves punycode alone", () => {
    expect(registrableDomain("EXAMPLE.COM")).toBe("example.com");
    expect(registrableDomain("xn--80ak6aa92e.com")).toBe("xn--80ak6aa92e.com");
  });

  it("returns null only for empty or whitespace-only input", () => {
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain("   ")).toBeNull();
    // A malformed host the list cannot place answers with itself, the same
    // narrowest-safe answer every unplaceable host gets.
    expect(registrableDomain("a..com")).toBe("a..com");
  });

  it("keeps a private-suffix tenant to itself - the clear-site blast radius", () => {
    // The public suffix list's private section is what makes these separate
    // sites: collapsing to `github.io` would put every GitHub Pages login in
    // one clear-site scope.
    expect(registrableDomain("app.github.io")).toBe("app.github.io");
    expect(registrableDomain("foo.github.io")).toBe("foo.github.io");
    expect(registrableDomain("page.user.github.io")).toBe("user.github.io");
    expect(registrableDomain("sub.localhost")).toBe("sub.localhost");
  });

  it("splits an unknown TLD at its last two labels", () => {
    expect(registrableDomain("a.b.example.unknowntld")).toBe(
      "example.unknowntld",
    );
  });

  // H11: the two ends of the wire have to derive one scope for an
  // international domain however it is spelled. `tldts` alone treats the two
  // spellings as different names, so a scope derived from the Unicode form
  // rejected every cookie the jar spelled in A-labels.
  it("collapses a Unicode IDN onto its punycode form", () => {
    expect(registrableDomain("m\u00fcnchen.de")).toBe("xn--mnchen-3ya.de");
    expect(registrableDomain("a.M\u00dcNCHEN.de")).toBe("xn--mnchen-3ya.de");
    expect(registrableDomain("xn--mnchen-3ya.de")).toBe("xn--mnchen-3ya.de");
    expect(registrableDomain(".m\u00fcnchen.de.")).toBe("xn--mnchen-3ya.de");
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

  it("matches across IDN spellings (H11)", () => {
    expect(cookieDomainInScope(".xn--mnchen-3ya.de", "m\u00fcnchen.de")).toBe(
      true,
    );
    expect(cookieDomainInScope("a.m\u00fcnchen.de", "xn--mnchen-3ya.de")).toBe(
      true,
    );
  });
});
