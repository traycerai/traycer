import { describe, expect, it } from "vitest";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import {
  providerRateLimitsSchema,
  providerRateLimitWindows,
} from "@traycer/protocol/host/rate-limit";
import {
  formatCompactWindowDuration,
  providerWindowEntries,
} from "@/lib/rate-limits/rate-limit-window-catalog";

/**
 * Every fixture below is parsed through the wire schema before it is used, so a
 * shape that has drifted from the protocol fails here rather than certifying a
 * catalog arm against a payload no host would ever send.
 */
function wire(rateLimits: ProviderRateLimits): ProviderRateLimits {
  return providerRateLimitsSchema.parse(rateLimits);
}

function windowOf(
  usedPercent: number,
  resetsAt: number | null,
  durationMinutes: number | null,
): {
  usedPercent: number;
  resetsAt: number | null;
  durationMinutes: number | null;
} {
  return { usedPercent, resetsAt, durationMinutes };
}

/** A model-scoped Claude window; `usedPercent` doubles as its identity here. */
function modelWindow(
  displayName: string,
  usedPercent: number,
): {
  displayName: string;
  usedPercent: number;
  resetsAt: number | null;
  durationMinutes: number | null;
} {
  return { displayName, usedPercent, resetsAt: null, durationMinutes: null };
}

const CLAUDE_CODE: ProviderRateLimits = wire({
  provider: "claude-code",
  available: true,
  subscriptionType: "max",
  fiveHour: windowOf(33, 1_800_000, 300),
  sevenDay: windowOf(34, 1_900_000, 10_080),
  sevenDayOpus: windowOf(57, 1_900_000, 10_080),
  sevenDaySonnet: windowOf(12, 1_900_000, 10_080),
  modelScoped: [
    {
      displayName: "Fable",
      usedPercent: 57,
      resetsAt: 1_900_000,
      durationMinutes: null,
    },
    {
      displayName: "Opus 5",
      usedPercent: 4,
      resetsAt: null,
      durationMinutes: null,
    },
  ],
  extraUsage: null,
});

const CODEX: ProviderRateLimits = wire({
  provider: "codex",
  available: true,
  planType: "pro",
  limitId: "default",
  limitName: null,
  primary: windowOf(67, 1_800_000, 300),
  secondary: windowOf(21, 2_000_000, 10_080),
  extraWindows: [
    {
      limitId: "gpt-5-codex",
      limitName: "GPT-5 Codex",
      primary: windowOf(9, 1_800_000, 300),
      secondary: windowOf(3, 2_000_000, 10_080),
    },
  ],
  credits: null,
  individualLimit: null,
  resetCredits: null,
  rateLimitReachedType: null,
});

const OPENCODE: ProviderRateLimits = wire({
  provider: "opencode",
  available: true,
  credentialGeneration: "gen-1",
  fiveHour: { ...windowOf(10, 1_800_000, 300), status: "ok" },
  weekly: { ...windowOf(20, 2_000_000, 10_080), status: "ok" },
  monthly: { ...windowOf(30, 2_500_000, 43_200), status: "ok" },
});

const GROK: ProviderRateLimits = wire({
  provider: "grok",
  available: true,
  subscriptionTier: "premium",
  periodType: "monthly",
  periodStart: 1_000_000,
  periodEnd: 2_000_000,
  period: windowOf(44, 2_000_000, null),
  monthlyLimit: null,
  onDemandCap: null,
  onDemandUsed: null,
  prepaidBalance: null,
});

const CURSOR: ProviderRateLimits = wire({
  provider: "cursor",
  available: true,
  cycleStart: 1_000_000,
  cycleEnd: 2_000_000,
  cursorModels: windowOf(38, 2_000_000, null),
  otherModels: windowOf(4, 2_000_000, null),
  includedLimitUsd: 20,
  usedUsd: 7.6,
  remainingUsd: 12.4,
  bonusUsedUsd: null,
  onDemandLimitType: null,
  onDemandLimitUsd: null,
  onDemandUsedUsd: null,
  onDemandRemainingUsd: null,
  displayMessage: null,
});

