import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  browserCookieKeySchema,
  browserPrimaryProfileDeltaSchema,
  browserSavedLoginSitesRequestSchema,
  browserSavedLoginSitesResponseSchema,
  browserSavedLoginSitesV10,
  browserSessionsClientFrameSchema,
  browserSessionsOpenRequestSchema,
  browserSessionsServerFrameSchema,
  browserSessionsV1,
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
  it("parses tabOpened as a one-way tab lifecycle event carrying source + disposition", () => {
    const opened = {
      kind: "tabOpened",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-2",
      source: "agent",
      disposition: "foreground",
    };
    expect(browserSessionsServerFrameSchema.safeParse(opened).success).toBe(
      true,
    );
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...opened,
        source: "page",
        disposition: "background",
      }).success,
    ).toBe(true);
    // Both discriminating fields are required and closed.
    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "tabOpened",
        hasBinaryPayload: false,
        sessionId: "session-1",
        tabId: "tab-2",
      }).success,
    ).toBe(false);
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...opened,
        disposition: "pip",
      }).success,
    ).toBe(false);
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

  it("carries the GUI's declared coLocatedHostId on lifecycle-ready, real or null (ticket 01)", () => {
    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "electronTabLifecycleReady",
        hasBinaryPayload: false,
        coLocatedHostId: "host-1",
      }).success,
    ).toBe(true);
    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "electronTabLifecycleReady",
        hasBinaryPayload: false,
        coLocatedHostId: null,
      }).success,
    ).toBe(true);
    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "electronTabLifecycleReady",
        hasBinaryPayload: false,
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
      {
        kind: "electronTabLifecycleReady",
        hasBinaryPayload: false,
        coLocatedHostId: "host-1",
      },
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

  // Cross-host mention previews (spec decision #10): a snapshot-only pair,
  // deliberately nullable rather than optional on the wire, and with no
  // `sessionId` - the owning host resolves the tab inside the stream's epic.
  it("round-trips the captureTabPreview / tabPreviewResult pair", () => {
    const request = {
      kind: "captureTabPreview",
      hasBinaryPayload: false,
      requestId: "preview-1",
      tabId: "tab-1",
    };
    expect(browserSessionsClientFrameSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      browserSessionsClientFrameSchema.safeParse({
        ...request,
        sessionId: "session-1",
      }).success,
      "captureTabPreview is strict: no sessionId to disagree with the host",
    ).toBe(false);

    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "tabPreviewResult",
        hasBinaryPayload: false,
        requestId: "preview-1",
        ok: true,
        screenshotBase64: "aGk=",
        url: "http://localhost:3000",
        title: "App",
        reason: null,
      }).success,
    ).toBe(true);
    // A refusal (a dormant tab) carries a reason and no payload at all.
    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "tabPreviewResult",
        hasBinaryPayload: false,
        requestId: "preview-1",
        ok: false,
        screenshotBase64: null,
        url: null,
        title: null,
        reason: "dormant",
      }).success,
    ).toBe(true);
    // Nullable, not optional: an omitted field is a wire error, not a default.
    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "tabPreviewResult",
        hasBinaryPayload: false,
        requestId: "preview-1",
        ok: false,
        reason: "dormant",
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

