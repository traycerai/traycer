/**
 * The QR payload contract: whatever the desktop encodes, the phone's parser
 * must recover in NORMALIZED form — and pasted prose, foreign QRs, and
 * malformed codes must all come back `null` rather than being sent to the
 * claim endpoint.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLinkLoginQrPayload,
  claimantDeviceLabel,
  linkLoginTokenViaHttp,
  normalizeLinkLoginCodeInput,
  parseLinkLoginInput,
} from "../link-login";

// Display form as the desktop mints it; Crockford, no I/L/O/U.
const CODE = "ABCDE-FGHJK";
const NORMALIZED = "ABCDEFGHJK";

describe("QR payload build/parse", () => {
  it("round-trips the v1 payload into the normalized code", () => {
    const payload = buildLinkLoginQrPayload(CODE);
    expect(payload).toBe(`traycer://link-login?code=${CODE}`);
    expect(parseLinkLoginInput(payload)).toBe(NORMALIZED);
  });

  it("accepts typed codes in any dash/case variation the normalization covers", () => {
    expect(parseLinkLoginInput(CODE)).toBe(NORMALIZED);
    expect(parseLinkLoginInput("abcde-fghjk")).toBe(NORMALIZED);
    expect(parseLinkLoginInput("  abcdefghjk\n")).toBe(NORMALIZED);
    // The Crockford visual folds: I/L -> 1, O -> 0.
    expect(parseLinkLoginInput("abcde-fghil")).toBe(
      normalizeLinkLoginCodeInput("ABCDEFGH11"),
    );
  });

  it("rejects text that carries no plausible code", () => {
    expect(parseLinkLoginInput("")).toBeNull();
    // NB: ten-letter prose CAN normalize into code shape ("hello world" →
    // HE110W0R1D via the visual folds) — that matches the device approval
    // page's typing contract, and the server uniform-rejects unknown codes.
    expect(parseLinkLoginInput("clearly not a code")).toBeNull();
    expect(parseLinkLoginInput("ABCDE-FGHJ")).toBeNull(); // 9 chars
    expect(parseLinkLoginInput("ABCDE-FGHJKM")).toBeNull(); // 11 chars
    expect(parseLinkLoginInput("ABCDE-FGHU!")).toBeNull(); // outside alphabet
  });

  it("rejects foreign URLs and near-miss payloads", () => {
    expect(parseLinkLoginInput(`https://evil.test/?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput(`other://link-login?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput(`traycer://elsewhere?code=${CODE}`)).toBeNull();
    expect(parseLinkLoginInput("traycer://link-login")).toBeNull();
    expect(parseLinkLoginInput("traycer://link-login?code=nope")).toBeNull();
  });
});

/**
 * The poll loop reads `retryAfterSeconds` to decide how long to sleep, and
 * `null` is what makes it fall back to the interval its claim advertised. A
 * numeric zero is not the same answer: it instructs an immediate retry, so a
 * 429 that carries no header at all must never parse into one.
 */
describe("token poll: 429 back-off directive", () => {
  const AUTHN_BASE_URL = "https://authn.example.test";
  const SECRET = "S".repeat(43);
  let originalFetch: typeof globalThis.fetch;

  function installFetch(headers: Record<string, string> | null): void {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "slow_down" }), {
        status: 429,
        headers: { "content-type": "application/json", ...(headers ?? {}) },
      });
    }) as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("honors a Retry-After the server did send", async () => {
    installFetch({ "Retry-After": "12" });
    expect(await linkLoginTokenViaHttp(AUTHN_BASE_URL, SECRET)).toEqual({
      kind: "slow-down",
      retryAfterSeconds: 12,
    });
  });

  it("reports NO directive when the header is absent", async () => {
    installFetch(null);
    expect(await linkLoginTokenViaHttp(AUTHN_BASE_URL, SECRET)).toEqual({
      kind: "slow-down",
      retryAfterSeconds: null,
    });
  });

  it("reports no directive for a header it cannot read as seconds", async () => {
    installFetch({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" });
    expect(await linkLoginTokenViaHttp(AUTHN_BASE_URL, SECRET)).toEqual({
      kind: "slow-down",
      retryAfterSeconds: null,
    });
  });
});

/**
 * The approve prompt reads "Approve sign-in from ___?", so the label owns its
 * own article. Every surface that renders the prompt calls this, which is the
 * point of it living here.
 */
describe("claimant device label", () => {
  it("gives a bare family its article", () => {
    // What iOS reports about itself, and the case that would otherwise fall
    // into the verbatim branch and read "from iPhone?".
    expect(claimantDeviceLabel("iPhone")).toBe("an iPhone");
    expect(claimantDeviceLabel("iPad")).toBe("an iPad");
  });

  it("renders a self-reported model name verbatim", () => {
    // Android names itself natively, and a claimant predating family-only
    // iOS reporting can still send a marketing name.
    expect(claimantDeviceLabel("Pixel 8")).toBe("Pixel 8");
    expect(claimantDeviceLabel("iPhone 16 Pro")).toBe("iPhone 16 Pro");
  });

  it("buckets a User-Agent to its family instead of printing it", () => {
    expect(
      claimantDeviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      ),
    ).toBe("an iPhone");
    expect(
      claimantDeviceLabel("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)"),
    ).toBe("an iPad");
    expect(claimantDeviceLabel("TraycerMobile/1.0 CFNetwork/1500 Darwin")).toBe(
      "a device",
    );
    expect(
      claimantDeviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 8)"),
    ).toBe("an Android device");
  });

  it("falls back to a device when there is nothing to say", () => {
    expect(claimantDeviceLabel(null)).toBe("a device");
    expect(claimantDeviceLabel("")).toBe("a device");
    // Long enough to be UA-shaped, with no family to bucket into.
    expect(claimantDeviceLabel("x".repeat(41))).toBe("a device");
  });
});
