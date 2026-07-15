import { PostHog, type CaptureResult } from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// MODE === "test" in vitest, so analytics is disabled and posthog never boots.
describe("analytics", () => {
  it("is a no-op when MODE is test", async () => {
    const posthog = await import("posthog-js");
    const initSpy = vi.spyOn(posthog.default, "init");
    const identifySpy = vi.spyOn(posthog.default, "identify");
    const captureSpy = vi.spyOn(posthog.default, "capture");

    const { Analytics, AnalyticsEvent } = await import("@/lib/analytics");
    const analytics = Analytics.getInstance();

    analytics.identify("7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1", null);
    analytics.track(AnalyticsEvent.TaskCreated, { mode: "chat" });

    expect(initSpy).not.toHaveBeenCalled();
    expect(identifySpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("keeps every automatic PostHog capture surface disabled", async () => {
    const { POSTHOG_CONFIG } = await import("@/lib/analytics");

    expect(POSTHOG_CONFIG).toMatchObject({
      autocapture: false,
      rageclick: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      disable_product_tours: true,
      disable_web_experiments: true,
      advanced_disable_decide: true,
      advanced_disable_feature_flags: true,
      save_campaign_params: false,
      save_referrer: false,
    });
    expect(POSTHOG_CONFIG.property_denylist).toEqual(
      expect.arrayContaining([
        "$current_url",
        "$pathname",
        "$referrer",
        "$initial_current_url",
        "$session_entry_url",
      ]),
    );
  });

  it("refuses to identify with a non-UUID user id", async () => {
    const { Analytics } = await import("@/lib/analytics");
    const analytics = Analytics.getInstance();

    expect(analytics.identify("alice@example.com", null)).toBe(false);
    expect(analytics.identify("/Users/alice/secret-repo", null)).toBe(false);
    expect(
      analytics.identify("7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1", null),
    ).toBe(true);
    analytics.reset();
  });

  it("strips identifiers, paths, content, queries, and raw errors at runtime", async () => {
    const { AnalyticsEvent, sanitizeAnalyticsProperties } =
      await import("@/lib/analytics");

    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ChatMessageSent, {
        source: "direct_ui",
        harness: "codex",
        mode: "regular",
        path: "/private/repository",
        query: "customer secret",
        prompt: "user content",
        error: "raw server response",
        userId: "user-1",
      }),
    ).toEqual({ harness: "codex", mode: "regular" });
  });

  it("rejects an allowed key with a value outside its event taxonomy", async () => {
    const { AnalyticsEvent, sanitizeAnalyticsProperties } =
      await import("@/lib/analytics");

    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ChatMessageSent, {
        harness: "customer-secret",
        mode: "regular",
      }),
    ).toBeNull();
  });

  it("rejects values that belong to another event sharing the same key", async () => {
    const { AnalyticsEvent, sanitizeAnalyticsProperties } =
      await import("@/lib/analytics");

    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.OnboardingStarted, {
        mode: "chat",
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ApprovalDecided, {
        decision: "discard",
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ArtifactCreated, {
        kind: "shell",
      }),
    ).toBeNull();
  });

  it("rejects contradictory outcome/blocker pairs and partial-count arithmetic", async () => {
    const { AnalyticsEvent, sanitizeAnalyticsProperties } =
      await import("@/lib/analytics");

    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.WorktreeDeleted, {
        outcome: "succeeded",
        blocker: "conflict",
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.WorktreeDeleted, {
        outcome: "failed",
        blocker: null,
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.WorktreesBulkDeleted, {
        requested_count: 3,
        succeeded_count: 1,
        failed_count: 1,
      }),
    ).toBeNull();
  });

  it("has a runtime schema for every declared event", async () => {
    const { analyticsEventContractIsComplete } =
      await import("@/lib/analytics");

    expect(analyticsEventContractIsComplete()).toBe(true);
  });

  it("maps typed host RPC codes and error text to bounded blockers", async () => {
    const { analyticsBlockerFromError } = await import("@/lib/analytics");

    expect(
      analyticsBlockerFromError({ code: "WORKTREE_BUSY", message: "opaque" }),
    ).toBe("conflict");
    expect(
      analyticsBlockerFromError({ code: "UNAUTHORIZED", message: "opaque" }),
    ).toBe("authentication");
    expect(analyticsBlockerFromError(new Error("Request timed out"))).toBe(
      "timeout",
    );
    expect(analyticsBlockerFromError("something inscrutable")).toBe("unknown");
  });

  it("filters real SDK custom and identify CaptureResults after enrichment", async () => {
    const { POSTHOG_CONFIG, sanitizePostHogCaptureResult } =
      await import("@/lib/analytics");
    const captured: CaptureResult[] = [];
    window.history.replaceState(
      {},
      "",
      "/epics/epic-secret/tab-secret?focusArtifactId=artifact-secret&focusThreadId=thread-secret",
    );
    const sdk = new PostHog();
    sdk.init("phc_test_project_key", {
      ...POSTHOG_CONFIG,
      before_send: (result) => {
        const sanitized = sanitizePostHogCaptureResult(result);
        if (sanitized !== null) captured.push(sanitized);
        return null;
      },
      persistence: "memory",
      request_batching: false,
    });
    sdk.register({
      app: "gui-app",
      app_version: "1.2.3",
      platform: "macos",
      release_channel: "production",
    });

    sdk.capture("chat_message_sent", {
      harness: "codex",
      mode: "regular",
    });
    sdk.identify("7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1", {
      email: "alice@example.com",
      name: "Alice Smith",
      favorite_repo: "/Users/alice/secret-repo",
    });

    const custom = captured.find(({ event }) => event === "chat_message_sent");
    const identify = captured.find(({ event }) => event === "$identify");
    expect(typeof custom?.properties.distinct_id).toBe("string");
    expect(custom?.properties).toMatchObject({
      token: "phc_test_project_key",
      app: "gui-app",
      app_version: "1.2.3",
      platform: "macos",
      release_channel: "production",
      harness: "codex",
      mode: "regular",
    });
    // $session_id / $window_id are the ONLY SDK enrichment allowed through:
    // opaque SDK-generated UUIDs that keep session analyses working.
    const allowedKeys = new Set([
      "app",
      "app_version",
      "distinct_id",
      "harness",
      "mode",
      "platform",
      "release_channel",
      "token",
      "$session_id",
      "$window_id",
    ]);
    for (const key of Object.keys(custom?.properties ?? {})) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // Unconditional: session-based analyses (paths, session funnels) depend
    // on this passthrough, so its silent disappearance must fail the suite.
    expect(custom?.properties.$session_id).toMatch(UUID_PATTERN);
    expect(typeof identify?.properties.$anon_distinct_id).toBe("string");
    expect(identify?.properties).toMatchObject({
      token: "phc_test_project_key",
      distinct_id: "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
    });
    expect(Object.keys(identify?.properties ?? {}).sort()).toEqual(
      ["$anon_distinct_id", "distinct_id", "token"].sort(),
    );
    // Email is the ONLY person property allowed through; everything else the
    // SDK staged on $set/$set_once (name, custom props, referrer/campaign
    // enrichment) is dropped.
    expect(identify?.$set).toEqual({ email: "alice@example.com" });
    expect(identify?.$set_once).toBeUndefined();
    expect(identify?.$unset).toBeUndefined();
    expect(JSON.stringify(captured)).not.toMatch(
      /epic-secret|artifact-secret|thread-secret|pathname|referrer|user_agent|Alice Smith|secret-repo/,
    );
  });

  it("rejects content-shaped identities from real SDK CaptureResults", async () => {
    const { POSTHOG_CONFIG, sanitizePostHogCaptureResult } =
      await import("@/lib/analytics");
    const unsafeIdentities = [
      "/Users/alice/secret-repo",
      "alice@example.com",
      "https://example.com/private/task",
      "Alice Smith",
      "secret-team-slug",
    ];

    for (const unsafeIdentity of unsafeIdentities) {
      const captured: CaptureResult[] = [];
      const sdk = new PostHog();
      sdk.init("phc_test_project_key", {
        ...POSTHOG_CONFIG,
        before_send: (result) => {
          const sanitized = sanitizePostHogCaptureResult(result);
          if (sanitized !== null) captured.push(sanitized);
          return null;
        },
        persistence: "memory",
        request_batching: false,
      });
      sdk.register({
        app: "gui-app",
        app_version: "1.2.3",
        platform: "macos",
        release_channel: "production",
      });
      sdk.identify(unsafeIdentity);
      sdk.capture("command_palette_opened");

      expect(JSON.stringify(captured)).not.toContain(unsafeIdentity);
    }
  });

  it("keeps the email when a repeat identify surfaces as a $set event", async () => {
    const { POSTHOG_CONFIG, sanitizePostHogCaptureResult } =
      await import("@/lib/analytics");
    const captured: CaptureResult[] = [];
    const sdk = new PostHog();
    // Unique token: posthog-js shares instances (and identified state) by
    // token, and this test needs a genuinely fresh anonymous -> identified
    // -> repeat-identify sequence.
    sdk.init("phc_test_project_key_repeat_identify", {
      ...POSTHOG_CONFIG,
      before_send: (result) => {
        const sanitized = sanitizePostHogCaptureResult(result);
        if (sanitized !== null) captured.push(sanitized);
        return null;
      },
      persistence: "memory",
      request_batching: false,
    });
    sdk.register({
      app: "gui-app",
      app_version: "1.2.3",
      platform: "macos",
      release_channel: "production",
    });

    // Second identify for an ALREADY-identified distinct id: the real SDK
    // emits `$set` instead of `$identify` (this is the renderer-restart /
    // changed-email shape). The sanitizer must pass the email through.
    sdk.identify("7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1", {
      email: "alice@example.com",
      name: "Alice Smith",
    });
    sdk.identify("7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1", {
      email: "alice.renamed@example.com",
      name: "Alice Renamed",
    });

    const setEvent = captured.filter(({ event }) => event === "$set").at(-1);
    expect(setEvent).toBeDefined();
    expect(setEvent?.$set).toEqual({ email: "alice.renamed@example.com" });
    expect(setEvent?.properties).toMatchObject({
      token: "phc_test_project_key_repeat_identify",
      distinct_id: "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
    });
    expect(Object.keys(setEvent?.properties ?? {}).sort()).toEqual(
      ["distinct_id", "token"].sort(),
    );
    expect(JSON.stringify(captured)).not.toMatch(/Alice/);
  });

  it("contains SDK exceptions: a throwing init permanently disables analytics", async () => {
    vi.resetModules();
    vi.stubEnv("MODE", "development");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_project_key");
    try {
      const posthog = (await import("posthog-js")).default;
      const initSpy = vi.spyOn(posthog, "init").mockImplementation(() => {
        throw new Error("storage denied");
      });
      const captureSpy = vi.spyOn(posthog, "capture");
      const { Analytics, AnalyticsEvent } = await import("@/lib/analytics");

      const analytics = Analytics.getInstance();
      expect(initSpy).toHaveBeenCalledTimes(1);
      // Valid payloads still report local acceptance; the SDK is never
      // touched again, and nothing escapes into the caller.
      expect(
        analytics.track(AnalyticsEvent.TaskCreated, { mode: "chat" }),
      ).toBe(true);
      expect(
        analytics.identify("7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1", null),
      ).toBe(true);
      expect(() => {
        analytics.reset();
      }).not.toThrow();
      expect(captureSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it("contains SDK exceptions thrown by capture/identify/reset mid-session", async () => {
    vi.resetModules();
    vi.stubEnv("MODE", "development");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_project_key");
    try {
      const posthog = (await import("posthog-js")).default;
      vi.spyOn(posthog, "init").mockImplementation(() => posthog);
      vi.spyOn(posthog, "register").mockImplementation(() => undefined);
      vi.spyOn(posthog, "capture").mockImplementation(() => {
        throw new Error("before_send exploded");
      });
      vi.spyOn(posthog, "identify").mockImplementation(() => {
        throw new Error("identify exploded");
      });
      vi.spyOn(posthog, "reset").mockImplementation(() => {
        throw new Error("reset exploded");
      });
      vi.spyOn(posthog, "get_distinct_id").mockImplementation(() => {
        throw new Error("persistence exploded");
      });
      const { Analytics, AnalyticsEvent } = await import("@/lib/analytics");

      const analytics = Analytics.getInstance();
      expect(
        analytics.track(AnalyticsEvent.TaskCreated, { mode: "chat" }),
      ).toBe(true);
      expect(
        analytics.identify(
          "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
          "alice@example.com",
        ),
      ).toBe(true);
      expect(() => {
        analytics.reset();
      }).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it("resets persisted cross-account identity before identifying the new user", async () => {
    vi.resetModules();
    vi.stubEnv("MODE", "development");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_project_key");
    try {
      const posthog = (await import("posthog-js")).default;
      const calls: string[] = [];
      // Simulate a cold start on ANOTHER account's persisted SDK state:
      // distinct_id differs from $device_id (= identified) and from the
      // signing-in user.
      vi.spyOn(posthog, "init").mockImplementation(() => posthog);
      vi.spyOn(posthog, "register").mockImplementation(() => undefined);
      vi.spyOn(posthog, "get_distinct_id").mockImplementation(
        () => "0f0e23f5-8a3d-4d2b-923c-8d02b8ef8000",
      );
      vi.spyOn(posthog, "get_property").mockImplementation(
        () => "9a9e23f5-8a3d-4d2b-923c-8d02b8ef8999",
      );
      vi.spyOn(posthog, "reset").mockImplementation(() => {
        calls.push("reset");
      });
      vi.spyOn(posthog, "identify").mockImplementation(() => {
        calls.push("identify");
      });
      const { Analytics } = await import("@/lib/analytics");

      Analytics.getInstance().identify(
        "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
        "alice@example.com",
      );
      // The stale account's identity/session is dropped BEFORE the new
      // identify so the two accounts' streams cannot blend.
      expect(calls).toEqual(["reset", "identify"]);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it("does not reset when the persisted identity already belongs to the signing-in user", async () => {
    vi.resetModules();
    vi.stubEnv("MODE", "development");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_project_key");
    try {
      const posthog = (await import("posthog-js")).default;
      const calls: string[] = [];
      vi.spyOn(posthog, "init").mockImplementation(() => posthog);
      vi.spyOn(posthog, "register").mockImplementation(() => undefined);
      // Renderer restart: the SDK still holds THIS user's identity.
      vi.spyOn(posthog, "get_distinct_id").mockImplementation(
        () => "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
      );
      vi.spyOn(posthog, "get_property").mockImplementation(
        () => "9a9e23f5-8a3d-4d2b-923c-8d02b8ef8999",
      );
      vi.spyOn(posthog, "reset").mockImplementation(() => {
        calls.push("reset");
      });
      vi.spyOn(posthog, "identify").mockImplementation(() => {
        calls.push("identify");
      });
      const { Analytics } = await import("@/lib/analytics");

      Analytics.getInstance().identify(
        "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
        "alice@example.com",
      );
      // No reset: the repeat identify keeps the session and lets the SDK
      // surface the email refresh as a $set event.
      expect(calls).toEqual(["identify"]);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it("drops events that are not part of the declared contract", async () => {
    const { sanitizePostHogCaptureResult } = await import("@/lib/analytics");

    expect(
      sanitizePostHogCaptureResult({
        event: "$pageview",
        properties: {
          token: "phc_test_project_key",
          distinct_id: "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
        },
        uuid: "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
      }),
    ).toBeNull();
    expect(
      sanitizePostHogCaptureResult({
        event: "made_up_event",
        properties: {
          token: "phc_test_project_key",
          distinct_id: "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
        },
        uuid: "7b6e23f5-8a3d-4d2b-923c-8d02b8ef80d1",
      }),
    ).toBeNull();
  });
});
