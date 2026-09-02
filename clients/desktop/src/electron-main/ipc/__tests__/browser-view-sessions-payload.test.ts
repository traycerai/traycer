import { describe, expect, it } from "vitest";
import { browserViewIpcPayload } from "../browser-view-ipc-payload";

/**
 * WHICH client frames a renderer may put on the jar plane's stream (H10).
 *
 * The parse is the protocol's own client-frame schema, so it is not the gate;
 * the narrowing behind it is. `forgetLogins` and `clearSite` shred every
 * connected host's slice of the user's logins and are produced in main behind
 * its own confirmation, and the rest of the union is main's half of the
 * handshake - a renderer that could mint `primaryProfileCaptured` or
 * `storeKeyUnwrapped` would be speaking for the jar it no longer holds.
 */

const KEY = {
  epicId: "epic-1",
  hostId: "host-1",
  identityKey: "identity-1",
};

function parse(frame: Record<string, unknown>): boolean {
  return browserViewIpcPayload.sessionsStreamSend.safeParse({
    key: KEY,
    frame,
  }).success;
}

describe("a renderer may only ask for the three tab requests", () => {
  it("accepts openTab, closeTab and captureTabPreview", () => {
    expect(
      parse({
        kind: "openTab",
        hasBinaryPayload: false,
        requestId: "request-1",
        sessionId: null,
        url: "https://example.com/",
      }),
    ).toBe(true);
    expect(
      parse({
        kind: "closeTab",
        hasBinaryPayload: false,
        requestId: "request-1",
        sessionId: "session-1",
        tabId: "tab-1",
      }),
    ).toBe(true);
    expect(
      parse({
        kind: "captureTabPreview",
        hasBinaryPayload: false,
        requestId: "request-1",
        tabId: "tab-1",
      }),
    ).toBe(true);
  });

  it("refuses the two destructive frames main mints behind its own dialog", () => {
    expect(parse({ kind: "forgetLogins", hasBinaryPayload: false })).toBe(
      false,
    );
    expect(
      parse({
        kind: "clearSite",
        hasBinaryPayload: false,
        domain: "example.com",
      }),
    ).toBe(false);
  });

  it("refuses main's own half of the jar handshake", () => {
    expect(
      parse({
        kind: "primaryProfileCaptured",
        hasBinaryPayload: false,
        requestId: "request-1",
        storageState: { cookies: [], origins: [] },
        status: "captured",
        reason: null,
      }),
    ).toBe(false);
    expect(
      parse({
        kind: "storeKeyUnwrapped",
        hasBinaryPayload: false,
        requestId: "request-1",
        rawKey: "cmF3",
      }),
    ).toBe(false);
  });

  it("refuses a frame that is not a client frame at all", () => {
    expect(parse({ kind: "openTab", hasBinaryPayload: false })).toBe(false);
  });
});
