import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  browserSessionsClientFrameSchema,
  browserSessionsOpenRequestSchema,
  browserSessionsServerFrameSchema,
  browserScreencastClientFrameSchema,
  browserScreencastOpenRequestSchema,
  browserScreencastServerFrameSchema,
  browserScreencastV1,
} from "@traycer/protocol/host/browser/contracts";

const SAMPLE_SESSION = {
  sessionId: "session-1",
  epicId: "epic-1",
  hostId: "host-1",
  profile: "primary" as const,
  lastActivityAt: 20,
  runtime: { kind: "headless" as const, revision: 0 },
  tabs: [
    {
      tabId: "session-1",
      url: "http://localhost:3000",
      originTier: "dev" as const,
      status: "ready" as const,
      title: "App",
      viewed: false,
      drivenBy: [],
    },
  ],
};

function parsesSession(session: unknown): boolean {
  return browserSessionsServerFrameSchema.safeParse({
    kind: "snapshot",
    hasBinaryPayload: false,
    sessions: [session],
  }).success;
}

/**
 * Structural view of one union variant. `.strict()` records itself as a
 * `ZodNever` catchall; a lenient variant leaves the catchall unset and would
 * silently drop fields a newer peer added.
 */
interface FrameVariantIntrospection {
  readonly def: {
    readonly catchall?: object | undefined;
    readonly shape: Record<string, unknown>;
  };
}

function expectEveryVariantStrict(
  label: string,
  options: readonly FrameVariantIntrospection[],
): void {
  expect(options.length, `${label} has no variants`).toBeGreaterThan(0);
  for (const [index, option] of options.entries()) {
    expect(
      option.def.catchall instanceof z.ZodNever,
      `${label}[${index}] {${Object.keys(option.def.shape).join(", ")}} must be .strict()`,
    ).toBe(true);
  }
}

describe("browser frame unions reject unknown fields", () => {
  it("keeps every frame variant strict so a newer peer's field is never dropped", () => {
    expectEveryVariantStrict(
      "browserSessionsServerFrameSchema",
      browserSessionsServerFrameSchema.def.options,
    );
    expectEveryVariantStrict(
      "browserSessionsClientFrameSchema",
      browserSessionsClientFrameSchema.def.options,
    );
    expectEveryVariantStrict(
      "browserScreencastServerFrameSchema",
      browserScreencastServerFrameSchema.def.options,
    );
    expectEveryVariantStrict(
      "browserScreencastClientFrameSchema",
      browserScreencastClientFrameSchema.def.options,
    );
  });

  it("rejects an unknown field on a previously lenient variant", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "burstStarted",
        hasBinaryPayload: false,
        sessionId: "session-1",
        tabId: "tab-1",
        burstId: "burst-1",
        chatId: "chat-1",
        futureField: "from a newer peer",
      }).success,
    ).toBe(false);
    expect(
      browserScreencastClientFrameSchema.safeParse({
        kind: "ack",
        hasBinaryPayload: false,
        sequence: 3,
        futureField: "from a newer peer",
      }).success,
    ).toBe(false);
  });
});

