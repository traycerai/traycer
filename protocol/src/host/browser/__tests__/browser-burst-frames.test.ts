import { describe, expect, it } from "vitest";
import {
  browserScreencastOpenRequestSchema,
  browserScreencastV1,
  browserSessionsServerFrameSchema,
  browserSessionsV1,
} from "@traycer/protocol/host/browser/contracts";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";

const BURST_STARTED = {
  kind: "burstStarted",
  hasBinaryPayload: false,
  sessionId: "session-1",
  tabId: "tab-1",
  burstId: "burst-1",
  chatId: "chat-1",
} as const;

const BURST_ENDED = {
  kind: "burstEnded",
  hasBinaryPayload: false,
  sessionId: "session-1",
  tabId: "tab-1",
  burstId: "burst-1",
  outcome: "finished",
} as const;

const CAPTION = {
  kind: "caption",
  hasBinaryPayload: false,
  sessionId: "session-1",
  tabId: "tab-1",
  burstId: "burst-1",
  cellTitle: "Filling checkout form",
} as const;

describe("browser.sessions@1.0 burst and caption frames", () => {
  it("parses burstStarted, burstEnded, and caption on the 1.0 schema", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse(BURST_STARTED).success,
    ).toBe(true);
    expect(
      browserSessionsV1.serverFrameSchema.safeParse(BURST_STARTED).success,
    ).toBe(true);
    expect(
      browserSessionsServerFrameSchema.safeParse(BURST_ENDED).success,
    ).toBe(true);
    expect(browserSessionsServerFrameSchema.safeParse(CAPTION).success).toBe(
      true,
    );
  });

  it("accepts every burstEnded outcome", () => {
    for (const outcome of [
      "finished",
      "closed",
      "crashed",
      "suspended",
    ] as const) {
      expect(
        browserSessionsServerFrameSchema.safeParse({
          ...BURST_ENDED,
          outcome,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects an unknown burstEnded outcome", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...BURST_ENDED,
        outcome: "idle",
      }).success,
    ).toBe(false);
  });

  it("advertises 1.0 as the sessions and screencast latest minors", () => {
    const sessions = hostStreamRpcRegistry["browser.sessions"][1];
    const screencast = hostStreamRpcRegistry["browser.screencast"][1];
    expect(sessions.latestMinor).toBe(0);
    expect(sessions.versions[0]?.contract).toBe(browserSessionsV1);
    expect(screencast.latestMinor).toBe(0);
    expect(screencast.versions[0]?.contract).toBe(browserScreencastV1);
  });
});

describe("browser.screencast@1.0 viewer role", () => {
  const baseOpen = {
    epicId: "epic-1",
    sessionId: "session-1",
    tabId: "tab-1",
    maxWidth: 1280,
    maxHeight: 720,
    quality: 80,
    format: "jpeg" as const,
  };

  it("requires the caller to name its viewer role", () => {
    expect(browserScreencastOpenRequestSchema.safeParse(baseOpen).success).toBe(
      false,
    );
  });

  it("accepts an explicit pip role", () => {
    const parsed = browserScreencastOpenRequestSchema.parse({
      ...baseOpen,
      role: "pip",
    });
    expect(parsed.role).toBe("pip");
  });

  it("rejects an unknown role", () => {
    expect(
      browserScreencastOpenRequestSchema.safeParse({
        ...baseOpen,
        role: "overlay",
      }).success,
    ).toBe(false);
  });
});
