import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FallbackPolicy,
  TierCandidatePreview,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  createDefaultFallbackPolicy,
  findTierConflicts,
} from "@traycer/protocol/host/fallback-policy";
import type { GuiAgentModelOption } from "@traycer/protocol/host/index";
import type {
  GuiHarnessId,
  HarnessId,
} from "@traycer/protocol/host/agent/shared";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { chatRunSettings } from "@/components/chat/fallback/__tests__/fallback-fixtures";
import type { FallbackCatalogOptions } from "@/components/settings/panels/fallback/fallback-catalog-options";
import type { FallbackPolicyTestTierGroupsRequest } from "@/hooks/providers/use-fallback-policy-test-tier-groups-query";
import type { FallbackTestModelPanelProps } from "@/components/settings/panels/fallback/fallback-test-model-panel";

/**
 * Panel-level coverage for the Test a model panel (ticket 05, clauses 2-6):
 * the request built from defaults, the wireframe 4 fixture's rendering, the
 * three footers, the older-host fallback, and the announced verdict.
 *
 * `FallbackTestModelPanel` is rendered directly (not through the whole
 * editor), with every host-backed hook it calls mocked at its own module
 * boundary - the same pattern `fallback-settings-panel-preview.test.tsx` uses
 * for the sibling preview hook.
 */

// `globals: false` in vitest.config.ts means RTL's automatic cleanup never
// registers - every suite that renders must call this itself.
afterEach(() => {
  cleanup();
});

interface HarnessFixture {
  readonly id: GuiHarnessId;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly supportedPermissionModes: readonly (
    | "supervised"
    | "auto_accept_edits"
    | "auto"
    | "full_access"
  )[];
}

const ALL_PERMISSION_MODES = [
  "supervised",
  "auto_accept_edits",
  "auto",
  "full_access",
] as const;

const HARNESSES: readonly HarnessFixture[] = [
  {
    id: "claude",
    available: true,
    enabled: true,
    supportedPermissionModes: ALL_PERMISSION_MODES,
  },
  {
    id: "codex",
    available: true,
    enabled: true,
    supportedPermissionModes: ALL_PERMISSION_MODES,
  },
  {
    id: "grok",
    available: true,
    enabled: true,
    supportedPermissionModes: ALL_PERMISSION_MODES,
  },
];

function guiModel(
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

const CLAUDE_MODELS: readonly GuiAgentModelOption[] = [
  guiModel("claude", "default", "Default (Opus 5.5)"),
  guiModel("claude", "opus[1m]", "Opus 5.5 (1M context)"),
  guiModel("claude", "claude-fable-5-1[1m]", "Fable 5.1 (1M context)"),
  guiModel("claude", "sonnet", "Sonnet 5"),
  guiModel("claude", "haiku", "Haiku"),
];

const CODEX_MODELS: readonly GuiAgentModelOption[] = [
  guiModel("codex", "gpt-6-astra", "GPT-6-Astra"),
  guiModel("codex", "gpt-6-sol", "GPT-6-Sol"),
  guiModel("codex", "gpt-6-luna", "GPT-6-Luna"),
  guiModel("codex", "gpt-5.6-sol", "GPT-5.6-Sol"),
  guiModel("codex", "gpt-5.6-terra", "GPT-5.6-Terra"),
  guiModel("codex", "gpt-5.6-luna", "GPT-5.6-Luna"),
  guiModel("codex", "gpt-5.5", "GPT-5.5"),
];

const GROK_MODELS: readonly GuiAgentModelOption[] = [
  guiModel("grok", "grok-4.7", "Grok 4.7"),
  guiModel("grok", "grok-4.7-build-fast", "Grok 4.7 Build Fast"),
  guiModel("grok", "grok-4.6", "Grok 4.6"),
  guiModel("grok", "grok-4.5", "Grok 4.5"),
];

const MODELS_BY_HARNESS: ReadonlyMap<
  GuiHarnessId,
  readonly GuiAgentModelOption[]
> = new Map([
  ["claude", CLAUDE_MODELS],
  ["codex", CODEX_MODELS],
  ["grok", GROK_MODELS],
]);

const FLAGSHIP: TierGroup = {
  id: "flagship",
  candidates: [
    { harnessId: "claude", modelFamily: "*opus*", reasoningEffort: "high" },
    { harnessId: "codex", modelFamily: "*sol*", reasoningEffort: "high" },
    { harnessId: "grok", modelFamily: "*grok*", reasoningEffort: null },
  ],
};

const FRONTIER: TierGroup = {
  id: "frontier",
  candidates: [
    { harnessId: "claude", modelFamily: "*fable*", reasoningEffort: "high" },
    { harnessId: "codex", modelFamily: "*astra*", reasoningEffort: "high" },
  ],
};

const STANDARD: TierGroup = {
  id: "standard",
  candidates: [
    { harnessId: "claude", modelFamily: "*sonnet*", reasoningEffort: null },
    {
      harnessId: "codex",
      modelFamily: "*terra*",
      reasoningEffort: "medium",
    },
  ],
};

function seededPolicy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    enabled: true,
    tierGroups: [FRONTIER, FLAGSHIP, STANDARD],
    defaultTierGroupId: "flagship",
    ...overrides,
  };
}

function catalogFixture(): FallbackCatalogOptions {
  return {
    modelsFor: (harnessId) => MODELS_BY_HARNESS.get(harnessId) ?? [],
    catalogFor: (harnessId) => MODELS_BY_HARNESS.get(harnessId) ?? null,
    catalogsByHarness: MODELS_BY_HARNESS,
    effortsFor: () => [],
  };
}

