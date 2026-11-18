import { describe, expect, it } from "vitest";
import { resolveComposerTopBannerKind } from "@/components/chat/composer/chat-composer-top-banner";

describe("resolveComposerTopBannerKind", () => {
  it("lets fallbackVisible win over profileDisabled and over reauthVisible", () => {
    expect(
      resolveComposerTopBannerKind({
        fallbackVisible: true,
        profileDisabled: true,
        reauthVisible: true,
        fallbackReturnVisible: true,
        rateLimitVisible: true,
      }),
    ).toBe("fallback");
    // Falsification: move the fallbackVisible guard below the profileDisabled short-circuit in chat-composer-top-banner.ts and THIS assertion must go red.
    expect(
      resolveComposerTopBannerKind({
        fallbackVisible: true,
        profileDisabled: true,
        reauthVisible: false,
        fallbackReturnVisible: false,
        rateLimitVisible: false,
      }),
    ).toBe("fallback");
  });

  it("sits fallback-return between reauth and rate-limit", () => {
    expect(
      resolveComposerTopBannerKind({
        fallbackVisible: false,
        profileDisabled: false,
        reauthVisible: true,
        fallbackReturnVisible: true,
        rateLimitVisible: true,
      }),
    ).toBe("reauth");
    expect(
      resolveComposerTopBannerKind({
        fallbackVisible: false,
        profileDisabled: false,
        reauthVisible: false,
        fallbackReturnVisible: true,
        rateLimitVisible: true,
      }),
    ).toBe("fallback-return");
    expect(
      resolveComposerTopBannerKind({
        fallbackVisible: false,
        profileDisabled: false,
        reauthVisible: false,
        fallbackReturnVisible: false,
        rateLimitVisible: true,
      }),
    ).toBe("rate-limit");
  });

  it("short-circuits everything below profileDisabled to none", () => {
    expect(
      resolveComposerTopBannerKind({
        fallbackVisible: false,
        profileDisabled: true,
        reauthVisible: true,
        fallbackReturnVisible: true,
        rateLimitVisible: true,
      }),
    ).toBe("none");
  });

  it("walks the remaining chain to rate-limit and then none", () => {
    expect(
      resolveComposerTopBannerKind({
        fallbackVisible: false,
        profileDisabled: false,
        reauthVisible: false,
        fallbackReturnVisible: false,
        rateLimitVisible: true,
      }),
    ).toBe("rate-limit");
    expect(
      resolveComposerTopBannerKind({
        fallbackVisible: false,
        profileDisabled: false,
        reauthVisible: false,
        fallbackReturnVisible: false,
        rateLimitVisible: false,
      }),
    ).toBe("none");
  });
});