describe("browser.screencast@1.0 control frames", () => {
  it("carries arming and subscription-bound input on the unreleased baseline", () => {
    const clientFrames = [
      { kind: "arm", hasBinaryPayload: false, armEpoch: 3 },
      { kind: "disarm", hasBinaryPayload: false, armEpoch: 3 },
      {
        kind: "pointer",
        hasBinaryPayload: false,
        armEpoch: 3,
        seq: 0,
        type: "down",
        castSequence: 7,
        normalizedX: 0.25,
        normalizedY: 0.75,
        button: "left",
        buttons: 1,
        modifiers: 2,
        clickCount: 1,
        deltaX: 0,
        deltaY: 0,
      },
      {
        kind: "keyboard",
        hasBinaryPayload: false,
        armEpoch: 3,
        seq: 1,
        type: "rawKeyDown",
        code: "KeyA",
        key: "a",
        modifiers: 0,
        autoRepeat: false,
      },
      {
        kind: "insertText",
        hasBinaryPayload: false,
        armEpoch: 3,
        seq: 2,
        text: "hello",
      },
    ];
    for (const frame of clientFrames) {
      expect(browserScreencastClientFrameSchema.safeParse(frame).success).toBe(
        true,
      );
      expect(
        browserScreencastV1.clientFrameSchema.safeParse(frame).success,
      ).toBe(true);
    }

    for (const frame of [
      { kind: "armed", hasBinaryPayload: false, armEpoch: 3 },
      {
        kind: "revoked",
        hasBinaryPayload: false,
        armEpoch: 3,
        cause: "stolen",
      },
    ]) {
      expect(browserScreencastServerFrameSchema.safeParse(frame).success).toBe(
        true,
      );
      expect(
        browserScreencastV1.serverFrameSchema.safeParse(frame).success,
      ).toBe(true);
    }
  });

  it("parses generation-bound dialog open and response frames", () => {
    const opened = {
      kind: "dialogOpened",
      hasBinaryPayload: false,
      generation: 12,
      type: "prompt",
      message: "prompt text stays on the wire only",
      defaultValue: "default text",
    };
    const response = {
      kind: "dialogResponse",
      hasBinaryPayload: false,
      armEpoch: 4,
      generation: 12,
      accept: true,
      promptText: "typed text",
    };

    expect(browserScreencastServerFrameSchema.safeParse(opened).success).toBe(
      true,
    );
    expect(
      browserScreencastV1.serverFrameSchema.safeParse(opened).success,
    ).toBe(true);
    expect(browserScreencastClientFrameSchema.safeParse(response).success).toBe(
      true,
    );
    expect(
      browserScreencastV1.clientFrameSchema.safeParse(response).success,
    ).toBe(true);

    expect(
      browserScreencastServerFrameSchema.safeParse({
        ...opened,
        generation: -1,
      }).success,
    ).toBe(false);
    expect(
      browserScreencastClientFrameSchema.safeParse({
        ...response,
        promptText: 42,
      }).success,
    ).toBe(false);
  });
});

describe("browser.sessions@1.0 epic-scoped open + tab-shaped session info", () => {
  it("parses agentTabOpened as a one-way tab lifecycle event", () => {
    const opened = {
      kind: "agentTabOpened",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-2",
    };
    expect(browserSessionsServerFrameSchema.safeParse(opened).success).toBe(
      true,
    );
  });

  it("requires only the authorizing epicId on the open request", () => {
    expect(
      browserSessionsOpenRequestSchema.safeParse({
        epicId: "epic-1",
        chatId: "legacy-route",
      }).success,
    ).toBe(false);
    expect(
      browserSessionsOpenRequestSchema.safeParse({ epicId: "epic-1" }).success,
    ).toBe(true);
    expect(
      browserSessionsOpenRequestSchema.safeParse({ chatId: "chat-1" }).success,
    ).toBe(false);
    expect(browserSessionsOpenRequestSchema.safeParse({}).success).toBe(false);
  });

  it("parses the tab-shaped session info (url/status live on tabs, not the session root)", () => {
    expect(parsesSession(SAMPLE_SESSION)).toBe(true);
    expect(
      parsesSession({
        ...SAMPLE_SESSION,
        migration: { state: "legacy" },
      }),
    ).toBe(false);
    const { runtime: _omittedRuntime, ...sessionWithoutRuntime } =
      SAMPLE_SESSION;
    expect(_omittedRuntime.kind).toBe("headless");
    expect(parsesSession(sessionWithoutRuntime)).toBe(false);
    expect(
      parsesSession({
        sessionId: "session-1",
        hostId: "host-1",
        chatId: "chat-1",
        url: "http://localhost:3000",
        originTier: "dev",
        status: "ready",
        title: "App",
        lastActivityAt: 20,
      }),
    ).toBe(false);
  });

  it("requires viewed boolean on BrowserTabInfo and electronTabState frames (ticket 13)", () => {
    expect(
      parsesSession({
        ...SAMPLE_SESSION,
        tabs: [
          {
            tabId: "tab-1",
            url: "https://example.com",
            originTier: "external",
            status: "ready",
            title: "Example",
            viewed: true,
            drivenBy: [],
          },
        ],
      }),
    ).toBe(true);
    expect(
      parsesSession({
        ...SAMPLE_SESSION,
        tabs: [
          {
            tabId: "tab-1",
            url: "https://example.com",
            originTier: "external",
            status: "ready",
            title: "Example",
            drivenBy: [],
          },
        ],
      }),
    ).toBe(false);

    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "electronTabState",
        hasBinaryPayload: false,
        registrationId: "reg-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        status: "ready",
        viewed: true,
      }).success,
    ).toBe(true);
    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "electronTabState",
        hasBinaryPayload: false,
        registrationId: "reg-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        status: "ready",
      }).success,
    ).toBe(false);
  });

  it("requires epicId and tabId on screencast open requests", () => {
    expect(
      browserScreencastOpenRequestSchema.safeParse({
        epicId: "epic-1",
        sessionId: "session-1",
        tabId: "session-1",
        maxWidth: 1280,
        maxHeight: 720,
        quality: 80,
        format: "jpeg",
        role: "tile",
      }).success,
    ).toBe(true);
    expect(
      browserScreencastOpenRequestSchema.safeParse({
        sessionId: "session-1",
        tabId: "session-1",
        maxWidth: 1280,
        maxHeight: 720,
        quality: 80,
        format: "jpeg",
        role: "tile",
      }).success,
    ).toBe(false);
    expect(
      browserScreencastOpenRequestSchema.safeParse({
        epicId: "epic-1",
        sessionId: "session-1",
        maxWidth: 1280,
        maxHeight: 720,
        quality: 80,
        format: "jpeg",
        role: "tile",
      }).success,
    ).toBe(false);
  });
});