/** The host's dry-run answer for Codex GPT-6-Sol, rate limit, flagship tier - wireframe 4's fixture. */
function wireframeFourCandidates(): readonly TierCandidatePreview[] {
  return [
    {
      groupId: "flagship",
      candidateIndex: 0,
      harnessId: "claude",
      modelFamily: "*opus*",
      reasoningEffort: "high",
      resolvedModel: "default",
      profileId: "profile-2",
      skipReason: null,
      skipLabel: null,
      warnings: [],
      matches: [
        {
          model: "default",
          profileId: "profile-2",
          skipReason: null,
          skipLabel: null,
        },
        {
          model: "opus[1m]",
          profileId: "profile-2",
          skipReason: null,
          skipLabel: null,
        },
      ],
    },
    {
      groupId: "flagship",
      candidateIndex: 1,
      harnessId: "codex",
      modelFamily: "*sol*",
      reasoningEffort: "high",
      resolvedModel: null,
      profileId: null,
      skipReason: null,
      skipLabel: null,
      warnings: [],
      matches: [
        {
          model: "gpt-6-sol",
          profileId: null,
          skipReason: "same-as-failed",
          skipLabel: "same model that just failed",
        },
        {
          model: "gpt-5.6-sol",
          profileId: "profile-3",
          skipReason: "rate-limited",
          skipLabel: "same account, no headroom after a rate limit",
        },
      ],
    },
    {
      groupId: "flagship",
      candidateIndex: 2,
      harnessId: "grok",
      modelFamily: "*grok*",
      reasoningEffort: null,
      resolvedModel: "grok-4.7",
      profileId: null,
      skipReason: null,
      skipLabel: null,
      warnings: [],
      matches: [
        {
          model: "grok-4.7",
          profileId: null,
          skipReason: null,
          skipLabel: null,
        },
        {
          model: "grok-4.7-build-fast",
          profileId: null,
          skipReason: null,
          skipLabel: null,
        },
        {
          model: "grok-4.6",
          profileId: null,
          skipReason: null,
          skipLabel: null,
        },
        {
          model: "grok-4.5",
          profileId: null,
          skipReason: null,
          skipLabel: null,
        },
      ],
    },
  ];
}

function providerProfile(input: {
  readonly profileId: string;
  readonly label: string;
}): ProviderProfile {
  return {
    profileId: input.profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: input.label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    launchCommand: null,
    reusedTombstone: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

const mocks = vi.hoisted(
  (): {
    testQuerySpy: (request: FallbackPolicyTestTierGroupsRequest | null) => void;
    testQueryData: TierCandidatePreview[] | null;
    testQueryFetching: boolean;
    testQueryError: boolean;
    /** The "last run" default the pickers seed from - Codex GPT-6-Sol unless a test overrides it. */
    lastRunModel: string;
    lastRunHarness: GuiHarnessId;
    /** The user's default service tier, as `settings-store` holds it - `""` means none picked. */
    defaultServiceTier: string;
    /** Each harness's last-used account, as `composer-harness-memory-store` holds it. */
    lastProfileByHarness: Partial<Record<GuiHarnessId, string | null>>;
    /** D2 - whether the tested provider's model catalog read failed. */
    modelsWarmupError: boolean;
    /** D2 - the retry the panel's "Try again" button calls; must return a Promise. */
    modelsWarmupRetry: () => Promise<void>;
    /** T4 - the Provider picker's options; overridable per test. */
    harnesses: readonly HarnessFixture[];
  } => ({
    testQuerySpy: () => {},
    testQueryData: null,
    testQueryFetching: false,
    testQueryError: false,
    lastRunModel: "gpt-6-sol",
    lastRunHarness: "codex",
    defaultServiceTier: "",
    lastProfileByHarness: { codex: "profile-2" },
    modelsWarmupError: false,
    modelsWarmupRetry: () => Promise.resolve(),
    // Set for real by `resetMocks()`, called before every test - `HARNESSES`
    // is declared after this hoisted factory runs and cannot be referenced
    // here.
    harnesses: [],
  }),
);

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: { harnesses: mocks.harnesses },
  }),
  useGuiHarnessModelsWarmup: (
    _client: unknown,
    harnessId: GuiHarnessId | null,
  ) => {
    if (harnessId === null) return [];
    if (mocks.modelsWarmupError) {
      return [
        { data: undefined, isError: true, refetch: mocks.modelsWarmupRetry },
      ];
    }
    const models = MODELS_BY_HARNESS.get(harnessId) ?? [];
    return [
      { data: { models }, isError: false, refetch: () => Promise.resolve() },
    ];
  },
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: {
      providers: [
        {
          providerId: "codex",
          profiles: [
            providerProfile({ profileId: "profile-2", label: "Personal 2" }),
            providerProfile({ profileId: "profile-3", label: "Work" }),
          ],
        },
        {
          // `providerCliIdForHarness("claude")` resolves to "claude-code",
          // not the harness id - see `lib/provider-ordering.ts`.
          providerId: "claude-code",
          profiles: [
            providerProfile({ profileId: "profile-2", label: "Personal 2" }),
            // The same account id Codex lists, so a pick carried across a
            // provider switch would still be on offer (T4).
            providerProfile({ profileId: "profile-3", label: "Work" }),
          ],
        },
        {
          providerId: "grok",
          profiles: [
            providerProfile({ profileId: "profile-2", label: "Personal 2" }),
          ],
        },
      ],
    },
  }),
}));

