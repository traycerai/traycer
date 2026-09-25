import { cleanup, render, screen, within } from "@testing-library/react";
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
import type { FallbackPolicyTestTierGroupsRequest } from "@/hooks/providers/use-fallback-policy-preview-tier-groups-query";
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
  } => ({
    testQuerySpy: () => {},
    testQueryData: null,
    testQueryFetching: false,
    testQueryError: false,
    lastRunModel: "gpt-6-sol",
    lastRunHarness: "codex",
    defaultServiceTier: "",
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
    data: { harnesses: HARNESSES },
  }),
  useGuiHarnessModelsWarmup: (
    _client: unknown,
    harnessId: GuiHarnessId | null,
  ) => {
    if (harnessId === null) return [];
    const models = MODELS_BY_HARNESS.get(harnessId) ?? [];
    return [{ data: { models }, isError: false }];
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
          providerId: "claude",
          profiles: [
            providerProfile({ profileId: "profile-2", label: "Personal 2" }),
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
    const state = {
      byHost: {},
      legacy: { lastProfileByHarness: { codex: "profile-2" } },
    };
    return {
      ...actual,
      useComposerHarnessMemoryStore: (
        selector: (input: typeof state) => unknown,
      ) => selector(state),
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

vi.mock(
  "@/hooks/providers/use-fallback-policy-preview-tier-groups-query",
  () => ({
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
  }),
);

import { FallbackTestModelPanel } from "@/components/settings/panels/fallback/fallback-test-model-panel";

function resetMocks(): void {
  mocks.testQuerySpy = () => {};
  mocks.testQueryData = null;
  mocks.testQueryFetching = false;
  mocks.testQueryError = false;
  mocks.lastRunModel = "gpt-6-sol";
  mocks.lastRunHarness = "codex";
  mocks.defaultServiceTier = "";
}

function panelElement(overrides: {
  readonly policy?: FallbackPolicy;
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

    // row 2: gpt-6-sol skipped (blocked model), gpt-5.6-sol skipped (rate limited)
    const row2Skips = within(rows[1]).getAllByTestId(
      "fallback-test-model-skip",
    );
    expect(row2Skips[0].textContent).toBe("skipped · the blocked model");
    expect(row2Skips[1].textContent).toBe(
      "skipped · same account, no headroom after a rate limit",
    );

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

  it("stays the SAME aria-live region across a changed answer - only its content changes", () => {
    resetMocks();
    mocks.testQueryData = [...wireframeFourCandidates()];
    const { rerender } = renderPanel({});
    const verdict = screen.getByTestId("fallback-test-model-verdict");
    expect(verdict.getAttribute("aria-live")).toBe("polite");
    expect(verdict.textContent).toContain("flagship");

    // A policy whose ladder skips the equivalent-model step entirely: the
    // verdict switches from the flagship-tier answer to the steps-off line.
    // Falsification: if the panel keyed the verdict region on the answer
    // (remounting it per verdict rather than updating it in place), this
    // `toBe` would fail even though the text still changed correctly - a
    // remounted `aria-live` region does not reliably announce in every
    // screen reader, which is the whole point of mounting it once.
    rerender(
      panelElement({
        policy: seededPolicy({ ladder: ["profile", "wait", "notify"] }),
      }),
    );
    const verdictAfter = screen.getByTestId("fallback-test-model-verdict");
    expect(verdictAfter).toBe(verdict);
    expect(verdictAfter.textContent).not.toContain("flagship");
    expect(verdictAfter.textContent).toContain(
      "The equivalent-model step is off for rate limits",
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
