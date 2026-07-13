import { describe, expect, it } from "vitest";
import {
  formatAgentConfigureResponse,
  formatAgentProviderProfileRateLimitsResponse,
  formatAgentProviderProfilesResponse,
  formatProfileSelection,
} from "../agent-profile-format";
import type {
  AgentConfigureSettings,
  AgentGetProviderProfileRateLimitsResponse,
  AgentListProviderProfilesResponse,
} from "@traycer/protocol/host";

const CAPTURED_AT = Date.UTC(2026, 6, 13, 9, 30, 0);

const PROFILES: AgentListProviderProfilesResponse = {
  providerId: "claude-code",
  profiles: [
    {
      selection: { kind: "ambient" },
      label: "Terminal login",
      authStatus: "authenticated",
      rateLimitStatus: "ok",
      usageUpdatedAt: CAPTURED_AT,
      isEffectiveLastUsed: false,
    },
    {
      selection: { kind: "profile", profileId: "prof_work" },
      label: "Work subscription",
      authStatus: "authenticated",
      rateLimitStatus: "hard_limit",
      usageUpdatedAt: CAPTURED_AT,
      isEffectiveLastUsed: true,
    },
    {
      selection: { kind: "profile", profileId: "prof_personal" },
      label: "Personal subscription",
      authStatus: "unauthenticated",
      rateLimitStatus: "unknown",
      usageUpdatedAt: null,
      isEffectiveLastUsed: false,
    },
  ],
};

describe("provider-profile list formatting", () => {
  it("renders every row as the --profile token that reselects it", () => {
    const human = formatAgentProviderProfilesResponse(PROFILES);

    expect(human).toContain(
      "--profile ambient - Terminal login [auth: authenticated] [limits: ok, captured 2026-07-13T09:30:00.000Z]",
    );
    expect(human).toContain(
      "--profile prof_work - Work subscription [auth: authenticated] [limits: hard_limit, captured 2026-07-13T09:30:00.000Z] [last-used]",
    );
    expect(human).toContain("Provider profiles for 'claude-code':");
  });

  it("marks only the effective last-used profile", () => {
    const rows = formatAgentProviderProfilesResponse(PROFILES)
      .split("\n")
      .filter((line) => line.startsWith("--profile "));

    expect(rows.filter((row) => row.includes("[last-used]"))).toEqual([
      expect.stringContaining("--profile prof_work"),
    ]);
  });

  it("reports a never-captured cached status as such rather than as a reading", () => {
    const human = formatAgentProviderProfilesResponse(PROFILES);

    expect(human).toContain(
      "--profile prof_personal - Personal subscription [auth: unauthenticated] [limits: unknown, captured never]",
    );
    expect(human).not.toContain("1970-01-01");
  });

  it("says so when a provider exposes no profiles", () => {
    const human = formatAgentProviderProfilesResponse({
      providerId: "codex",
      profiles: [],
    });

    expect(human).toContain("No provider profiles found for provider 'codex'.");
  });

  it("round-trips both concrete selections to their --profile value", () => {
    expect(formatProfileSelection({ kind: "ambient" })).toBe("ambient");
    expect(
      formatProfileSelection({ kind: "profile", profileId: "prof_work" }),
    ).toBe("prof_work");
  });
});

describe("detailed rate-limit formatting", () => {
  it("renders an available Claude Code read with the profile it was read for", () => {
    const response: AgentGetProviderProfileRateLimitsResponse = {
      rateLimits: {
        provider: "claude-code",
        available: true,
        subscriptionType: "max",
        fiveHour: {
          usedPercent: 42,
          resetsAt: CAPTURED_AT,
          durationMinutes: 300,
        },
        sevenDay: { usedPercent: 12, resetsAt: null, durationMinutes: null },
        sevenDayOpus: null,
        sevenDaySonnet: null,
        modelScoped: [],
        extraUsage: null,
      },
      usageUpdatedAt: CAPTURED_AT,
    };

    const human = formatAgentProviderProfileRateLimitsResponse(
      { kind: "profile", profileId: "prof_work" },
      response,
    );

    expect(human).toContain(
      "Rate limits for provider 'claude-code' [--profile prof_work], captured 2026-07-13T09:30:00.000Z:",
    );
    expect(human).toContain("plan: max");
    expect(human).toContain(
      "5-hour: 42% used, resets 2026-07-13T09:30:00.000Z, 300m window",
    );
    expect(human).toContain("7-day: 12% used");
  });

  it("reports an unreported window as unknown, never as 0% used", () => {
    const response: AgentGetProviderProfileRateLimitsResponse = {
      rateLimits: {
        provider: "codex",
        available: true,
        planType: null,
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        extraWindows: [],
        credits: null,
        individualLimit: null,
        resetCredits: null,
        rateLimitReachedType: null,
      },
      usageUpdatedAt: null,
    };

    const human = formatAgentProviderProfileRateLimitsResponse(
      { kind: "ambient" },
      response,
    );

    expect(human).toContain(
      "Rate limits for provider 'codex' [--profile ambient], captured never:",
    );
    expect(human).toContain("primary: unknown");
    expect(human).toContain("secondary: unknown");
    expect(human).toContain("plan: unknown");
    expect(human).not.toContain("0% used");
  });

  it("renders the unavailable arm with its reason instead of inventing limits", () => {
    const response: AgentGetProviderProfileRateLimitsResponse = {
      rateLimits: {
        provider: "codex",
        available: false,
        reason: "cli_not_found",
      },
      usageUpdatedAt: null,
    };

    const human = formatAgentProviderProfileRateLimitsResponse(
      { kind: "ambient" },
      response,
    );

    expect(human).toContain("unavailable (cli_not_found)");
    expect(human).not.toContain("% used");
  });
});

describe("configure formatting", () => {
  const settings: AgentConfigureSettings = {
    harnessId: "codex",
    model: "gpt-5.6-codex",
    profileSelection: { kind: "profile", profileId: "prof_work" },
    reasoningEffort: "high",
    fastMode: false,
    permissionMode: "supervised",
    agentMode: "regular",
  };

  it("renders the committed tuple with a reusable --profile value", () => {
    const human = formatAgentConfigureResponse("agent_1", {
      settings,
      warnings: [],
    });

    expect(human).toContain("Agent agent_1 configured for future turns:");
    expect(human).toContain("harness: codex");
    expect(human).toContain("model: gpt-5.6-codex");
    expect(human).toContain("profile: --profile prof_work");
    expect(human).toContain("reasoningEffort: high");
    expect(human).toContain("fastMode: off");
    expect(human).not.toContain("Warnings:");
  });

  it("lists the warnings a normalized setting produced", () => {
    const human = formatAgentConfigureResponse("agent_1", {
      settings: {
        ...settings,
        fastMode: false,
        profileSelection: { kind: "ambient" },
      },
      warnings: ["Fast mode is not available for 'gpt-5.6-codex'."],
    });

    expect(human).toContain("profile: --profile ambient");
    expect(human).toContain(
      "Warnings:\n- Fast mode is not available for 'gpt-5.6-codex'.",
    );
  });
});