vi.mock(
  "@/stores/composer/composer-run-settings-store",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/composer/composer-run-settings-store")
      >();
    return {
      ...actual,
      useComposerRunSettingsStore: (
        selector: (input: {
          readonly globalLastRunSettingsByHostId: Record<
            string,
            ChatRunSettings
          >;
          readonly legacyGlobalLastRunSettings: null;
        }) => unknown,
      ) =>
        selector({
          globalLastRunSettingsByHostId: {
            "host-a": chatRunSettings({
              harnessId: mocks.lastRunHarness,
              model: mocks.lastRunModel,
              profileId: "profile-2",
            }),
          },
          legacyGlobalLastRunSettings: null,
        }),
    };
  },
);

vi.mock(
  "@/stores/composer/composer-harness-memory-store",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/composer/composer-harness-memory-store")
      >();
    return {
      ...actual,
      useComposerHarnessMemoryStore: (
        selector: (input: {
          readonly byHost: Record<string, never>;
          readonly legacy: {
            readonly lastProfileByHarness: Partial<
              Record<GuiHarnessId, string | null>
            >;
          };
        }) => unknown,
      ) =>
        selector({
          byHost: {},
          legacy: { lastProfileByHarness: mocks.lastProfileByHarness },
        }),
    };
  },
);

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (
    selector: (input: {
      readonly defaultPermission: "full_access";
      readonly defaultServiceTier: string;
    }) => unknown,
  ) =>
    selector({
      defaultPermission: "full_access",
      defaultServiceTier: mocks.defaultServiceTier,
    }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-test-tier-groups-query", () => ({
  useFallbackPolicyTestTierGroupsQuery: (
    request: FallbackPolicyTestTierGroupsRequest | null,
  ) => {
    mocks.testQuerySpy(request);
    return {
      data:
        mocks.testQueryData === null
          ? undefined
          : { candidates: mocks.testQueryData },
      isFetching: mocks.testQueryFetching,
      isError: mocks.testQueryError,
      refetch: () => {},
    };
  },
}));

import { FallbackTestModelPanel } from "@/components/settings/panels/fallback/fallback-test-model-panel";

function resetMocks(): void {
  mocks.testQuerySpy = () => {};
  mocks.testQueryData = null;
  mocks.testQueryFetching = false;
  mocks.testQueryError = false;
  mocks.lastRunModel = "gpt-6-sol";
  mocks.lastRunHarness = "codex";
  mocks.defaultServiceTier = "";
  mocks.lastProfileByHarness = { codex: "profile-2" };
  mocks.modelsWarmupError = false;
  mocks.modelsWarmupRetry = () => Promise.resolve();
  mocks.harnesses = HARNESSES;
}

function panelElement(overrides: {
  readonly policy?: FallbackPolicy;
  /** The tiers as last committed; the policy's own unless a test types ahead of them. */
  readonly committedTiers?: FallbackTestModelPanelProps["committedTiers"];
  readonly simulates?: boolean;
  readonly unsimulatedPreview?: readonly TierCandidatePreview[] | null;
  readonly conflicts?: FallbackTestModelPanelProps["conflicts"];
  readonly onGoToRow?: FallbackTestModelPanelProps["onGoToRow"];
}) {
  const policy = overrides.policy ?? seededPolicy({});
  return (
    <FallbackTestModelPanel
      id="test-panel"
      policy={policy}
      committedTiers={
        overrides.committedTiers ?? {
          tierGroups: policy.tierGroups,
          defaultTierGroupId: policy.defaultTierGroupId,
        }
      }
      catalog={catalogFixture()}
      conflicts={overrides.conflicts ?? []}
      labelFor={(profileId) =>
        profileId === "profile-2" ? "Personal 2" : profileId
      }
      simulates={overrides.simulates ?? true}
      unsimulatedPreview={overrides.unsimulatedPreview ?? null}
      onClose={() => {}}
      onGoToRow={overrides.onGoToRow ?? (() => {})}
    />
  );
}

function renderPanel(overrides: {
  readonly policy?: FallbackPolicy;
  readonly committedTiers?: FallbackTestModelPanelProps["committedTiers"];
  readonly simulates?: boolean;
  readonly unsimulatedPreview?: readonly TierCandidatePreview[] | null;
  readonly conflicts?: FallbackTestModelPanelProps["conflicts"];
  readonly onGoToRow?: FallbackTestModelPanelProps["onGoToRow"];
}) {
  return render(panelElement(overrides));
}

describe("FallbackTestModelPanel - request built from defaults", () => {
  afterEach(() => {
    resetMocks();
  });

  it("passes the full tuple built from the last-used profile, default permission, default service tier, agent mode and kind", () => {
    resetMocks();
    const captured: FallbackPolicyTestTierGroupsRequest[] = [];
    mocks.testQuerySpy = (request) => {
      if (request !== null) captured.push(request);
    };
    renderPanel({});
    expect(captured.length).toBeGreaterThan(0);
    const request = captured[captured.length - 1];
    expect(request.blocked).toEqual({
      harnessId: "codex",
      model: "gpt-6-sol",
      profileId: "profile-2",
      permissionMode: "full_access",
      agentMode: "regular",
      serviceTier: null,
      kind: "rate_limit",
    });
    expect(request.defaultTierGroupId).toBe("flagship");
    expect(request.groups).toEqual([FRONTIER, FLAGSHIP, STANDARD]);
  });

  it("passes the user's default service tier through untouched when one is set", () => {
    resetMocks();
    mocks.defaultServiceTier = "fast";
    const captured: FallbackPolicyTestTierGroupsRequest[] = [];
    mocks.testQuerySpy = (request) => {
      if (request !== null) captured.push(request);
    };
    renderPanel({});
    expect(captured.length).toBeGreaterThan(0);
    const request = captured[captured.length - 1];
    expect(request.blocked.serviceTier).toBe("fast");
  });
});

