/**
 * The QR encodes a URL a stranger's camera will follow, carrying a live claim
 * code. Which deployment that URL names is therefore not a cosmetic detail:
 * naming the wrong one hands a local code to a different environment. These
 * pin every lane the product actually ships, including the LAN-IP one that a
 * hostname-rewriting derivation had no answer for.
 */
import { describe, expect, it } from "vitest";
import {
  billingPathFor,
  platformOriginFromSignInUrl,
  resolvePlatformBaseUrl,
  resolvePlatformBillingUrl,
} from "../platform-base-url";

describe("platformOriginFromSignInUrl", () => {
  it("pins every deployment lane to its own origin", () => {
    // Loopback dev (`make dev-desktop`).
    expect(platformOriginFromSignInUrl("http://localhost:21003/sign-in")).toBe(
      "http://localhost:21003",
    );
    // The physical-phone lane: a LAN IP with a non-default port, and the case
    // that used to fall through to production.
    expect(
      platformOriginFromSignInUrl("http://192.168.1.42:21003/sign-in"),
    ).toBe("http://192.168.1.42:21003");
    expect(platformOriginFromSignInUrl("https://dev.traycer.ai/sign-in")).toBe(
      "https://dev.traycer.ai",
    );
    expect(platformOriginFromSignInUrl("https://traycer.ai/sign-in")).toBe(
      "https://traycer.ai",
    );
  });

  it("keeps the sign-in route's own path and query out of the origin", () => {
    expect(
      platformOriginFromSignInUrl(
        "https://traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth%2Fcallback",
      ),
    ).toBe("https://traycer.ai");
  });

  it("answers null for a scheme with an OPAQUE origin", () => {
    // These parse fine and `URL.origin` gives back the literal string "null",
    // which reads as an address to anything that only checks for `null` the
    // value. A QR composed from it would carry a live code to nowhere.
    expect(platformOriginFromSignInUrl("file:///tmp/sign-in.html")).toBeNull();
    expect(platformOriginFromSignInUrl("data:text/html,<p>sign-in")).toBeNull();
    expect(platformOriginFromSignInUrl("traycer://sign-in")).toBeNull();
  });

  it("answers null rather than guessing a deployment", () => {
    // The whole point of the strict form: no origin is a usable answer,
    // because the caller can decline to draw a QR. A fallback here would put
    // a live code in front of a camera pointed at the wrong environment.
    expect(platformOriginFromSignInUrl("not a url")).toBeNull();
    expect(platformOriginFromSignInUrl("")).toBeNull();
  });
});

describe("resolvePlatformBaseUrl", () => {
  it("tracks the configured deployment like the strict form", () => {
    expect(resolvePlatformBaseUrl("http://192.168.1.42:21003/sign-in")).toBe(
      "http://192.168.1.42:21003",
    );
  });

  it("falls back to production only where nothing is carried", () => {
    // Navigation only. A person sent to the wrong dashboard sees where they
    // are and leaves; that is not the same class of mistake as sending data.
    expect(resolvePlatformBaseUrl("not a url")).toBe("https://traycer.ai");
  });
});

describe("billingPathFor", () => {
  const teams = [
    { teamId: "team-1", slug: "acme" },
    { teamId: "team-2", slug: "r&d team/west" },
    { teamId: "team-3", slug: "" },
  ];

  it("opens the personal Billing page for the personal context", () => {
    expect(billingPathFor({ type: "PERSONAL" }, teams)).toBe("/billing");
  });

  it("opens the selected team's Billing page by its slug", () => {
    expect(billingPathFor({ type: "TEAM", teamId: "team-1" }, teams)).toBe(
      "/team/acme/billing",
    );
  });

  it("encodes a slug that is not URL-safe as one path segment", () => {
    expect(billingPathFor({ type: "TEAM", teamId: "team-2" }, teams)).toBe(
      "/team/r%26d%20team%2Fwest/billing",
    );
  });

  it("falls back to the personal page for a team the user no longer has", () => {
    // A persisted team id outlives leaving the team; the store's own
    // resolution treats it as personal, and so does the link.
    expect(billingPathFor({ type: "TEAM", teamId: "gone" }, teams)).toBe(
      "/billing",
    );
    expect(billingPathFor({ type: "TEAM", teamId: "team-1" }, [])).toBe(
      "/billing",
    );
  });

  it("never composes an empty team segment", () => {
    expect(billingPathFor({ type: "TEAM", teamId: "team-3" }, teams)).toBe(
      "/billing",
    );
  });
});

describe("resolvePlatformBillingUrl", () => {
  it("joins the configured origin to the Billing path, dropping the sign-in route", () => {
    expect(
      resolvePlatformBillingUrl(
        "http://192.168.1.42:21003/sign-in?redirect_uri=x",
        { type: "TEAM", teamId: "team-1" },
        [{ teamId: "team-1", slug: "acme" }],
      ),
    ).toBe("http://192.168.1.42:21003/team/acme/billing");
    expect(
      resolvePlatformBillingUrl(
        "http://localhost:21003/sign-in",
        { type: "PERSONAL" },
        [],
      ),
    ).toBe("http://localhost:21003/billing");
  });
});
