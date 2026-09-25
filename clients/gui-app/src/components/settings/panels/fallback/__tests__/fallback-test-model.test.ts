import { describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  findTierConflicts,
  type FallbackPolicy,
  type TierCandidate,
  type TierCandidatePreview,
  type TierGroup,
  type TierModelIdentity,
} from "@traycer/protocol/host/fallback-policy";
import type { GuiAgentModelOption } from "@traycer/protocol/host/index";
import type { HarnessId } from "@traycer/protocol/host/agent/shared";
import {
  blockedModelLabel,
  testNextSteps,
  testPreviewForTier,
  testRouting,
  testRows,
  testableTierNames,
} from "@/components/settings/panels/fallback/fallback-test-model";
import type { FallbackCatalogOptions } from "@/components/settings/panels/fallback/fallback-catalog-options";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";

/**
 * Every case here must FAIL if the production line it is named after is
 * reverted - see the per-test comment naming that line.
 */

function candidate(
  harnessId: TierCandidate["harnessId"],
  modelFamily: string,
  reasoningEffort: string | null,
): TierCandidate {
  return { harnessId, modelFamily, reasoningEffort };
}

function group(id: string, candidates: readonly TierCandidate[]): TierGroup {
  return { id, candidates: [...candidates] };
}

/** Codex's live catalog (spec §What the live catalogs say), title-cased IDs. */
const CODEX_CATALOG: readonly TierModelIdentity[] = [
  { slug: "gpt-6-astra", label: "GPT-6-Astra" },
  { slug: "gpt-6-sol", label: "GPT-6-Sol" },
  { slug: "gpt-6-luna", label: "GPT-6-Luna" },
  { slug: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  { slug: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
  { slug: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  { slug: "gpt-5.5", label: "GPT-5.5" },
];

const CLAUDE_CATALOG: readonly TierModelIdentity[] = [
  { slug: "default", label: "Default (Opus 5.5)" },
  { slug: "opus[1m]", label: "Opus 5.5 (1M context)" },
  { slug: "claude-fable-5-1[1m]", label: "Fable 5.1 (1M context)" },
  { slug: "sonnet", label: "Sonnet 5" },
  { slug: "haiku", label: "Haiku" },
];

function model(
  harnessId: GuiAgentModelOption["harnessId"],
  slug: string,
  label: string,
): GuiAgentModelOption {
  return {
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

/** The seed's flagship tier, in wireframe row order: opus, sol, grok. */
const FLAGSHIP_TIER: TierGroup = group("flagship", [
  candidate("claude", "*opus*", "high"),
  candidate("codex", "*sol*", "high"),
  candidate("grok", "*grok*", null),
]);

const FRONTIER_TIER: TierGroup = group("frontier", [
  candidate("codex", "*astra*", "high"),
]);

const STANDARD_TIER: TierGroup = group("standard", [
  candidate("claude", "*sonnet*", null),
]);

describe("testRouting", () => {
  // `routeTierGroupForFailedTuple` / `findTierGroupForFailedTuple` are the
  // lines under test here - drop either call and this fails.
  it("Codex GPT-6-Sol routes to own-tier flagship, row index 1, value *sol*", () => {
    const groups = [FRONTIER_TIER, FLAGSHIP_TIER, STANDARD_TIER];
    const routing = testRouting({
      groups,
      defaultTierGroupId: "flagship",
      harnessId: "codex",
      model: "gpt-6-sol",
      catalog: CODEX_CATALOG,
      conflicts: [],
    });
    expect(routing.kind).toBe("own-tier");
    if (routing.kind !== "own-tier") throw new Error("unreachable");
    expect(routing.tier.tierIndex).toBe(1);
    expect(routing.tier.tierId).toBe("flagship");
    expect(routing.candidateIndex).toBe(1);
    expect(routing.rowValue).toBe("*sol*");
    expect(routing.conflict).toBeNull();
  });

  // The `own === null` branch (`kind: "default-tier"`) - GPT-5.5 matches no
  // row, so the default tier decides. Falls to "no-tier" if the default
  // fallback line is dropped.
  it("Codex GPT-5.5 routes to default-tier flagship", () => {
    const groups = [FRONTIER_TIER, FLAGSHIP_TIER, STANDARD_TIER];
    const routing = testRouting({
      groups,
      defaultTierGroupId: "flagship",
      harnessId: "codex",
      model: "gpt-5.5",
      catalog: CODEX_CATALOG,
      conflicts: [],
    });
    expect(routing.kind).toBe("default-tier");
    if (routing.kind !== "default-tier") throw new Error("unreachable");
    expect(routing.tier.tierId).toBe("flagship");
  });

  // `defaultTierGroupId: null` - the `routed === null` branch.
  it("with defaultTierGroupId null, Claude Haiku is no-tier", () => {
    const groups = [FRONTIER_TIER, FLAGSHIP_TIER, STANDARD_TIER];
    const routing = testRouting({
      groups,
      defaultTierGroupId: null,
      harnessId: "claude",
      model: "haiku",
      catalog: CLAUDE_CATALOG,
      conflicts: [],
    });
    expect(routing).toEqual({ kind: "no-tier", defaultTierGroupId: null });
  });

  // The `conflict` lookup - `conflicts.find(...)` mapped to `TestTierClaim[]`
  // with the first-listed handler leading. Built through the real
  // `findTierConflicts`, so this also pins that the two stay in agreement.
  it("a conflict (frontier *gpt* vs standard's exact gpt-5.6-terra) gives own-tier frontier with conflict[0] as the handler", () => {
    const frontier = group("frontier", [candidate("codex", "*gpt*", "high")]);
    const standard = group("standard", [
      candidate("codex", "gpt-5.6-terra", "medium"),
    ]);
    const groups = [frontier, standard];
    const catalogsByHarness = new Map<HarnessId, readonly TierModelIdentity[]>([
      ["codex", CODEX_CATALOG],
    ]);
    const conflicts = findTierConflicts(groups, catalogsByHarness);
    expect(conflicts).not.toHaveLength(0);

    const routing = testRouting({
      groups,
      defaultTierGroupId: null,
      harnessId: "codex",
      model: "gpt-5.6-terra",
      catalog: CODEX_CATALOG,
      conflicts,
    });
    expect(routing.kind).toBe("own-tier");
    if (routing.kind !== "own-tier") throw new Error("unreachable");
    expect(routing.tier.tierId).toBe("frontier");
    expect(routing.conflict).not.toBeNull();
    expect(routing.conflict?.[0]).toMatchObject({
      tierIndex: 0,
      tierId: "frontier",
    });
    expect(routing.conflict?.[1]).toMatchObject({
      tierIndex: 1,
      tierId: "standard",
    });
  });
});

function policyWith(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), ...overrides };
}

describe("testNextSteps", () => {
  // `effectiveLadderFor(policy, "rate_limit")` - reads the per-reason
  // override rather than the base ladder for a rate limit.
  it("the rate-limit override overrides the base ladder", () => {
    const policy = policyWith({
      ladder: ["profile", "wait", "notify"],
      reasonOverrides: { rate_limit: ["tier", "notify"] },
    });
    const result = testNextSteps(policy, "rate_limit");
    expect(result).toEqual({ kind: "after-tier", steps: ["notify"] });
  });

  // `ladder === "off"` - the override can turn the whole step chain off.
  it('"off" produces fallback-off', () => {
    const policy = policyWith({
      reasonOverrides: { rate_limit: "off" },
    });
    expect(testNextSteps(policy, "rate_limit")).toEqual({
      kind: "fallback-off",
    });
  });

  // `stepRunsFor` - "another error" drops `wait`, which has no reset
  // boundary to wait on for a non-rate-limit failure.
  it('wait is dropped for "other"', () => {
    const policy = policyWith({
      ladder: ["profile", "tier", "wait", "notify"],
    });
    const result = testNextSteps(policy, "other");
    expect(result.kind).not.toBe("fallback-off");
    if (result.kind === "fallback-off") throw new Error("unreachable");
    expect(result.steps).not.toContain("wait");
  });

  // `endingAtNotify` - a ladder with no `notify` gets one appended.
  it("Notify is appended when the ladder has none", () => {
    const policy = policyWith({ ladder: ["profile"] });
    const result = testNextSteps(policy, "other");
    expect(result.kind).toBe("tier-off");
    if (result.kind === "fallback-off") throw new Error("unreachable");
    expect(result.steps).toEqual(["profile", "notify"]);
  });

  // `endingAtNotify` - truncation. `tier` is LISTED after an early `notify`
  // but never runs, because the chain already ended.
  it("truncation after an early Notify: a later tier step never runs", () => {
    const policy = policyWith({ ladder: ["notify", "tier", "wait"] });
    const result = testNextSteps(policy, "rate_limit");
    expect(result).toEqual({ kind: "tier-off", steps: ["notify"] });
  });

  // `tierAt === -1` - the equivalent-model step is simply absent from the
  // ladder.
  it("tier-off when the ladder has no tier step at all", () => {
    const policy = policyWith({ ladder: ["profile", "wait", "notify"] });
    const result = testNextSteps(policy, "rate_limit");
    expect(result).toEqual({
      kind: "tier-off",
      steps: ["profile", "wait", "notify"],
    });
  });
});

function catalogFixture(
  byHarness: ReadonlyMap<
    TierCandidate["harnessId"],
    readonly GuiAgentModelOption[]
  >,
): FallbackCatalogOptions {
  return {
    modelsFor: (harnessId) => byHarness.get(harnessId) ?? [],
    catalogFor: (harnessId) => byHarness.get(harnessId) ?? null,
    catalogsByHarness: byHarness,
    effortsFor: () => [],
  };
}

function emptyCatalog(): FallbackCatalogOptions {
  return catalogFixture(new Map());
}

const LABEL_FOR: FallbackSettingsProfileLabel = (profileId) =>
  `Account ${profileId}`;

type TierCandidatePreviewMatch = TierCandidatePreview["matches"][number];

function previewRow(input: {
  readonly groupId: string;
  readonly candidateIndex: number;
  readonly harnessId: TierCandidate["harnessId"];
  readonly modelFamily: string;
  readonly matches: readonly TierCandidatePreviewMatch[];
}): TierCandidatePreview {
  return {
    groupId: input.groupId,
    candidateIndex: input.candidateIndex,
    harnessId: input.harnessId,
    modelFamily: input.modelFamily,
    reasoningEffort: null,
    resolvedModel:
      input.matches.find((match) => match.skipReason === null)?.model ?? null,
    profileId: null,
    skipReason: input.matches.length === 0 ? "family-unmatched" : null,
    skipLabel:
      input.matches.length === 0 ? "no model matches this pattern" : null,
    warnings: [],
    matches: [...input.matches],
  };
}

function match(
  slug: string,
  skipReason: string | null,
  skipLabel: string | null,
  profileId: string | null,
): TierCandidatePreviewMatch {
  return { model: slug, profileId, skipReason, skipLabel };
}

describe("testRows", () => {
  const codexModels = [
    model("codex", "gpt-6-sol", "GPT-6-Sol"),
    model("codex", "gpt-5.6-sol", "GPT-5.6-Sol"),
    model("codex", "grok-4.7", "Grok 4.7"),
  ];

  // The `winnerFound` guard - "switches" is awarded to the first usable match
  // ACROSS ROWS, never once per row.
  it('"switches here" goes only to the first usable match across rows; the rest are "then"', () => {
    const tier: TierGroup = group("flagship", [
      candidate("claude", "*opus*", "high"),
      candidate("codex", "*sol*", "high"),
    ]);
    const preview: readonly TierCandidatePreview[] = [
      previewRow({
        groupId: "flagship",
        candidateIndex: 0,
        harnessId: "claude",
        modelFamily: "*opus*",
        matches: [
          match("default", null, null, null),
          match("opus[1m]", null, null, null),
        ],
      }),
      previewRow({
        groupId: "flagship",
        candidateIndex: 1,
        harnessId: "codex",
        modelFamily: "*sol*",
        matches: [match("gpt-6-sol", null, null, null)],
      }),
    ];
    const rows = testRows({
      tier,
      preview,
      simulated: true,
      catalog: emptyCatalog(),
      labelFor: LABEL_FOR,
    });
    expect(rows[0].answer.kind).toBe("matches");
    expect(rows[1].answer.kind).toBe("matches");
    if (
      rows[0].answer.kind !== "matches" ||
      rows[1].answer.kind !== "matches"
    ) {
      throw new Error("unreachable");
    }
    expect(rows[0].answer.lines.map((line) => line.status)).toEqual([
      "switches",
      "then",
    ]);
    expect(rows[1].answer.lines.map((line) => line.status)).toEqual(["then"]);
  });

  // `SKIP_PRESENTATION["same-as-failed"]` - copy is overridden to the
  // panel's own wording, tone neutral.
  it('same-as-failed shows "skipped · the blocked model" with a neutral tone', () => {
    const tier: TierGroup = group("flagship", [
      candidate("codex", "*sol*", "high"),
    ]);
    const preview: readonly TierCandidatePreview[] = [
      previewRow({
        groupId: "flagship",
        candidateIndex: 0,
        harnessId: "codex",
        modelFamily: "*sol*",
        matches: [
          match(
            "gpt-6-sol",
            "same-as-failed",
            "same model that just failed",
            null,
          ),
          match(
            "gpt-5.6-sol",
            "rate-limited",
            "same account, no headroom after a rate limit",
            null,
          ),
        ],
      }),
    ];
    const rows = testRows({
      tier,
      preview,
      simulated: true,
      catalog: catalogFixture(new Map([["codex", codexModels]])),
      labelFor: LABEL_FOR,
    });
    const answer = rows[0].answer;
    expect(answer.kind).toBe("matches");
    if (answer.kind !== "matches") throw new Error("unreachable");
    expect(answer.lines[0].skip).toEqual({
      text: "skipped · the blocked model",
      tone: "neutral",
    });
    // `rate-limited` renders the HOST's label, tone warning.
    expect(answer.lines[1].skip).toEqual({
      text: "skipped · same account, no headroom after a rate limit",
      tone: "warning",
    });
  });

  // `UNKNOWN_SKIP_TONE` - a reason this build's schema has never heard of
  // still renders (the host's label), toned as environmental.
  it("an unknown reason shows the host label with a warning tone", () => {
    const tier: TierGroup = group("flagship", [
      candidate("codex", "*sol*", "high"),
    ]);
    const preview: readonly TierCandidatePreview[] = [
      previewRow({
        groupId: "flagship",
        candidateIndex: 0,
        harnessId: "codex",
        modelFamily: "*sol*",
        matches: [
          match(
            "gpt-6-sol",
            "a-reason-this-build-has-never-heard-of",
            "brand new reason",
            null,
          ),
        ],
      }),
    ];
    const rows = testRows({
      tier,
      preview,
      simulated: true,
      catalog: catalogFixture(new Map([["codex", codexModels]])),
      labelFor: LABEL_FOR,
    });
    const answer = rows[0].answer;
    expect(answer.kind).toBe("matches");
    if (answer.kind !== "matches") throw new Error("unreachable");
    expect(answer.lines[0].skip).toEqual({
      text: "skipped · brand new reason",
      tone: "warning",
    });
  });

  // `SKIP_PRESENTATION["family-unmatched"]` - the one row-level verdict that
  // is the user's to fix, so it is destructive.
  it("family-unmatched is destructive", () => {
    const tier: TierGroup = group("flagship", [
      candidate("codex", "*spark*", "high"),
    ]);
    const preview: readonly TierCandidatePreview[] = [
      previewRow({
        groupId: "flagship",
        candidateIndex: 0,
        harnessId: "codex",
        modelFamily: "*spark*",
        matches: [],
      }),
    ];
    const rows = testRows({
      tier,
      preview,
      simulated: true,
      catalog: catalogFixture(new Map([["codex", codexModels]])),
      labelFor: LABEL_FOR,
    });
    const answer = rows[0].answer;
    expect(answer.kind).toBe("skipped");
    if (answer.kind !== "skipped") throw new Error("unreachable");
    expect(answer.skip.tone).toBe("destructive");
    expect(answer.skip.text).toBe("skipped · no model matches this pattern");
  });

  // `BLANK_ROW_SKIP` - drawn from the DRAFT (`value === ""`), never from the
  // host's answer, and always neutral.
  it('a blank row shows "blank, skipped"', () => {
    const tier: TierGroup = group("flagship", [candidate("codex", "", "high")]);
    const rows = testRows({
      tier,
      preview: [],
      simulated: true,
      catalog: emptyCatalog(),
      labelFor: LABEL_FOR,
    });
    const answer = rows[0].answer;
    expect(answer.kind).toBe("skipped");
    if (answer.kind !== "skipped") throw new Error("unreachable");
    expect(answer.skip).toEqual({ text: "blank, skipped", tone: "neutral" });
  });

  // `MATCHES_NAMED` cap and the "never cut the winner" `Math.max` guard.
  it('rows cap at 2 plus "N more", but never cut the winner', () => {
    const tier: TierGroup = group("flagship", [
      candidate("grok", "*grok*", null),
    ]);
    // The winner is the THIRD match: two skipped ahead of it.
    const preview: readonly TierCandidatePreview[] = [
      previewRow({
        groupId: "flagship",
        candidateIndex: 0,
        harnessId: "grok",
        modelFamily: "*grok*",
        matches: [
          match("grok-4.7", "provider-unavailable", "unavailable", null),
          match(
            "grok-4.7-build-fast",
            "provider-unavailable",
            "unavailable",
            null,
          ),
          match("grok-4.6", null, null, null),
          match("grok-4.5", null, null, null),
        ],
      }),
    ];
    const rows = testRows({
      tier,
      preview,
      simulated: true,
      catalog: emptyCatalog(),
      labelFor: LABEL_FOR,
    });
    const answer = rows[0].answer;
    expect(answer.kind).toBe("matches");
    if (answer.kind !== "matches") throw new Error("unreachable");
    // Named through the winner (index 2), so 3 lines are shown, 1 left over.
    expect(answer.lines).toHaveLength(3);
    expect(answer.lines[2].status).toBe("switches");
    expect(answer.more).toBe(1);
  });

  // The `!simulated` branch: only the first match shows, status "listed",
  // never "switches" - nothing was simulated, so nothing is claimed.
  it("in unsimulated mode only the first match shows, with status listed and no switches", () => {
    const tier: TierGroup = group("flagship", [
      candidate("codex", "*sol*", "high"),
    ]);
    const preview: readonly TierCandidatePreview[] = [
      previewRow({
        groupId: "flagship",
        candidateIndex: 0,
        harnessId: "codex",
        modelFamily: "*sol*",
        matches: [
          match("gpt-6-sol", null, null, null),
          match("gpt-5.6-sol", null, null, null),
        ],
      }),
    ];
    const rows = testRows({
      tier,
      preview,
      simulated: false,
      catalog: catalogFixture(new Map([["codex", codexModels]])),
      labelFor: LABEL_FOR,
    });
    const answer = rows[0].answer;
    expect(answer.kind).toBe("matches");
    if (answer.kind !== "matches") throw new Error("unreachable");
    expect(answer.lines).toHaveLength(1);
    expect(answer.lines[0].status).toBe("listed");
    expect(answer.lines.some((line) => line.status === "switches")).toBe(false);
  });

  // The `row === null` branch: the host said nothing about this row.
  it("a missing row is unanswered", () => {
    const tier: TierGroup = group("flagship", [
      candidate("codex", "*sol*", "high"),
    ]);
    const rows = testRows({
      tier,
      preview: [],
      simulated: true,
      catalog: emptyCatalog(),
      labelFor: LABEL_FOR,
    });
    expect(rows[0].answer).toEqual({ kind: "unanswered" });
  });
});

describe("testPreviewForTier", () => {
  // The `shared` guard - a tier name another tier currently shares withholds
  // the answer rather than pairing a row with the wrong tier's verdicts.
  it("withholds when a tier name is shared", () => {
    const groups: readonly TierGroup[] = [group("dup", []), group("dup", [])];
    const candidates: readonly TierCandidatePreview[] = [
      previewRow({
        groupId: "dup",
        candidateIndex: 0,
        harnessId: "codex",
        modelFamily: "*sol*",
        matches: [],
      }),
    ];
    expect(testPreviewForTier(candidates, groups, 0)).toBeNull();
  });

  it("passes through the tier's own rows when the name is unique", () => {
    const groups: readonly TierGroup[] = [
      group("flagship", []),
      group("standard", []),
    ];
    const flagshipRow = previewRow({
      groupId: "flagship",
      candidateIndex: 0,
      harnessId: "codex",
      modelFamily: "*sol*",
      matches: [],
    });
    const standardRow = previewRow({
      groupId: "standard",
      candidateIndex: 0,
      harnessId: "codex",
      modelFamily: "*terra*",
      matches: [],
    });
    const result = testPreviewForTier([flagshipRow, standardRow], groups, 0);
    expect(result).toEqual([flagshipRow]);
  });

  it("passes null candidates through as null", () => {
    const groups: readonly TierGroup[] = [group("flagship", [])];
    expect(testPreviewForTier(null, groups, 0)).toBeNull();
  });
});

describe("testableTierNames", () => {
  it("rejects a blank name", () => {
    expect(testableTierNames([group("", [])])).toBe(false);
  });

  it("rejects a duplicate name", () => {
    expect(
      testableTierNames([group("flagship", []), group("flagship", [])]),
    ).toBe(false);
  });

  it("accepts distinct, non-blank names", () => {
    expect(
      testableTierNames([group("flagship", []), group("standard", [])]),
    ).toBe(true);
  });
});

describe("blockedModelLabel", () => {
  it("returns the catalog's display name when the model is listed", () => {
    expect(blockedModelLabel("gpt-6-sol", CODEX_CATALOG)).toBe("GPT-6-Sol");
  });

  it("returns the id itself when there is no catalog", () => {
    expect(blockedModelLabel("gpt-6-sol", null)).toBe("gpt-6-sol");
  });

  it("returns the id itself when the catalog does not list it", () => {
    expect(blockedModelLabel("unknown-model", CODEX_CATALOG)).toBe(
      "unknown-model",
    );
  });
});