describe("FallbackTestModelPanel - wireframe 4 rendering", () => {
  afterEach(() => {
    resetMocks();
  });

  it("shows the flagship header, row 1 switches here, row 2 skips, row 3 then + more, the fallback line, and blank rows drawn as blank/skipped", () => {
    resetMocks();
    mocks.testQueryData = [...wireframeFourCandidates()];
    const policy = seededPolicy({
      tierGroups: [
        FRONTIER,
        {
          ...FLAGSHIP,
          candidates: [
            ...FLAGSHIP.candidates,
            { harnessId: "codex", modelFamily: "", reasoningEffort: null },
          ],
        },
        STANDARD,
      ],
    });
    renderPanel({ policy });

    const header = screen.getByTestId("fallback-test-model-header");
    expect(header.textContent).toContain("flagship");
    expect(header.textContent).toContain("GPT-6-Sol is in it through");
    expect(header.textContent).toContain("*sol*");
    expect(header.textContent).toContain("row 2");

    const rows = screen.getAllByTestId("fallback-test-model-row");
    // row 1: opus, switches here
    within(rows[0]).getByText("switches here");
    within(rows[0]).getByText("Default (Opus 5.5)");
    // T3 - the "switches here" pill carries the success variant.
    expect(
      within(rows[0]).getByText("switches here").getAttribute("data-variant"),
    ).toBe("success");

    // row 2: gpt-6-sol skipped (blocked model), gpt-5.6-sol skipped (rate limited)
    const row2Skips = within(rows[1]).getAllByTestId(
      "fallback-test-model-skip",
    );
    expect(row2Skips[0].textContent).toBe("skipped · the blocked model");
    expect(row2Skips[1].textContent).toBe(
      "skipped · same account, no headroom after a rate limit",
    );
    // T3 - the blocked-model skip (neutral tone) and the no-headroom skip
    // (warning tone) render through the tone-to-variant map.
    expect(row2Skips[0].dataset.tone).toBe("neutral");
    expect(row2Skips[0].getAttribute("data-variant")).toBe("muted");
    expect(row2Skips[1].dataset.tone).toBe("warning");
    expect(row2Skips[1].getAttribute("data-variant")).toBe("warning");

    // row 3: grok - both named matches are "then" (the winner is already row
    // 1's), plus "2 more" for the two left over past the MATCHES_NAMED cap.
    expect(within(rows[2]).getAllByText("then")).toHaveLength(2);
    within(rows[2]).getByText("2 more");

    // The blank fourth row.
    expect(
      within(rows[3]).getByTestId("fallback-test-model-skip").textContent,
    ).toBe("blank, skipped");

    const then = screen.getByTestId("fallback-test-model-then");
    expect(then.textContent).toContain("Wait for the limit to reset");
    expect(then.textContent).toContain("Notify you");

    // L1 - a match line wraps rather than grids (jsdom has no layout, so this
    // is class-pinned), and every skip pill wraps its text instead of
    // truncating it.
    const matchLines = screen.getAllByTestId("fallback-test-model-match");
    for (const line of matchLines) {
      expect(line.className).toContain("flex-wrap");
      expect(line.className).not.toContain("grid");
    }
    const skipPills = screen.getAllByTestId("fallback-test-model-skip");
    for (const pill of skipPills) {
      expect(pill.dataset.wrap).toBe("");
      expect(pill.className).toContain("whitespace-normal");
    }

    // Q2 - every tier pill is a Badge in the accent variant.
    const tierPill = screen.getByTestId("fallback-test-model-tier");
    expect(tierPill.dataset.slot).toBe("badge");
    expect(tierPill.getAttribute("data-variant")).toBe("accent");
  });

  it('a bare "*" row renders as "Any {Provider} model", never a bare * code element', () => {
    resetMocks();
    const star: TierGroup = {
      id: "flagship",
      candidates: [
        { harnessId: "codex", modelFamily: "*", reasoningEffort: null },
      ],
    };
    mocks.testQueryData = [
      {
        groupId: "flagship",
        candidateIndex: 0,
        harnessId: "codex",
        modelFamily: "*",
        reasoningEffort: null,
        resolvedModel: "gpt-6-astra",
        profileId: null,
        skipReason: null,
        skipLabel: null,
        warnings: [],
        matches: [
          {
            model: "gpt-6-astra",
            profileId: null,
            skipReason: null,
            skipLabel: null,
          },
        ],
      },
    ];
    const policy = seededPolicy({
      tierGroups: [star],
      defaultTierGroupId: null,
    });
    renderPanel({ policy });

    const header = screen.getByTestId("fallback-test-model-header");
    expect(header.textContent).toContain("Any Codex model");
    const row = screen.getByTestId("fallback-test-model-row");
    within(row).getByText("Any Codex model");
    expect(row.querySelector("code")).toBeNull();
  });
});

