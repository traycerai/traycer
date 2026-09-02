import { describe, expect, it } from "vitest";
import { registrableDomain } from "@traycer/protocol/host/browser/registrable-domain";
import { toCookieSetDetails } from "../../browser-storage-state";
import { isGoogleDeviceBoundDomain } from "../google-exclusion";
import { classifyImportCookie, normalizeImportCookie } from "../normalize";
import type { ImportCookieRow } from "../cookie-rows";

/**
 * `nowSeconds` fixed rather than `Date.now()`-derived, so an expiry pinned a
 * minute in the past or future never drifts into a flake based on when the
 * suite happens to run.
 */
const NOW_SECONDS = 1_800_000_000;

function row(overrides: Partial<ImportCookieRow>): ImportCookieRow {
  return {
    domain: "example.com",
    name: "sid",
    path: "/",
    expires: -1,
    secure: true,
    httpOnly: false,
    sameSite: "Lax",
    partitioned: false,
    secret: { kind: "plain", value: "v" },
    ...overrides,
  };
}

describe("classifyImportCookie: __Host- prefix", () => {
  it("keeps a __Host- cookie that is secure, path /, and host-only", () => {
    const scope = classifyImportCookie(
      row({ name: "__Host-session", secure: true, path: "/" }),
      NOW_SECONDS,
    );
    expect(scope).not.toBeNull();
  });

  it("drops a __Host- cookie that is not secure", () => {
    const scope = classifyImportCookie(
      row({ name: "__Host-session", secure: false, path: "/" }),
      NOW_SECONDS,
    );
    expect(scope).toBeNull();
  });

  it("drops a __Host- cookie whose path is not /", () => {
    const scope = classifyImportCookie(
      row({ name: "__Host-session", secure: true, path: "/app" }),
      NOW_SECONDS,
    );
    expect(scope).toBeNull();
  });

  it("drops a __Host- cookie with a leading-dot (non-host-only) domain", () => {
    const scope = classifyImportCookie(
      row({
        name: "__Host-session",
        secure: true,
        path: "/",
        domain: ".example.com",
      }),
      NOW_SECONDS,
    );
    expect(scope).toBeNull();
  });
});

describe("classifyImportCookie: __Secure- prefix", () => {
  it("keeps a __Secure- cookie that is secure", () => {
    const scope = classifyImportCookie(
      row({ name: "__Secure-token", secure: true }),
      NOW_SECONDS,
    );
    expect(scope).not.toBeNull();
  });

  it("drops a __Secure- cookie that is not secure", () => {
    const scope = classifyImportCookie(
      row({ name: "__Secure-token", secure: false }),
      NOW_SECONDS,
    );
    expect(scope).toBeNull();
  });
});

describe("normalizeImportCookie: SameSite=None forces secure", () => {
  it("sets secure=true on the normalized cookie even if the row said secure=false", () => {
    const normalized = normalizeImportCookie(
      row({ name: "cross-site", sameSite: "None", secure: false }),
      "value",
      NOW_SECONDS,
    );
    expect(normalized?.cookie.secure).toBe(true);
    expect(normalized?.cookie.sameSite).toBe("None");
  });

  it("leaves secure alone for Lax/Strict", () => {
    const lax = normalizeImportCookie(
      row({ name: "lax-cookie", sameSite: "Lax", secure: false }),
      "value",
      NOW_SECONDS,
    );
    expect(lax?.cookie.secure).toBe(false);
  });
});

describe("classifyImportCookie: expiry", () => {
  it("drops an expired cookie", () => {
    const scope = classifyImportCookie(
      row({ expires: NOW_SECONDS - 60 }),
      NOW_SECONDS,
    );
    expect(scope).toBeNull();
  });

  it("drops a cookie that expires exactly now", () => {
    const scope = classifyImportCookie(
      row({ expires: NOW_SECONDS }),
      NOW_SECONDS,
    );
    expect(scope).toBeNull();
  });

  it("keeps a session cookie (expires -1) regardless of now", () => {
    const scope = classifyImportCookie(row({ expires: -1 }), NOW_SECONDS);
    expect(scope).not.toBeNull();
  });

  it("keeps a cookie that expires in the future", () => {
    const scope = classifyImportCookie(
      row({ expires: NOW_SECONDS + 60 }),
      NOW_SECONDS,
    );
    expect(scope).not.toBeNull();
  });
});

describe("classifyImportCookie: name", () => {
  it("drops a cookie with an empty name", () => {
    const scope = classifyImportCookie(row({ name: "" }), NOW_SECONDS);
    expect(scope).toBeNull();
  });
});