const OPENROUTER: ProviderRateLimits = wire({
  provider: "openrouter",
  available: true,
  limit: null,
  limitRemaining: null,
  dailySpend: 1,
  weeklySpend: 2,
  monthlySpend: 3,
  totalCredits: 10,
  totalUsage: 4,
  balance: 6,
});

const KILOCODE: ProviderRateLimits = wire({
  provider: "kilocode",
  available: true,
  creditBalance: 12.5,
  passState: "active",
});

const HUGGINGFACE: ProviderRateLimits = wire({
  provider: "huggingface",
  available: true,
  includedUsd: 2,
  usedUsd: 0.5,
  remainingIncludedUsd: 1.5,
  limitUsd: null,
  remainingLimitUsd: null,
  numRequests: 40,
  periodStart: null,
  periodEnd: null,
});

const UNAVAILABLE: ProviderRateLimits = wire({
  provider: "claude-code",
  available: false,
  reason: "usage_fetch_failed",
});

describe("formatCompactWindowDuration", () => {
  it.each([
    [300, "5h"],
    [360, "6h"],
    [1_440, "1d"],
    [4_320, "3d"],
    [10_080, "wk"],
    [43_200, "mo"],
    [90, "90m"],
  ])("renders %i minutes as %s", (minutes, expected) => {
    expect(formatCompactWindowDuration(minutes)).toBe(expected);
  });

  it.each([[null], [0], [-5]])(
    "falls back to a generic label for %s minutes",
    (minutes) => {
      expect(formatCompactWindowDuration(minutes)).toBe("usage");
    },
  );
});