describe("browser.sessions@1.0 primary-profile cookie delta (ticket 06)", () => {
  const COOKIE = {
    name: "sid",
    value: "abc",
    domain: "example.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  };

  const COOKIE_KEY = {
    domain: "example.com",
    name: "sid",
    path: "/",
  };

  const DELTA = {
    domain: "example.com",
    cookies: [COOKIE],
    removedKeys: [],
    issuedAt: 1_000,
  };

  it("parses a well-formed domain-scoped delta", () => {
    expect(browserPrimaryProfileDeltaSchema.safeParse(DELTA).success).toBe(
      true,
    );
  });

  it("requires removedKeys - an omitted field is a wire error, not an empty default", () => {
    const { removedKeys: _removedKeys, ...deltaWithoutRemovedKeys } = DELTA;
    expect(_removedKeys).toEqual([]);
    expect(
      browserPrimaryProfileDeltaSchema.safeParse(deltaWithoutRemovedKeys)
        .success,
    ).toBe(false);
  });

  it("round-trips a delta carrying removedKeys, standalone and inside the primaryProfileDelta client frame", () => {
    const deltaWithRemoval = { ...DELTA, removedKeys: [COOKIE_KEY] };
    expect(
      browserPrimaryProfileDeltaSchema.safeParse(deltaWithRemoval).success,
    ).toBe(true);

    const clientFrame = {
      kind: "primaryProfileDelta" as const,
      hasBinaryPayload: false,
      ...deltaWithRemoval,
    };
    const parsed = browserSessionsClientFrameSchema.safeParse(clientFrame);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      ...clientFrame,
      cookies: [{ ...COOKIE, partitionKey: null }],
    });
  });

  it("is strict: rejects an unknown field on the delta itself", () => {
    expect(
      browserPrimaryProfileDeltaSchema.safeParse({
        ...DELTA,
        futureField: "from a newer peer",
      }).success,
    ).toBe(false);
  });

  it("rejects a removedKeys entry carrying an extra field - the cookie-key schema is strict", () => {
    expect(
      browserPrimaryProfileDeltaSchema.safeParse({
        ...DELTA,
        removedKeys: [{ ...COOKIE_KEY, value: "abc" }],
      }).success,
    ).toBe(false);
    expect(browserCookieKeySchema.safeParse(COOKIE_KEY).success).toBe(true);
    expect(
      browserCookieKeySchema.safeParse({ ...COOKIE_KEY, value: "abc" }).success,
    ).toBe(false);
  });
});

describe("browser.sessions@1.0 store-key handshake", () => {
  // 32 zero bytes: the exact shape of a minted store key on the wire.
  const RAW_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const WRAPPED_KEY = "d3JhcHBlZA==";

  it("accepts the three client frames", () => {
    for (const frame of [
      { kind: "storeKeyOffer", hasBinaryPayload: false },
      {
        kind: "storeKeyWrapped",
        hasBinaryPayload: false,
        requestId: "request-1",
        wrappedKey: WRAPPED_KEY,
      },
      {
        kind: "storeKeyUnwrapped",
        hasBinaryPayload: false,
        requestId: "request-1",
        rawKey: RAW_KEY,
      },
      {
        kind: "storeKeyUnwrapped",
        hasBinaryPayload: false,
        requestId: "request-1",
        rawKey: null,
      },
    ]) {
      expect(browserSessionsClientFrameSchema.safeParse(frame).success).toBe(
        true,
      );
      expect(browserSessionsV1.clientFrameSchema.safeParse(frame).success).toBe(
        true,
      );
    }
  });

  it("accepts the two server frames", () => {
    for (const frame of [
      {
        kind: "storeKeyWrapRequest",
        hasBinaryPayload: false,
        requestId: "request-1",
        rawKey: RAW_KEY,
      },
      {
        kind: "storeKeyUnwrapRequest",
        hasBinaryPayload: false,
        requestId: "request-1",
        wrappedKey: WRAPPED_KEY,
      },
    ]) {
      expect(browserSessionsServerFrameSchema.safeParse(frame).success).toBe(
        true,
      );
      expect(browserSessionsV1.serverFrameSchema.safeParse(frame).success).toBe(
        true,
      );
    }
  });

  it("rejects key material that is not base64", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "storeKeyWrapRequest",
        hasBinaryPayload: false,
        requestId: "request-1",
        rawKey: "not base64!",
      }).success,
    ).toBe(false);
    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "storeKeyWrapped",
        hasBinaryPayload: false,
        requestId: "request-1",
        wrappedKey: "not base64!",
      }).success,
    ).toBe(false);
    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "storeKeyUnwrapped",
        hasBinaryPayload: false,
        requestId: "request-1",
        rawKey: "not base64!",
      }).success,
    ).toBe(false);
  });
});

