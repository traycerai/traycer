import { describe, expect, it } from "vitest";
import { BROWSER_SESSIONS_UX_CLIENT_FRAME_KINDS } from "@traycer/protocol/host/browser/contracts";
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

/**
 * One well-formed frame per kind a renderer may send. Keyed by kind, so the
 * gate below is compared against the PROTOCOL's own list rather than a second
 * list written here that could quietly drift from it.
 */
const RENDERER_FRAMES: Record<string, Record<string, unknown>> = {
  openTab: {
    kind: "openTab",
    hasBinaryPayload: false,
    requestId: "request-1",
    sessionId: null,
    url: "https://example.com/",
  },
  closeTab: {
    kind: "closeTab",
    hasBinaryPayload: false,
    requestId: "request-1",
    sessionId: "session-1",
    tabId: "tab-1",
  },
  captureTabPreview: {
    kind: "captureTabPreview",
    hasBinaryPayload: false,
    requestId: "request-1",
    tabId: "tab-1",
  },
};

describe("a renderer may only ask for the three tab requests", () => {
  it("accepts exactly the kinds the protocol names as renderer-sendable", () => {
    // The gate IS the protocol's list: a kind added to the union without being
    // added there must stay refused, and one added there must be accepted here
    // without the gate being edited separately.
    expect([...BROWSER_SESSIONS_UX_CLIENT_FRAME_KINDS].toSorted()).toEqual(
      Object.keys(RENDERER_FRAMES).toSorted(),
    );
    for (const frame of Object.values(RENDERER_FRAMES)) {
      expect(parse(frame)).toBe(true);
    }
  });

  it("refuses the two destructive frames main mints behind its own dialog", () => {
    // They are not on the protocol's renderer-sendable list either, which is
    // what the gate reads - so neither door can be opened alone.
    expect(BROWSER_SESSIONS_UX_CLIENT_FRAME_KINDS).not.toContain(
      "forgetLogins",
    );
    expect(BROWSER_SESSIONS_UX_CLIENT_FRAME_KINDS).not.toContain("clearSite");
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

/**
 * WHAT a saved-login row may name.
 *
 * The value is interpolated into the body of the native confirmation the user
 * answers, and it is the blast radius of the clear that confirmation
 * authorises. A caller that could name anything else could write the sentence
 * the user is agreeing to, so anything that does not collapse to itself is
 * refused rather than narrowed - narrowing would clear a scope nobody named.
 */
describe("a saved-login site is a registrable domain", () => {
  function acceptsSite(domain: string): boolean {
    return browserViewIpcPayload.savedLoginSite.safeParse({ domain }).success;
  }

  it("accepts a plain registrable domain", () => {
    expect(acceptsSite("example.com")).toBe(true);
  });

  it("refuses a subdomain, which names a smaller scope than the clear takes", () => {
    expect(acceptsSite("mail.example.com")).toBe(false);
  });

  it("refuses a url", () => {
    expect(acceptsSite("https://example.com/login")).toBe(false);
  });

  it("refuses text shaped for the dialog rather than for a lookup", () => {
    expect(acceptsSite("example.com and every other site")).toBe(false);
    expect(acceptsSite("<b>example.com</b>")).toBe(false);
  });
});
