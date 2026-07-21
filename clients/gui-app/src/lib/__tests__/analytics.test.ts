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

  describe("notification analytics schema", () => {
    it("maps count edges through analyticsCountBucket()", async () => {
      const { analyticsCountBucket } = await import("@/lib/analytics");

      expect(analyticsCountBucket(null)).toBe("unknown");
      expect(analyticsCountBucket(0)).toBe("0");
      expect(analyticsCountBucket(1)).toBe("1");
      expect(analyticsCountBucket(2)).toBe("2-5");
      expect(analyticsCountBucket(5)).toBe("2-5");
      expect(analyticsCountBucket(6)).toBe("6-20");
      expect(analyticsCountBucket(20)).toBe("6-20");
      expect(analyticsCountBucket(21)).toBe("21+");
      expect(analyticsCountBucket(100)).toBe("21+");
    });

    it("accepts every notification event with its exact allowlisted key set", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationCenterOpened, {
          entry_point: "direct_ui",
          host_state: "exact",
          attention_bucket: "2-5",
          unread_bucket: "6-20",
        }),
      ).toEqual({
        entry_point: "direct_ui",
        host_state: "exact",
        attention_bucket: "2-5",
        unread_bucket: "6-20",
      });
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationFilterChanged, {
          filter: "unread_only",
          enabled: true,
        }),
      ).toEqual({ filter: "unread_only", enabled: true });
      expect(
        sanitizeAnalyticsProperties(
          AnalyticsEvent.NotificationActivationCompleted,
          {
            category: "task",
            section: "attention",
            surface: "center",
            outcome: "success",
          },
        ),
      ).toEqual({
        category: "task",
        section: "attention",
        surface: "center",
        outcome: "success",
      });
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationMarkedRead, {
          category: "collaboration",
          acknowledgment_source: "activation",
        }),
      ).toEqual({
        category: "collaboration",
        acknowledgment_source: "activation",
      });
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationsMarkedAllRead, {
          affected_count_bucket: "1",
        }),
      ).toEqual({ affected_count_bucket: "1" });
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "recent",
          outcome: "success",
          result_count_bucket: "2-5",
          has_more: true,
        }),
      ).toEqual({
        section: "recent",
        outcome: "success",
        result_count_bucket: "2-5",
        has_more: true,
      });
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "attention",
          outcome: "failure",
          result_count_bucket: null,
          has_more: null,
        }),
      ).toEqual({
        section: "attention",
        outcome: "failure",
        result_count_bucket: null,
        has_more: null,
      });
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationNewRevealed, {
          count_bucket: "21+",
        }),
      ).toEqual({ count_bucket: "21+" });
    });

    it("accepts every finite enum member on each notification event key", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      for (const entry_point of ["direct_ui", "notification"] as const) {
        for (const host_state of ["exact", "unknown"] as const) {
          for (const bucket of [
            "unknown",
            "0",
            "1",
            "2-5",
            "6-20",
            "21+",
          ] as const) {
            expect(
              sanitizeAnalyticsProperties(
                AnalyticsEvent.NotificationCenterOpened,
                {
                  entry_point,
                  host_state,
                  attention_bucket: bucket,
                  unread_bucket: bucket,
                },
              ),
            ).not.toBeNull();
          }
        }
      }

      for (const filter of [
        "unread_only",
        "task",
        "collaboration",
        "system",
      ] as const) {
        for (const enabled of [true, false]) {
          expect(
            sanitizeAnalyticsProperties(
              AnalyticsEvent.NotificationFilterChanged,
              { filter, enabled },
            ),
          ).not.toBeNull();
        }
      }

      for (const category of ["task", "collaboration", "system"] as const) {
        for (const section of ["attention", "recent"] as const) {
          for (const surface of ["center", "toast", "native"] as const) {
            for (const outcome of ["success", "failure"] as const) {
              expect(
                sanitizeAnalyticsProperties(
                  AnalyticsEvent.NotificationActivationCompleted,
                  { category, section, surface, outcome },
                ),
              ).not.toBeNull();
            }
          }
        }
        for (const acknowledgment_source of [
          "explicit_action",
          "activation",
        ] as const) {
          expect(
            sanitizeAnalyticsProperties(AnalyticsEvent.NotificationMarkedRead, {
              category,
              acknowledgment_source,
            }),
          ).not.toBeNull();
        }
      }
    });

    it("rejects out-of-taxonomy values and missing required keys on every notification event", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationCenterOpened, {
          entry_point: "command_palette",
          host_state: "exact",
          attention_bucket: "0",
          unread_bucket: "0",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationCenterOpened, {
          entry_point: "direct_ui",
          host_state: "partial",
          attention_bucket: "0",
          unread_bucket: "0",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationFilterChanged, {
          filter: "host",
          enabled: true,
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(
          AnalyticsEvent.NotificationActivationCompleted,
          {
            category: "app-local",
            section: "attention",
            surface: "center",
            outcome: "success",
          },
        ),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(
          AnalyticsEvent.NotificationActivationCompleted,
          {
            category: "task",
            section: "recent",
            surface: "popover",
            outcome: "success",
          },
        ),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationMarkedRead, {
          category: "global",
          acknowledgment_source: "activation",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationMarkedRead, {
          category: "task",
          acknowledgment_source: "auto",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationsMarkedAllRead, {
          affected_count_bucket: "many",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationNewRevealed, {
          count_bucket: "lots",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationCenterOpened, {
          entry_point: "direct_ui",
          host_state: "exact",
          attention_bucket: "0",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationFilterChanged, {
          filter: "task",
        }),
      ).toBeNull();
    });

    it("enforces NotificationPageLoaded success/failure relational nullability", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "recent",
          outcome: "success",
          result_count_bucket: null,
          has_more: true,
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "recent",
          outcome: "success",
          result_count_bucket: "2-5",
          has_more: null,
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "attention",
          outcome: "failure",
          result_count_bucket: "2-5",
          has_more: null,
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "attention",
          outcome: "failure",
          result_count_bucket: null,
          has_more: false,
        }),
      ).toBeNull();
      // A completed page always carries an exact row count - `unknown` is
      // reserved for a composite count that genuinely cannot be formed, which
      // never applies to a finished page fetch.
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "recent",
          outcome: "success",
          result_count_bucket: "unknown",
          has_more: false,
        }),
      ).toBeNull();
    });

    it("rejects unknown for notification_new_revealed's count_bucket", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      // The revealed count is always derived from the local arrival set, so
      // it can never be genuinely unknown the way a host composite count can.
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationNewRevealed, {
          count_bucket: "unknown",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationNewRevealed, {
          count_bucket: "1",
        }),
      ).toEqual({ count_bucket: "1" });
    });

    it("accepts analyticsCountBucket edges end-to-end on a notification event", async () => {
      const {
        AnalyticsEvent,
        analyticsCountBucket,
        sanitizeAnalyticsProperties,
      } = await import("@/lib/analytics");

      const edges: ReadonlyArray<{
        readonly input: number | null;
        readonly bucket: string;
      }> = [
        { input: null, bucket: "unknown" },
        { input: 0, bucket: "0" },
        { input: 1, bucket: "1" },
        { input: 2, bucket: "2-5" },
        { input: 5, bucket: "2-5" },
        { input: 6, bucket: "6-20" },
        { input: 20, bucket: "6-20" },
        { input: 21, bucket: "21+" },
      ];

      for (const edge of edges) {
        expect(analyticsCountBucket(edge.input)).toBe(edge.bucket);
        expect(
          sanitizeAnalyticsProperties(
            AnalyticsEvent.NotificationsMarkedAllRead,
            {
              affected_count_bucket: analyticsCountBucket(edge.input),
            },
          ),
        ).toEqual({ affected_count_bucket: edge.bucket });
      }
    });

    it("rejects notification payloads that only carry forbidden identity/content keys", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      const forbiddenOnly = {
        notificationId: "n-1",
        feedId: "host:n-1",
        hostId: "host-a",
        deviceLabel: "Anurag's MacBook",
        title: "Agent finished",
        body: "Deploy checkout fix completed",
        route: "/epics/secret/tab",
        age: 12_000,
        timestamp: 1_777_768_800_000,
        unreadCount: 3,
        attentionCount: 1,
      };

      const events = [
        AnalyticsEvent.NotificationCenterOpened,
        AnalyticsEvent.NotificationFilterChanged,
        AnalyticsEvent.NotificationActivationCompleted,
        AnalyticsEvent.NotificationMarkedRead,
        AnalyticsEvent.NotificationsMarkedAllRead,
        AnalyticsEvent.NotificationPageLoaded,
        AnalyticsEvent.NotificationNewRevealed,
      ] as const;

      for (const event of events) {
        expect(sanitizeAnalyticsProperties(event, forbiddenOnly)).toBeNull();
      }
    });

    it("rejects an otherwise-valid payload carrying one extra forbidden key", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      // Confirms the sanitizer rejects the whole payload rather than
      // silently stripping the extra key and returning the valid subset.
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationMarkedRead, {
          category: "task",
          acknowledgment_source: "activation",
          feedId: "host:n-1",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "recent",
          outcome: "success",
          result_count_bucket: "2-5",
          has_more: true,
          notificationId: "n-1",
        }),
      ).toBeNull();
    });

    it("rejects raw counts and out-of-bucket values in place of bucket strings", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationCenterOpened, {
          entry_point: "direct_ui",
          host_state: "exact",
          attention_bucket: 3,
          unread_bucket: "1",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationCenterOpened, {
          entry_point: "direct_ui",
          host_state: "exact",
          attention_bucket: "1",
          unread_bucket: 7,
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationsMarkedAllRead, {
          affected_count_bucket: 21,
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationNewRevealed, {
          count_bucket: 4,
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "recent",
          outcome: "success",
          result_count_bucket: 50,
          has_more: true,
        }),
      ).toBeNull();
    });

    it("rejects every notification event when an allowed key is missing even if forbidden keys are present", async () => {
      const { AnalyticsEvent, sanitizeAnalyticsProperties } =
        await import("@/lib/analytics");

      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationCenterOpened, {
          entry_point: "direct_ui",
          host_state: "exact",
          attention_bucket: "0",
          notificationId: "n-1",
          title: "secret",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(
          AnalyticsEvent.NotificationActivationCompleted,
          {
            category: "task",
            section: "recent",
            surface: "center",
            feedId: "host:n-1",
            route: "/epics/x/y",
          },
        ),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationMarkedRead, {
          category: "system",
          hostId: "host-a",
          body: "detail",
        }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.NotificationPageLoaded, {
          section: "recent",
          outcome: "success",
          has_more: true,
          notificationId: "page-1",
        }),
      ).toBeNull();
    });
  });
});