describe("browser.sessions@1.0 correlation", () => {
  it("rejects fake request ids on events and one-way retirement", () => {
    const clientEvents = [
      { kind: "electronTabLifecycleReady", hasBinaryPayload: false },
      {
        kind: "electronTabState",
        hasBinaryPayload: false,
        registrationId: "registration-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com/",
        title: "Example",
        status: "ready",
        viewed: false,
      },
    ];
    for (const frame of clientEvents) {
      expect(browserSessionsClientFrameSchema.safeParse(frame).success).toBe(
        true,
      );
      expect(
        browserSessionsClientFrameSchema.safeParse({
          ...frame,
          requestId: "unsettled-request",
        }).success,
      ).toBe(false);
    }

    const release = {
      kind: "releaseElectronTab",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    };
    expect(browserSessionsServerFrameSchema.safeParse(release).success).toBe(
      true,
    );
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...release,
        requestId: "unsettled-request",
      }).success,
    ).toBe(false);
  });

  it("requires request ids on request-response frames", () => {
    const capture = {
      kind: "capturePrimaryProfile",
      hasBinaryPayload: false,
      requestId: "capture-1",
    };
    expect(browserSessionsServerFrameSchema.safeParse(capture).success).toBe(
      true,
    );
    const { requestId: _captureRequestId, ...captureWithoutRequestId } =
      capture;
    expect(_captureRequestId).toBe("capture-1");
    expect(
      browserSessionsServerFrameSchema.safeParse(captureWithoutRequestId)
        .success,
    ).toBe(false);

    const cdpResult = {
      kind: "cdpResult",
      hasBinaryPayload: false,
      requestId: "cdp-1",
      result: { kind: "cdpReleaseObject", ok: true },
    };
    expect(browserSessionsClientFrameSchema.safeParse(cdpResult).success).toBe(
      true,
    );
    const { requestId: _cdpRequestId, ...cdpResultWithoutRequestId } =
      cdpResult;
    expect(_cdpRequestId).toBe("cdp-1");
    expect(
      browserSessionsClientFrameSchema.safeParse(cdpResultWithoutRequestId)
        .success,
    ).toBe(false);
  });
});