describe("FallbackTestModelPanel - the three footers", () => {
  afterEach(() => {
    resetMocks();
  });

  it("shows the default-tier footer for Codex GPT-5.5, which no row reaches", () => {
    resetMocks();
    mocks.lastRunModel = "gpt-5.5";
    mocks.testQueryData = [];
    renderPanel({});
    const footer = screen.getByTestId("fallback-test-model-footer-default");
    expect(footer.textContent).toContain("Not in any tier");
    expect(footer.textContent).toContain("GPT-5.5");
    expect(footer.textContent).toContain("goes to your default tier");
    expect(footer.textContent).toContain("flagship");
  });

  it('shows "no equivalent-model step; goes straight to Wait" for Claude Haiku with the default set to None', () => {
    resetMocks();
    mocks.lastRunHarness = "claude";
    mocks.lastRunModel = "haiku";
    const policy = seededPolicy({ defaultTierGroupId: null });
    renderPanel({ policy });
    const footer = screen.getByTestId("fallback-test-model-footer-no-tier");
    expect(footer.textContent).toContain(
      "Not in any tier, default set to None",
    );
    expect(footer.textContent).toContain("Haiku");
    expect(footer.textContent).toContain(
      "no equivalent-model step; goes straight to",
    );
    expect(footer.textContent).toContain("Wait for the limit to reset");
  });

  it("shows the conflict footer with a destructive fix pill calling onGoToRow(handlerTierIndex, handlerCandidateIndex)", () => {
    resetMocks();
    mocks.lastRunHarness = "codex";
    mocks.lastRunModel = "gpt-5.6-terra";
    const frontierWithGpt: TierGroup = {
      id: "frontier",
      candidates: [
        { harnessId: "codex", modelFamily: "*gpt*", reasoningEffort: "high" },
      ],
    };
    const standardWithTerra: TierGroup = {
      id: "standard",
      candidates: [
        {
          harnessId: "codex",
          modelFamily: "gpt-5.6-terra",
          reasoningEffort: "medium",
        },
      ],
    };
    const policy = seededPolicy({
      tierGroups: [frontierWithGpt, standardWithTerra],
      defaultTierGroupId: null,
    });
    const conflicts = findTierConflicts(
      policy.tierGroups,
      new Map<HarnessId, readonly GuiAgentModelOption[]>([
        ["codex", CODEX_MODELS],
      ]),
    );
    expect(conflicts).not.toHaveLength(0);
    mocks.testQueryData = [];
    const onGoToRow = vi.fn();
    renderPanel({ policy, conflicts, onGoToRow });
    const footer = screen.getByTestId("fallback-test-model-footer-conflict");
    expect(footer.textContent).toContain("In two tiers");
    expect(footer.textContent).toContain("frontier");
    expect(footer.textContent).toContain("standard");
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("It is in two tiers;");
    const fixButton = within(footer).getByTestId("fallback-test-model-fix");
    fixButton.click();
    expect(onGoToRow).toHaveBeenCalledWith(0, 0);
  });

  it("shows the conflict footer and status sentence naming three tiers when three claim the model", () => {
    resetMocks();
    mocks.lastRunHarness = "codex";
    mocks.lastRunModel = "gpt-5.6-terra";
    const frontierWithGpt: TierGroup = {
      id: "frontier",
      candidates: [
        { harnessId: "codex", modelFamily: "*gpt*", reasoningEffort: "high" },
      ],
    };
    const standardWithTerra: TierGroup = {
      id: "standard",
      candidates: [
        {
          harnessId: "codex",
          modelFamily: "gpt-5.6-terra",
          reasoningEffort: "medium",
        },
      ],
    };
    const budgetWithTerra: TierGroup = {
      id: "budget",
      candidates: [
        {
          harnessId: "codex",
          modelFamily: "*terra*",
          reasoningEffort: null,
        },
      ],
    };
    const policy = seededPolicy({
      tierGroups: [frontierWithGpt, standardWithTerra, budgetWithTerra],
      defaultTierGroupId: null,
    });
    const conflicts = findTierConflicts(
      policy.tierGroups,
      new Map<HarnessId, readonly GuiAgentModelOption[]>([
        ["codex", CODEX_MODELS],
      ]),
    );
    expect(conflicts).not.toHaveLength(0);
    expect(conflicts[0].tiers).toHaveLength(3);
    mocks.testQueryData = [];
    const onGoToRow = vi.fn();
    renderPanel({ policy, conflicts, onGoToRow });
    const footer = screen.getByTestId("fallback-test-model-footer-conflict");
    expect(footer.textContent).toContain("In three tiers");
    expect(footer.textContent).not.toContain("two tiers");
    expect(footer.textContent).toContain("frontier");
    expect(footer.textContent).toContain("standard");
    expect(footer.textContent).toContain("budget");
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("It is in three tiers;");
    expect(status.textContent).toContain(
      "frontier handles it until you fix the conflict",
    );
    const fixButton = within(footer).getByTestId("fallback-test-model-fix");
    fixButton.click();
    expect(onGoToRow).toHaveBeenCalledWith(0, 0);
  });
});