describe("classifyImportCookie: per-row IDN normalisation", () => {
  it("stores an IDN domain in the form the jar keys it by, without touching a sibling row", () => {
    const idnScope = classifyImportCookie(
      row({ name: "a", domain: "bücher.com" }),
      NOW_SECONDS,
    );
    const siblingScope = classifyImportCookie(
      row({ name: "b", domain: "example.com" }),
      NOW_SECONDS,
    );

    // The wire spelling is kept for the cookie itself; the canonical half is
    // what `readCookieDomain` hands every other jar path, IDNA-encoded exactly
    // as Chromium's jar does, so a later capture and a clear agree on the key.
    expect(idnScope).not.toBeNull();
    expect(idnScope?.domain).toBe("bücher.com");
    expect(idnScope?.canonicalDomain).toBe("xn--bcher-kva.com");
    expect(idnScope?.site).toBe("xn--bcher-kva.com");
    expect(siblingScope?.site).toBe("example.com");
  });
});

function registrableDomainOf(host: string): string {
  const domain = registrableDomain(host);
  if (domain === null) throw new Error(`no registrable domain for ${host}`);
  return domain;
}

describe("google-exclusion: isGoogleDeviceBoundDomain", () => {
  it("excludes google.com and other google TLDs/SLDs by registrable domain", () => {
    expect(isGoogleDeviceBoundDomain(registrableDomainOf("google.com"))).toBe(
      true,
    );
    expect(isGoogleDeviceBoundDomain(registrableDomainOf("google.co.uk"))).toBe(
      true,
    );
    expect(
      isGoogleDeviceBoundDomain(registrableDomainOf("accounts.google.com")),
    ).toBe(true);
  });

  it("excludes the Google service domains", () => {
    for (const host of [
      "googleapis.com",
      "gstatic.com",
      "youtube.com",
      "googleusercontent.com",
    ]) {
      expect(isGoogleDeviceBoundDomain(registrableDomainOf(host))).toBe(true);
    }
  });

  it("does not exclude an unrelated domain", () => {
    expect(isGoogleDeviceBoundDomain(registrableDomainOf("example.com"))).toBe(
      false,
    );
  });
});

describe("registrableDomain: github.io tenant isolation", () => {
  it("keeps two different *.github.io subdomains as distinct registrable domains", () => {
    const tenantA = registrableDomainOf("alice.github.io");
    const tenantB = registrableDomainOf("bob.github.io");

    expect(tenantA).toBe("alice.github.io");
    expect(tenantB).toBe("bob.github.io");
    expect(tenantA).not.toBe(tenantB);
  });

  it("classifies two github.io cookies under their own site, not a shared one", () => {
    const aliceScope = classifyImportCookie(
      row({ name: "a", domain: "alice.github.io" }),
      NOW_SECONDS,
    );
    const bobScope = classifyImportCookie(
      row({ name: "b", domain: "bob.github.io" }),
      NOW_SECONDS,
    );

    expect(aliceScope?.site).toBe("alice.github.io");
    expect(bobScope?.site).toBe("bob.github.io");
  });
});

describe("normalizeImportCookie -> toCookieSetDetails round trip", () => {
  it("round-trips a plain cookie without throwing", () => {
    const normalized = normalizeImportCookie(
      row({ name: "sid", domain: ".example.com", path: "/" }),
      "value",
      NOW_SECONDS,
    );
    expect(normalized).not.toBeNull();
    if (normalized === null) return;

    const details = toCookieSetDetails(normalized.cookie);
    expect(details.domain).toBe(".example.com");
    expect(details.url).toBe("https://example.com/");
  });

  it("round-trips a __Host- cookie (host-only, secure, path /) without throwing", () => {
    const normalized = normalizeImportCookie(
      row({
        name: "__Host-session",
        domain: "example.com",
        path: "/",
        secure: true,
      }),
      "value",
      NOW_SECONDS,
    );
    expect(normalized).not.toBeNull();
    if (normalized === null) return;

    expect(() => toCookieSetDetails(normalized.cookie)).not.toThrow();
    expect(toCookieSetDetails(normalized.cookie).domain).toBeNull();
  });

  it("round-trips a SameSite=None cookie forced secure", () => {
    const normalized = normalizeImportCookie(
      row({
        name: "cross-site",
        domain: "example.com",
        sameSite: "None",
        secure: false,
      }),
      "value",
      NOW_SECONDS,
    );
    expect(normalized).not.toBeNull();
    if (normalized === null) return;

    const details = toCookieSetDetails(normalized.cookie);
    expect(details.sameSite).toBe("no_restriction");
    expect(details.url.startsWith("https://")).toBe(true);
  });
});
