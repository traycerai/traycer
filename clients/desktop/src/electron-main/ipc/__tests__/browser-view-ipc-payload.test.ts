import { describe, expect, it } from "vitest";
import {
  browserViewIpcPayload,
  parseReservedChords,
} from "../browser-view-ipc-payload";

/**
 * The guest-focused input policy arrives from the renderer, which may be newer
 * than this build. One unrecognized row must cost that row and nothing else -
 * dropping the array would leave every reserved chord unclaimed, so Cmd+W
 * would silently go back to closing the app's task tab.
 */
describe("parseReservedChords", () => {
  it("keeps the rows it understands when one is from a newer renderer", () => {
    const parsed = parseReservedChords({
      chords: [
        { token: "mod+w", command: "closeTab" },
        { token: "mod+f12", command: "teleport" },
        { token: "mod+k", command: null },
      ],
    });
    expect(parsed).toEqual([
      { token: "mod+w", command: "closeTab" },
      { token: "mod+k", command: null },
    ]);
  });

  it("yields an empty policy for a payload that is not a chord list", () => {
    expect(parseReservedChords({ chords: "mod+w" })).toEqual([]);
    expect(parseReservedChords(null)).toEqual([]);
  });
});

/**
 * `includeDeviceBound` is required, not optional: a renderer built against an
 * older protocol that omits it must be treated as malformed - the run handler
 * answers a blocked result rather than silently defaulting the opt-in either
 * way.
 */
describe("browserViewIpcPayload.loginImportRun", () => {
  it("accepts a well-formed request with includeDeviceBound present", () => {
    const parsed = browserViewIpcPayload.loginImportRun.safeParse({
      sourceId: "opaque-id-1",
      scanId: "scan-1",
      domains: ["example.com"],
      includeDeviceBound: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a payload missing includeDeviceBound", () => {
    const parsed = browserViewIpcPayload.loginImportRun.safeParse({
      sourceId: "opaque-id-1",
      scanId: "scan-1",
      domains: ["example.com"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects includeDeviceBound of the wrong type", () => {
    const parsed = browserViewIpcPayload.loginImportRun.safeParse({
      sourceId: "opaque-id-1",
      scanId: "scan-1",
      domains: ["example.com"],
      includeDeviceBound: "true",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown extra key", () => {
    const parsed = browserViewIpcPayload.loginImportRun.safeParse({
      sourceId: "opaque-id-1",
      scanId: "scan-1",
      domains: ["example.com"],
      includeDeviceBound: true,
      extra: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a sourceId longer than 128 characters", () => {
    const parsed = browserViewIpcPayload.loginImportRun.safeParse({
      sourceId: "x".repeat(129),
      scanId: "scan-1",
      domains: ["example.com"],
      includeDeviceBound: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a domain entry longer than 253 characters", () => {
    const parsed = browserViewIpcPayload.loginImportRun.safeParse({
      sourceId: "opaque-id-1",
      scanId: "scan-1",
      domains: ["a".repeat(254)],
      includeDeviceBound: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a payload missing scanId", () => {
    const parsed = browserViewIpcPayload.loginImportRun.safeParse({
      sourceId: "opaque-id-1",
      domains: ["example.com"],
      includeDeviceBound: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a scanId longer than 128 characters", () => {
    const parsed = browserViewIpcPayload.loginImportRun.safeParse({
      sourceId: "opaque-id-1",
      scanId: "x".repeat(129),
      domains: ["example.com"],
      includeDeviceBound: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("browserViewIpcPayload.loginImportScan", () => {
  it("accepts a well-formed request", () => {
    const parsed = browserViewIpcPayload.loginImportScan.safeParse({
      sourceId: "opaque-id-1",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown extra key", () => {
    const parsed = browserViewIpcPayload.loginImportScan.safeParse({
      sourceId: "opaque-id-1",
      extra: true,
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The helper URL is a CREDENTIAL and an ORIGIN, and main opens it in a window
 * that runs in the guest's own session and holds a display-capture grant over
 * that guest. Only the host's own loopback listener may ever be it.
 */
describe("browserViewIpcPayload.recordingStart", () => {
  const tab = {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
    recordingId: "recording-1",
  };

  it("accepts the loopback helper URL the host mints", () => {
    expect(
      browserViewIpcPayload.recordingStart.safeParse({
        ...tab,
        helperUrl:
          "http://127.0.0.1:54321/recording/recording-1/helper?mode=record&token=t",
      }).success,
    ).toBe(true);
    expect(
      browserViewIpcPayload.recordingStart.safeParse({
        ...tab,
        helperUrl: "http://localhost:54321/recording/recording-1/helper",
      }).success,
    ).toBe(true);
  });

  it("refuses any origin that is not this machine's loopback listener", () => {
    for (const helperUrl of [
      "https://example.test/recording/recording-1/helper",
      "http://10.0.0.5:54321/recording/recording-1/helper",
      "http://127.0.0.1.evil.test/recording/recording-1/helper",
      "file:///tmp/helper.html",
      "/recording/recording-1/helper",
    ]) {
      expect(
        browserViewIpcPayload.recordingStart.safeParse({ ...tab, helperUrl })
          .success,
      ).toBe(false);
    }
  });
});