describe("FallbackTestModelPanel - older host fallback", () => {
  afterEach(() => {
    resetMocks();
  });

  it("shows the tier verdict, each row's first match from unsimulatedPreview, and the fallback line - with no request sent", () => {
    resetMocks();
    const captured: Array<FallbackPolicyTestTierGroupsRequest | null> = [];
    mocks.testQuerySpy = (request) => {
      captured.push(request);
    };
    renderPanel({
      simulates: false,
      unsimulatedPreview: wireframeFourCandidates(),
    });

    expect(
      screen.getByTestId("fallback-test-model-unsimulated").textContent,
    ).toBe("This host can't simulate the walk; showing what your tiers say.");
    // No request ever carries `blocked` - simulates=false never asks. The
    // length check first: `.every` is vacuously true over an empty array, so
    // without it this assertion would pass even if the hook were never called.
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((request) => request === null)).toBe(true);

    const header = screen.getByTestId("fallback-test-model-header");
    expect(header.textContent).toContain("flagship");

    const rows = screen.getAllByTestId("fallback-test-model-row");
    // Only the first match per row, status "listed", never "switches here".
    expect(screen.queryByText("switches here")).toBeNull();
    const firstRowMatch = within(rows[0]).getByTestId(
      "fallback-test-model-match",
    );
    expect(firstRowMatch.dataset.status).toBe("listed");
  });
});

describe("FallbackTestModelPanel - verdict announced", () => {
  afterEach(() => {
    resetMocks();
  });

  it("announces ONE sentence through the same polite status across a changed answer, and the visible verdict is not a live region (A1)", () => {
    resetMocks();
    mocks.testQueryData = [...wireframeFourCandidates()];
    const { rerender } = renderPanel({});
    const status = screen.getByRole("status");
    expect(status.dataset.testid).toBe("fallback-test-model-status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.className).toContain("sr-only");
    // The verdict header and the switch target, as one sentence.
    expect(status.textContent).toBe(
      "Traycer uses the flagship tier and switches to Default (Opus 5.5) on Personal 2.",
    );
    // Only one live region: the visible rows and pills are not announced.
    const verdict = screen.getByTestId("fallback-test-model-verdict");
    expect(verdict.getAttribute("aria-live")).toBeNull();
    expect(verdict.querySelector("[aria-live]")).toBeNull();

    // A policy whose ladder skips the equivalent-model step entirely: the
    // answer switches from the flagship-tier verdict to the steps-off line.
    // Falsification: if the panel keyed the status on the answer (remounting
    // it per verdict rather than updating it in place), this `toBe` would fail
    // even though the text still changed - a remounted live region does not
    // reliably announce in every screen reader.
    rerender(
      panelElement({
        policy: seededPolicy({ ladder: ["profile", "wait", "notify"] }),
      }),
    );
    const statusAfter = screen.getByRole("status");
    expect(statusAfter).toBe(status);
    expect(statusAfter.textContent).toBe(
      "The equivalent-model step is off for rate limits, so Traycer goes straight to Try another account, then Wait for the limit to reset, then Notify you.",
    );
  });
});

describe("FallbackTestModelPanel - steps-off copy", () => {
  afterEach(() => {
    resetMocks();
  });

  it('reads "Traycer goes straight to <steps>" when the ladder has no tier step, and sends no request', () => {
    resetMocks();
    const captured: Array<FallbackPolicyTestTierGroupsRequest | null> = [];
    mocks.testQuerySpy = (request) => captured.push(request);
    const policy = seededPolicy({ ladder: ["profile", "wait", "notify"] });
    renderPanel({ policy });
    const line = screen.getByTestId("fallback-test-model-steps-off");
    expect(line.textContent).toContain(
      "The equivalent-model step is off for rate limits",
    );
    expect(line.textContent).toContain("Traycer goes straight to");
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((request) => request === null)).toBe(true);
  });

  it('reads "Traycer doesn\'t try another model" when the reason override is "off", and sends no request', () => {
    resetMocks();
    const captured: Array<FallbackPolicyTestTierGroupsRequest | null> = [];
    mocks.testQuerySpy = (request) => captured.push(request);
    const policy = seededPolicy({ reasonOverrides: { rate_limit: "off" } });
    renderPanel({ policy });
    const line = screen.getByTestId("fallback-test-model-steps-off");
    expect(line.textContent).toContain("Your steps are turned off");
    expect(line.textContent).toContain("Traycer doesn't try");
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((request) => request === null)).toBe(true);
  });
});

/** A host row for `tierId`, one usable match - the shape a walk of ANOTHER tier returns. */
function walkedRow(
  tierId: string,
  candidateIndex: number,
  model: string,
): TierCandidatePreview {
  return {
    groupId: tierId,
    candidateIndex,
    harnessId: "codex",
    modelFamily: "*terra*",
    reasoningEffort: null,
    resolvedModel: model,
    profileId: null,
    skipReason: null,
    skipLabel: null,
    warnings: [],
    matches: [{ model, profileId: null, skipReason: null, skipLabel: null }],
  };
}

describe("FallbackTestModelPanel - the host walked a different tier (C2)", () => {
  afterEach(() => {
    resetMocks();
  });

  it("names the tier the host walked instead of drawing the client's tier with blank rows", () => {
    resetMocks();
    // The client routes Codex GPT-6-Sol to flagship through `*sol*`; the host's
    // answer carries only standard's rows (its own catalog read differed).
    mocks.testQueryData = [walkedRow("standard", 1, "gpt-5.6-terra")];
    renderPanel({});

    const notice = screen.getByTestId("fallback-test-model-routed-elsewhere");
    expect(notice.textContent).toContain("standard");
    expect(screen.queryAllByTestId("fallback-test-model-row")).toHaveLength(0);
  });

  it("says the host routes it to no tier when the answer carries no rows at all", () => {
    resetMocks();
    mocks.testQueryData = [];
    renderPanel({});

    const notice = screen.getByTestId("fallback-test-model-routed-elsewhere");
    expect(notice.textContent).toContain("no tier");
    expect(screen.queryAllByTestId("fallback-test-model-row")).toHaveLength(0);
  });
});