describe("browser.sessions@1.0 forget all browser logins (ticket 08)", () => {
  it("accepts the client trigger and the server fan-out, both payload-free", () => {
    const forgetLogins = { kind: "forgetLogins", hasBinaryPayload: false };
    const forgotten = {
      kind: "primaryProfileForgotten",
      hasBinaryPayload: false,
    };
    expect(
      browserSessionsClientFrameSchema.safeParse(forgetLogins).success,
    ).toBe(true);
    expect(
      browserSessionsV1.clientFrameSchema.safeParse(forgetLogins).success,
    ).toBe(true);
    expect(browserSessionsServerFrameSchema.safeParse(forgotten).success).toBe(
      true,
    );
    expect(
      browserSessionsV1.serverFrameSchema.safeParse(forgotten).success,
    ).toBe(true);
  });
});

describe("browser.sessions@1.0 clear cookies for one site (ticket 07)", () => {
  const evict = {
    kind: "primaryProfileEvict",
    hasBinaryPayload: false,
    domain: "example.com",
  };

  it("accepts the server evict frame carrying one registrable domain", () => {
    expect(browserSessionsServerFrameSchema.safeParse(evict).success).toBe(
      true,
    );
    expect(browserSessionsV1.serverFrameSchema.safeParse(evict).success).toBe(
      true,
    );
  });
});

describe("browser.sessions@1.0 clear one site from Settings (ticket 10)", () => {
  const clearSite = {
    kind: "clearSite",
    hasBinaryPayload: false,
    domain: "example.com",
  };

  it("accepts the client frame carrying one registrable domain", () => {
    expect(browserSessionsClientFrameSchema.safeParse(clearSite).success).toBe(
      true,
    );
    expect(
      browserSessionsV1.clientFrameSchema.safeParse(clearSite).success,
    ).toBe(true);
  });
});

describe("browser.savedLoginSites@1.0 (ticket 10)", () => {
  it("takes no input: the slice read is the caller's own", () => {
    expect(browserSavedLoginSitesRequestSchema.safeParse({}).success).toBe(
      true,
    );
    expect(
      browserSavedLoginSitesRequestSchema.safeParse({ userId: "user-1" })
        .success,
    ).toBe(false);
    expect(browserSavedLoginSitesV10.requestSchema.safeParse({}).success).toBe(
      true,
    );
  });

  it("separates a sealed host from a genuinely empty jar", () => {
    expect(
      browserSavedLoginSitesResponseSchema.safeParse({ kind: "sealed" })
        .success,
    ).toBe(true);
    expect(
      browserSavedLoginSitesResponseSchema.safeParse({
        kind: "sites",
        sites: [],
      }).success,
    ).toBe(true);
    // `sealed` carries nothing else: it is the absence of a readable slice.
    expect(
      browserSavedLoginSitesResponseSchema.safeParse({
        kind: "sealed",
        sites: [],
      }).success,
    ).toBe(false);
  });

  it("carries names and times only - never a cookie value", () => {
    const sites = {
      kind: "sites",
      sites: [{ domain: "example.com", lastSeen: 1_700_000_000_000 }],
    };
    expect(browserSavedLoginSitesResponseSchema.safeParse(sites).success).toBe(
      true,
    );
    expect(
      browserSavedLoginSitesV10.responseSchema.safeParse(sites).success,
    ).toBe(true);
    // A row that could carry a value is the one shape this surface must never
    // be able to express (spec section 7.3).
    expect(
      browserSavedLoginSitesResponseSchema.safeParse({
        kind: "sites",
        sites: [
          {
            domain: "example.com",
            lastSeen: 1,
            value: "session-cookie",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