describe("providerWindowEntries", () => {
  it("keys and labels every Claude Code window, model windows last", () => {
    expect(
      providerWindowEntries(CLAUDE_CODE).map((entry) => [
        entry.windowKey,
        entry.label,
        entry.kind,
      ]),
    ).toEqual([
      ["claude-code:fiveHour", "5h", "session"],
      ["claude-code:sevenDay", "wk", "weekly"],
      ["claude-code:sevenDayOpus", "Opus wk", "weekly"],
      ["claude-code:sevenDaySonnet", "Sonnet wk", "weekly"],
      ["claude-code:model:Fable", "Fable", "model"],
      ["claude-code:model:Opus 5", "Opus 5", "model"],
    ]);
  });

  // The display name is the only identity a model-scoped window carries, so
  // the toggle key has to be derivable from it and nothing else.
  it("round-trips a model display name through its window key", () => {
    const entries = providerWindowEntries(CLAUDE_CODE);
    const modelEntries = entries.filter((entry) => entry.kind === "model");

    expect(modelEntries.map((entry) => entry.windowKey)).toEqual([
      "claude-code:model:Fable",
      "claude-code:model:Opus 5",
    ]);
    for (const entry of modelEntries) {
      expect(entry.windowKey).toBe(`claude-code:model:${entry.label}`);
    }
  });

  // `displayName` is the only identity the wire carries, so two windows can
  // arrive under one name. Neither entry may take the other's key.
  it("gives colliding model names distinct keys and leaves both labels alone", () => {
    const entries = providerWindowEntries(
      wire({
        provider: "claude-code",
        available: true,
        subscriptionType: null,
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        modelScoped: [
          {
            displayName: "Fable",
            usedPercent: 10,
            resetsAt: null,
            durationMinutes: null,
          },
          {
            displayName: "Fable",
            usedPercent: 90,
            resetsAt: null,
            durationMinutes: null,
          },
          {
            displayName: "Fable",
            usedPercent: 5,
            resetsAt: null,
            durationMinutes: null,
          },
          {
            displayName: "Opus 5",
            usedPercent: 1,
            resetsAt: null,
            durationMinutes: null,
          },
        ],
        extraUsage: null,
      }),
    );

    expect(
      entries.map((entry) => [
        entry.windowKey,
        entry.label,
        entry.window.usedPercent,
      ]),
    ).toEqual([
      ["claude-code:model:Fable", "Fable", 10],
      ["claude-code:model:Fable#2", "Fable", 90],
      ["claude-code:model:Fable#3", "Fable", 5],
      ["claude-code:model:Opus 5", "Opus 5", 1],
    ]);
  });

  // A generated suffix must never land on a name the provider already reports
  // literally, so every raw key is reserved before any suffix is handed out.
  it("skips a generated suffix a raw model name already occupies", () => {
    const entries = providerWindowEntries(
      wire({
        provider: "claude-code",
        available: true,
        subscriptionType: null,
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        modelScoped: [
          modelWindow("Fable", 10),
          modelWindow("Fable#2", 20),
          modelWindow("Fable", 30),
          modelWindow("Fable", 40),
        ],
        extraUsage: null,
      }),
    );

    expect(
      entries.map((item) => [item.windowKey, item.window.usedPercent]),
    ).toEqual([
      ["claude-code:model:Fable", 10],
      ["claude-code:model:Fable#2", 20],
      ["claude-code:model:Fable#3", 30],
      ["claude-code:model:Fable#4", 40],
    ]);
  });

  // Nothing on the wire forbids two `extraWindows` entries sharing a limit id,
  // and the allocator covers a provider's whole list, not just model windows.
  it("gives duplicate Codex limit ids distinct keys", () => {
    const entries = providerWindowEntries(
      wire({
        provider: "codex",
        available: true,
        planType: null,
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        extraWindows: [
          {
            limitId: "shared",
            limitName: "First",
            primary: windowOf(1, 1_800_000, 300),
            secondary: windowOf(2, 2_000_000, 10_080),
          },
          {
            limitId: "shared",
            limitName: "Second",
            primary: windowOf(3, 1_800_000, 300),
            secondary: windowOf(4, 2_000_000, 10_080),
          },
        ],
        credits: null,
        individualLimit: null,
        resetCredits: null,
        rateLimitReachedType: null,
      }),
    );

    expect(
      entries.map((item) => [
        item.windowKey,
        item.label,
        item.window.usedPercent,
      ]),
    ).toEqual([
      ["codex:extra:shared:primary", "First 5h", 1],
      ["codex:extra:shared:secondary", "First wk", 2],
      ["codex:extra:shared:primary#2", "Second 5h", 3],
      ["codex:extra:shared:secondary#2", "Second wk", 4],
    ]);
  });

  it("keeps keys unique when raw suffixes and repeats are mixed", () => {
    const entries = providerWindowEntries(
      wire({
        provider: "claude-code",
        available: true,
        subscriptionType: null,
        fiveHour: windowOf(5, 1_800_000, 300),
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        modelScoped: [
          modelWindow("Fable", 10),
          modelWindow("Fable", 20),
          modelWindow("Fable#2", 30),
          modelWindow("Opus 5", 40),
          modelWindow("Fable", 50),
          modelWindow("Opus 5", 60),
        ],
        extraUsage: null,
      }),
    );

    const keys = entries.map((item) => item.windowKey);
    expect(keys).toEqual([
      "claude-code:fiveHour",
      "claude-code:model:Fable",
      "claude-code:model:Fable#3",
      "claude-code:model:Fable#2",
      "claude-code:model:Opus 5",
      "claude-code:model:Fable#4",
      "claude-code:model:Opus 5#2",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    // Labels stay the provider's own; only the key disambiguates.
    expect(entries.map((item) => item.label)).toEqual([
      "5h",
      "Fable",
      "Fable",
      "Fable#2",
      "Opus 5",
      "Fable",
      "Opus 5",
    ]);
  });

  it("omits a Claude Code window the payload did not carry", () => {
    const entries = providerWindowEntries(
      wire({
        provider: "claude-code",
        available: true,
        subscriptionType: null,
        fiveHour: windowOf(33, 1_800_000, 300),
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        modelScoped: [],
        extraUsage: null,
      }),
    );

    expect(entries.map((entry) => entry.windowKey)).toEqual([
      "claude-code:fiveHour",
    ]);
  });

  it("labels Codex windows from the durations the payload reports", () => {
    expect(
      providerWindowEntries(CODEX).map((entry) => [
        entry.windowKey,
        entry.label,
        entry.kind,
      ]),
    ).toEqual([
      ["codex:primary", "5h", "session"],
      ["codex:secondary", "wk", "weekly"],
      ["codex:extra:gpt-5-codex:primary", "GPT-5 Codex 5h", "session"],
      ["codex:extra:gpt-5-codex:secondary", "GPT-5 Codex wk", "weekly"],
    ]);
  });

  it("labels an unnamed Codex extra limit by its duration alone", () => {
    const entries = providerWindowEntries(
      wire({
        provider: "codex",
        available: true,
        planType: null,
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        extraWindows: [
          {
            limitId: "unnamed",
            limitName: null,
            primary: windowOf(1, 1_800_000, 360),
            secondary: null,
          },
        ],
        credits: null,
        individualLimit: null,
        resetCredits: null,
        rateLimitReachedType: null,
      }),
    );

    expect(entries.map((entry) => [entry.windowKey, entry.label])).toEqual([
      ["codex:extra:unnamed:primary", "6h"],
    ]);
  });

  it("names the three OpenCode windows statically", () => {
    expect(
      providerWindowEntries(OPENCODE).map((entry) => [
        entry.windowKey,
        entry.label,
        entry.kind,
      ]),
    ).toEqual([
      ["opencode:fiveHour", "5h", "session"],
      ["opencode:weekly", "wk", "weekly"],
      ["opencode:monthly", "mo", "monthly"],
    ]);
  });

  it("labels grok's billing period with the period type it reports", () => {
    expect(
      providerWindowEntries(GROK).map((entry) => [
        entry.windowKey,
        entry.label,
        entry.kind,
      ]),
    ).toEqual([["grok:period", "monthly", "period"]]);
  });

  it("falls back to a generic period label when grok names no period type", () => {
    const entries = providerWindowEntries(
      wire({
        provider: "grok",
        available: true,
        subscriptionTier: null,
        periodType: null,
        periodStart: null,
        periodEnd: 2_000_000,
        period: windowOf(44, 2_000_000, null),
        monthlyLimit: null,
        onDemandCap: null,
        onDemandUsed: null,
        prepaidBalance: null,
      }),
    );

    expect(entries.map((entry) => entry.label)).toEqual(["period"]);
  });

  it("has no grok entry when the period went unmeasured", () => {
    expect(
      providerWindowEntries(
        wire({
          provider: "grok",
          available: true,
          subscriptionTier: "premium",
          periodType: "monthly",
          periodStart: 1_000_000,
          periodEnd: 2_000_000,
          period: null,
          monthlyLimit: null,
          onDemandCap: null,
          onDemandUsed: null,
          prepaidBalance: null,
        }),
      ),
    ).toEqual([]);
  });

  it("names Cursor's two spending buckets", () => {
    expect(
      providerWindowEntries(CURSOR).map((entry) => [
        entry.windowKey,
        entry.label,
        entry.kind,
      ]),
    ).toEqual([
      ["cursor:cursorModels", "Cursor models", "bucket"],
      ["cursor:otherModels", "Other models", "bucket"],
    ]);
  });

  // Credit providers report money, never a percentage of a rolling window -
  // the same reason the protocol's own window accessor returns nothing.
  it.each([
    ["openrouter", OPENROUTER],
    ["kilocode", KILOCODE],
    ["huggingface", HUGGINGFACE],
  ])("has no entries for the credit provider %s", (_label, rateLimits) => {
    expect(providerWindowEntries(rateLimits)).toEqual([]);
  });

  it("has no entries for a snapshot that failed to read", () => {
    expect(providerWindowEntries(UNAVAILABLE)).toEqual([]);
  });

  // The catalog adds identity and copy on top of the protocol's window list;
  // it must never add or drop a window relative to it.
  it.each([
    ["claude-code", CLAUDE_CODE],
    ["codex", CODEX],
    ["opencode", OPENCODE],
    ["grok", GROK],
    ["cursor", CURSOR],
    ["openrouter", OPENROUTER],
    ["kilocode", KILOCODE],
    ["huggingface", HUGGINGFACE],
    ["unavailable", UNAVAILABLE],
  ])(
    "carries exactly the windows the protocol reports for %s",
    (_label, rateLimits) => {
      expect(
        providerWindowEntries(rateLimits).map((entry) => entry.window),
      ).toEqual(providerRateLimitWindows(rateLimits));
    },
  );

  it("emits a unique key per window", () => {
    for (const rateLimits of [CLAUDE_CODE, CODEX, OPENCODE, GROK, CURSOR]) {
      const keys = providerWindowEntries(rateLimits).map(
        (entry) => entry.windowKey,
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  // `labelIsDuration` exists for one reason: a live countdown may only REPLACE
  // a label that says nothing but the window's length. Every window whose name
  // also carries identity - a model, a qualified weekly, a Cursor bucket, a
  // named Codex limit, a Grok billing period - must keep that name beside the
  // countdown instead, because several of them are guaranteed to share one
  // reset instant with a sibling.
  describe("labelIsDuration", () => {
    it("is true for Claude Code's plain-duration windows, false for the qualified weeklies and every model window", () => {
      const byKey = new Map(
        providerWindowEntries(CLAUDE_CODE).map((entry) => [
          entry.windowKey,
          entry.labelIsDuration,
        ]),
      );
      expect(byKey.get("claude-code:fiveHour")).toBe(true);
      expect(byKey.get("claude-code:sevenDay")).toBe(true);
      expect(byKey.get("claude-code:sevenDayOpus")).toBe(false);
      expect(byKey.get("claude-code:sevenDaySonnet")).toBe(false);
      expect(byKey.get("claude-code:model:Fable")).toBe(false);
      expect(byKey.get("claude-code:model:Opus 5")).toBe(false);
    });

    it("is true for Codex's base windows, false for a named extra, true for an extra whose limit went unnamed", () => {
      const byKey = new Map(
        providerWindowEntries(CODEX).map((entry) => [
          entry.windowKey,
          entry.labelIsDuration,
        ]),
      );
      expect(byKey.get("codex:primary")).toBe(true);
      expect(byKey.get("codex:secondary")).toBe(true);
      expect(byKey.get("codex:extra:gpt-5-codex:primary")).toBe(false);
      expect(byKey.get("codex:extra:gpt-5-codex:secondary")).toBe(false);

      const unnamedExtra = providerWindowEntries(
        wire({
          provider: "codex",
          available: true,
          planType: null,
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          extraWindows: [
            {
              limitId: "unnamed",
              limitName: null,
              primary: windowOf(1, 1_800_000, 360),
              secondary: null,
            },
          ],
          credits: null,
          individualLimit: null,
          resetCredits: null,
          rateLimitReachedType: null,
        }),
      );
      expect(unnamedExtra).toEqual([
        expect.objectContaining({
          windowKey: "codex:extra:unnamed:primary",
          labelIsDuration: true,
        }),
      ]);
    });

    it("is true for every OpenCode window", () => {
      const entries = providerWindowEntries(OPENCODE);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.labelIsDuration)).toBe(true);
    });

    it("is false for grok's billing period - there is no generic short form for a duration the payload never states", () => {
      const entries = providerWindowEntries(GROK);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => !entry.labelIsDuration)).toBe(true);
    });

    it("is false for both of Cursor's spending buckets - the wire requires them to share one reset instant", () => {
      const entries = providerWindowEntries(CURSOR);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => !entry.labelIsDuration)).toBe(true);
    });
  });
});