describe("FallbackTestModelPanel - account default with nothing remembered (D1)", () => {
  afterEach(() => {
    resetMocks();
  });

  it("defaults to the first listed enabled account, never a Terminal account the provider does not offer", () => {
    resetMocks();
    // Codex lists two managed accounts and no ambient (Terminal) row, and this
    // host has no last-used Codex account.
    mocks.lastProfileByHarness = {};
    const captured: FallbackPolicyTestTierGroupsRequest[] = [];
    mocks.testQuerySpy = (request) => {
      if (request !== null) captured.push(request);
    };
    renderPanel({});

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[captured.length - 1].blocked.profileId).toBe("profile-2");
    expect(
      screen.getByTestId("fallback-test-model-account").textContent,
    ).toContain("Personal 2");
  });
});

/** Radix's select: open with the keyboard, the same helper `fallback-tier-group-card.test.tsx` uses. */
function openSelect(trigger: HTMLElement): void {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
}

/** Commit the named option; Radix closes its own portal on this keydown. */
function chooseOption(name: string): void {
  const item = screen.getByRole("option", { name });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

describe("FallbackTestModelPanel - Claude default against the Claude catalog (T2)", () => {
  afterEach(() => {
    resetMocks();
  });

  it("routes through *opus* row 1, with the label matched (not the slug)", () => {
    resetMocks();
    mocks.lastRunHarness = "claude";
    mocks.lastRunModel = "default";
    mocks.lastProfileByHarness = { claude: "profile-2" };
    renderPanel({});

    const header = screen.getByTestId("fallback-test-model-header");
    expect(header.textContent).toContain("flagship");
    expect(header.textContent).toContain("Default (Opus 5.5) is in it through");
    expect(header.textContent).toContain("*opus*");
    expect(header.textContent).toContain("(row 1)");
  });
});

describe("FallbackTestModelPanel - master switch off lead (P1)", () => {
  afterEach(() => {
    resetMocks();
  });

  it("shows the master-off lead line, and the status starts with it, when the policy is disabled", () => {
    resetMocks();
    const policy = seededPolicy({ enabled: false });
    renderPanel({ policy });

    const lead = screen.getByTestId("fallback-test-model-master-off");
    expect(lead.textContent).toBe(
      "Route automatically is off, so nothing switches on its own. With it on:",
    );
    const status = screen.getByRole("status");
    // The lead, then the verdict itself, as one announced sentence.
    expect(status.textContent.startsWith(`${lead.textContent} `)).toBe(true);
  });

  it("shows neither the lead line nor the status prefix when the policy is enabled", () => {
    resetMocks();
    const policy = seededPolicy({ enabled: true });
    renderPanel({ policy });

    expect(screen.queryByTestId("fallback-test-model-master-off")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent.startsWith("Route automatically is off")).toBe(
      false,
    );
  });
});

describe("FallbackTestModelPanel - another error's next steps (P2)", () => {
  afterEach(() => {
    resetMocks();
  });

  it('a billing-only override disagrees with the rest: the then-line reads "depends on the error"', () => {
    resetMocks();
    mocks.testQueryData = [];
    const policy = seededPolicy({
      ladder: ["profile", "tier", "wait", "notify"],
      reasonOverrides: { billing: ["profile", "notify"] },
    });
    renderPanel({ policy });
    openSelect(screen.getByTestId("fallback-test-model-kind"));
    chooseOption("another error");

    const then = screen.getByTestId("fallback-test-model-then");
    expect(then.textContent).toContain(
      "If none of these work: depends on the error; see Overrides",
    );
  });

  it("every other error agreeing shows the shared-steps line", () => {
    resetMocks();
    mocks.testQueryData = [];
    renderPanel({});
    openSelect(screen.getByTestId("fallback-test-model-kind"));
    chooseOption("another error");

    const then = screen.getByTestId("fallback-test-model-then");
    expect(then.textContent).toContain(
      "(your fallback steps, the same for every other error)",
    );
  });

  it("a ladder with no tier step gives the steps-off line with depends-on-the-error, and sends no request", () => {
    resetMocks();
    const captured: Array<FallbackPolicyTestTierGroupsRequest | null> = [];
    mocks.testQuerySpy = (request) => captured.push(request);
    const policy = seededPolicy({ ladder: ["profile", "notify"] });
    renderPanel({ policy });
    openSelect(screen.getByTestId("fallback-test-model-kind"));
    chooseOption("another error");

    const line = screen.getByTestId("fallback-test-model-steps-off");
    expect(line.textContent).toContain(
      "The equivalent-model step doesn't run for these errors",
    );
    expect(line.textContent).toContain("depends on the error; see Overrides");
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((request) => request === null)).toBe(true);
  });
});

describe("FallbackTestModelPanel - a failed catalog read (D2)", () => {
  afterEach(() => {
    resetMocks();
  });

  it('shows "Couldn\'t load models" on the trigger and the incomplete line, and Try again calls refetch once', () => {
    resetMocks();
    mocks.modelsWarmupError = true;
    const retrySpy = vi.fn(() => Promise.resolve());
    mocks.modelsWarmupRetry = retrySpy;
    renderPanel({});

    expect(
      screen.getByTestId("fallback-test-model-model").textContent,
    ).toContain("Couldn't load models");
    expect(
      screen.getByTestId("fallback-test-model-incomplete").textContent,
    ).toContain("Couldn't load this provider's models.");

    fireEvent.click(screen.getByTestId("fallback-test-model-models-retry"));
    expect(retrySpy).toHaveBeenCalledTimes(1);
  });
});

