import { describe, expect, it } from "vitest";
import { sentryDsnFromEnv } from "../scripts/sentry-dsn";

const VALID = "https://abc123@o123.ingest.us.sentry.io/456789";

describe("sentryDsnFromEnv", () => {
  it("returns an empty string (reporting off) when the variable is unset or blank", () => {
    expect(sentryDsnFromEnv({})).toBe("");
    expect(sentryDsnFromEnv({ TRAYCER_MOBILE_SENTRY_DSN: "" })).toBe("");
    expect(sentryDsnFromEnv({ TRAYCER_MOBILE_SENTRY_DSN: "   " })).toBe("");
  });

  it("returns a well-formed DSN, trimmed", () => {
    expect(sentryDsnFromEnv({ TRAYCER_MOBILE_SENTRY_DSN: ` ${VALID}\n` })).toBe(
      VALID,
    );
  });

  it("rejects a value that is not a URL", () => {
    expect(() =>
      sentryDsnFromEnv({ TRAYCER_MOBILE_SENTRY_DSN: "not a dsn" }),
    ).toThrow(/not a URL/);
  });

  it("rejects a non-https DSN", () => {
    expect(() =>
      sentryDsnFromEnv({
        TRAYCER_MOBILE_SENTRY_DSN: "http://abc123@o123.ingest.sentry.io/456",
      }),
    ).toThrow(/https/);
  });

  it("rejects a DSN with no public key", () => {
    expect(() =>
      sentryDsnFromEnv({
        TRAYCER_MOBILE_SENTRY_DSN: "https://o123.ingest.sentry.io/456",
      }),
    ).toThrow(/public key/);
  });

  it("rejects a DSN with no project id, which Sentry would silently refuse to send to", () => {
    expect(() =>
      sentryDsnFromEnv({
        TRAYCER_MOBILE_SENTRY_DSN: "https://abc123@o123.ingest.sentry.io",
      }),
    ).toThrow(/project id/);
    expect(() =>
      sentryDsnFromEnv({
        TRAYCER_MOBILE_SENTRY_DSN: "https://abc123@o123.ingest.sentry.io/",
      }),
    ).toThrow(/project id/);
  });

  it("rejects a non-numeric project id", () => {
    expect(() =>
      sentryDsnFromEnv({
        TRAYCER_MOBILE_SENTRY_DSN:
          "https://abc123@o123.ingest.sentry.io/mobile",
      }),
    ).toThrow(/project id/);
  });
});