describe("FallbackTestModelPanel - Terminal account on a winning codex match (D3)", () => {
  afterEach(() => {
    resetMocks();
  });

  it('shows "Terminal account" for a winning match with profileId null on a codex row', () => {
    resetMocks();
    mocks.testQueryData = [
      {
        groupId: "flagship",
        candidateIndex: 1,
        harnessId: "codex",
        modelFamily: "*sol*",
        reasoningEffort: "high",
        resolvedModel: "gpt-6-sol",
        profileId: null,
        skipReason: null,
        skipLabel: null,
        warnings: [],
        matches: [
          {
            model: "gpt-6-sol",
            profileId: null,
            skipReason: null,
            skipLabel: null,
          },
        ],
      },
    ];
    renderPanel({});

    const rows = screen.getAllByTestId("fallback-test-model-row");
    // row index 1 is the Codex *sol* row (candidateIndex 1).
    expect(rows[1].textContent).toContain("Terminal account");
  });
});

describe("FallbackTestModelPanel - picker-driven scenarios (T4)", () => {
  afterEach(() => {
    resetMocks();
  });

  it("switching the provider to Claude re-seeds model and profile for the new provider", () => {
    resetMocks();
    const captured: FallbackPolicyTestTierGroupsRequest[] = [];
    mocks.testQuerySpy = (request) => {
      if (request !== null) captured.push(request);
    };
    renderPanel({});

    openSelect(screen.getByTestId("fallback-test-model-provider"));
    chooseOption("Claude Code");

    expect(captured.length).toBeGreaterThan(0);
    const request = captured[captured.length - 1];
    expect(request.blocked.harnessId).toBe("claude");
    // CLAUDE_MODELS[0] is "default" - the reseeded provider's first model.
    expect(request.blocked.model).toBe("default");
    // No last-used Claude account is remembered, so the seed falls through to
    // the first listed account - "profile-2" ("Personal 2").
    expect(request.blocked.profileId).toBe("profile-2");
  });

  it('picking "another error" sends blocked.kind "other", and the then-line names no wait step', () => {
    resetMocks();
    const captured: FallbackPolicyTestTierGroupsRequest[] = [];
    mocks.testQuerySpy = (request) => {
      if (request !== null) captured.push(request);
    };
    renderPanel({});

    openSelect(screen.getByTestId("fallback-test-model-kind"));
    chooseOption("another error");

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[captured.length - 1].blocked.kind).toBe("other");
    const then = screen.getByTestId("fallback-test-model-then");
    expect(then.textContent).not.toContain("Wait");
  });

  it("clamps the permission mode to what the picked harness supports", () => {
    resetMocks();
    mocks.harnesses = HARNESSES.map((harness) =>
      harness.id === "grok"
        ? {
            ...harness,
            supportedPermissionModes: [
              "supervised",
              "auto_accept_edits",
              "auto",
            ] as const,
          }
        : harness,
    );
    const captured: FallbackPolicyTestTierGroupsRequest[] = [];
    mocks.testQuerySpy = (request) => {
      if (request !== null) captured.push(request);
    };
    renderPanel({});
    openSelect(screen.getByTestId("fallback-test-model-provider"));
    chooseOption("Grok");

    expect(captured.length).toBeGreaterThan(0);
    const request = captured[captured.length - 1];
    expect(request.blocked.permissionMode).not.toBe("full_access");
    expect(["supervised", "auto_accept_edits", "auto"]).toContain(
      request.blocked.permissionMode,
    );
  });

  it("switching the provider re-seeds the account from the new provider's own memory, not a pick carried from the old one", () => {
    resetMocks();
    mocks.lastProfileByHarness = { codex: "profile-2", claude: "profile-2" };
    const captured: FallbackPolicyTestTierGroupsRequest[] = [];
    mocks.testQuerySpy = (request) => {
      if (request !== null) captured.push(request);
    };
    renderPanel({});

    // "Work" (profile-3) is listed by both providers, so only the switch's
    // reset keeps it from riding over to Claude, whose remembered account is
    // Personal 2.
    openSelect(screen.getByTestId("fallback-test-model-account"));
    chooseOption("Work");
    expect(captured[captured.length - 1].blocked.profileId).toBe("profile-3");
    openSelect(screen.getByTestId("fallback-test-model-provider"));
    chooseOption("Claude Code");

    const request = captured[captured.length - 1];
    expect(request.blocked.harnessId).toBe("claude");
    expect(request.blocked.profileId).toBe("profile-2");
  });

  it("switching the provider drops a picked permission mode back to the default, not carries it forward", () => {
    resetMocks();
    const captured: FallbackPolicyTestTierGroupsRequest[] = [];
    mocks.testQuerySpy = (request) => {
      if (request !== null) captured.push(request);
    };
    renderPanel({});

    // Both Codex (the initial harness, via lastRun) and Claude support every
    // mode here, so "Supervised" is valid for either - the only way to tell
    // a reset from a stale carried-forward pick is to switch and check which
    // one comes back.
    openSelect(screen.getByTestId("fallback-test-model-permission"));
    chooseOption("Supervised");
    openSelect(screen.getByTestId("fallback-test-model-provider"));
    chooseOption("Claude Code");

    expect(captured.length).toBeGreaterThan(0);
    const request = captured[captured.length - 1];
    expect(request.blocked.permissionMode).toBe("full_access");
  });
});
