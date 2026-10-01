import { cleanup, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
  type TierCandidate,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { HarnessId } from "@traycer/protocol/host/agent/shared";

/**
 * `TierStepHint` must not resolve a legacy (unattributed) last-run tuple
 * against THIS host's `listModels`. `selectGlobalLastRunSettings` falls back
 * to that tuple when the selected host has no scoped entry, and the slug may
 * name a different model on this machine. A wrong catalogue label is worse
 * than the raw slug, because nothing about it looks unresolved.
 *
 * `useFallbackModelLabels` is kept REAL. The existing panel suites mock it
 * and so cannot tell a hint that never asked from one that resolved; this
 * file's `useHostQueries` double is what records the `listModels` issue.
 */

const { HOST_ID } = vi.hoisted(() => ({ HOST_ID: "host-a" as const }));

/**
 * `providers.fallbackPolicy.get`'s negotiated line. Default `true` (a 1.1
 * host), because Pin 11's rows are `*`-patterns and its catalog arm is a
 * pattern-era rule: on a 1.0 host the hint asks the released family-word rule
 * instead, where `*astra*` is a literal word that matches nothing. The
 * ownership describe renders with no tiers, so the line does not move it. The
 * R4 describe sets `false` where it is about a 1.0 host.
 */
const patternLinesHolder = vi.hoisted(
  (): { patterns: boolean; blankPreviewRows: boolean } => ({
    patterns: true,
    blankPreviewRows: true,
  }),
);

vi.mock("@/hooks/providers/use-fallback-policy-pattern-lines", () => ({
  useFallbackPolicyPatternLines: () => patternLinesHolder,
}));

const LAST_RUN: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-fable-5-1[1m]",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const harnessesData = vi.hoisted(() => ({
  value: {
    // `enabled` alongside `available`: the hook gates model requests on BOTH,
    // so a row missing this field reads `undefined` and is filtered out -
    // which would make the host-owned case below pass for the wrong reason
    // (no request because no harness, not because of ownership).
    harnesses: [{ id: "claude", available: true, enabled: true }],
  } as {
    readonly harnesses: ReadonlyArray<{
      id: string;
      available: boolean;
      enabled: boolean;
    }>;
  },
}));

const modelsByHarness = vi.hoisted(() => ({
  value: new Map<string, ReadonlyArray<{ slug: string; label: string }>>(),
}));

const hostQueriesCalls = vi.hoisted(() => ({
  requests: [] as ReadonlyArray<{
    readonly params: { readonly harnessId: string };
  }>,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST_ID,
}));

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const host = hostScopeOptionFixture({ hostId: HOST_ID, name: "Studio" });
  return {
    useHostScope: () =>
      hostScopeFixture({
        hosts: [host],
        host,
        hostId: host.hostId,
        hostLabel: host.name,
        activeHost: host,
        isViewingActive: true,
        status: "following",
        client: null,
      }),
  };
});

const queryDataHolder = vi.hoisted(
  (): { value: ProvidersFallbackPolicyGetResponse | undefined } => ({
    value: undefined,
  }),
);

vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: false,
    data: queryDataHolder.value,
  }),
}));

vi.mock("@/hooks/providers/use-fallback-in-flight-count-query", () => ({
  useFallbackInFlightCountQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-set-mutation", () => ({
  useFallbackPolicySetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/providers/use-fallback-policy-reset-mutation", () => ({
  useFallbackPolicyResetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock(
  "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation",
  () => ({
    useFallbackPolicyRestoreTierGroupsMutation: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock(
  "@/hooks/providers/use-fallback-policy-preview-tier-groups-query",
  () => ({
    useFallbackPolicyPreviewTierGroupsQuery: () => ({
      data: undefined,
      isFetching: false,
    }),
  }),
);
/**
 * `catalogFor` is `null` by default - "no answer yet", the fails-closed
 * direction `tierGroupsNameDestinationFor`'s own doc names. Pin 11 below
 * populates it with a codex catalog to exercise the loaded-catalog arm.
 */
const catalogForFixture = vi.hoisted(
  (): {
    value: ReadonlyMap<string, ReadonlyArray<{ slug: string; label: string }>>;
  } => ({
    value: new Map(),
  }),
);

vi.mock(
  "@/components/settings/panels/fallback/fallback-catalog-options",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/panels/fallback/fallback-catalog-options")
      >();
    return {
      ...actual,
      useFallbackCatalogOptions: () => ({
        modelsFor: () => [],
        catalogFor: (harnessId: string) =>
          catalogForFixture.value.get(harnessId) ?? null,
        catalogsByHarness: catalogForFixture.value,
        effortsFor: () => [],
      }),
    };
  },
);

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: (
    _client: unknown,
    activity: { readonly enabled: boolean },
  ) => ({
    data: activity.enabled ? harnessesData.value : undefined,
    isPending: false,
    isError: false,
  }),
  useGuiHarnessModelsQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    readonly requests: ReadonlyArray<{
      readonly params: { readonly harnessId: string };
    }>;
    readonly combine?: (
      results: ReadonlyArray<{
        readonly data: {
          readonly models: ReadonlyArray<{ slug: string; label: string }>;
        };
      }>,
    ) => unknown;
  }) => {
    hostQueriesCalls.requests = args.requests;
    const results = args.requests.map((request) => ({
      data: {
        models: modelsByHarness.value.get(request.params.harnessId) ?? [],
      },
      isPending: false,
      isError: false,
      isSuccess: true,
    }));
    return args.combine === undefined ? results : args.combine(results);
  },
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { renderWithFallbackQueryClient } from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";

function modelOption(
  harnessId: string,
  slug: string,
  label: string,
): GuiAgentModelOption {
  return {
    harnessId: harnessId as GuiAgentModelOption["harnessId"],
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

function respond(
  overrides: Partial<FallbackPolicy>,
): ProvidersFallbackPolicyGetResponse {
  return {
    policy: { ...createDefaultFallbackPolicy(), enabled: true, ...overrides },
    storedPolicyUnreadable: false,
    inFlightCount: 0,
  };
}

function renderPanel() {
  return renderWithFallbackQueryClient(
    <StrictMode>
      <FallbackSettingsPanel />
    </StrictMode>,
  );
}

beforeEach(() => {
  queryDataHolder.value = respond({ tierGroups: [] });
  hostQueriesCalls.requests = [];
  modelsByHarness.value = new Map([
    ["claude", [modelOption("claude", "claude-fable-5-1[1m]", "Claude Fable")]],
  ]);
  catalogForFixture.value = new Map();
  patternLinesHolder.patterns = true;
  patternLinesHolder.blankPreviewRows = true;
  useComposerRunSettingsStore.getState().resetForTests();
});

afterEach(() => {
  useComposerRunSettingsStore.getState().resetForTests();
  cleanup();
});

describe("TierStepHint - Pin 11: the catalog changes whether a same-harness pattern row counts as covering the failure", () => {
  // `tierGroupsNameDestinationFor` (protocol/src/host/fallback-policy.ts)
  // excludes a same-harness row only when it PROVABLY names nothing but the
  // failed model - with a catalog, no OTHER entry matches the pattern; with
  // `catalog: null`, only a no-`*` exact pick counts as provable. These two
  // cases pin that `TierStepHint` now passes `catalog.catalogFor(harnessId)`
  // (fallback-settings-panel.tsx) instead of the old hard-coded `null`.
  const LAST_RUN_CODEX: ChatRunSettings = {
    harnessId: "codex",
    model: "gpt-6-astra",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  };

  function draftWithAstraRow(): FallbackPolicy {
    return {
      ...createDefaultFallbackPolicy(),
      enabled: true,
      defaultTierGroupId: null,
      tierGroups: [
        {
          id: "frontier",
          candidates: [
            {
              harnessId: "codex",
              modelFamily: "*astra*",
              reasoningEffort: null,
            },
          ],
        },
      ],
    };
  }

  beforeEach(() => {
    useComposerRunSettingsStore.setState({
      globalLastRunSettingsByHostId: { [HOST_ID]: LAST_RUN_CODEX },
      legacyGlobalLastRunSettings: LAST_RUN_CODEX,
    });
    modelsByHarness.value = new Map([
      ["codex", [modelOption("codex", "gpt-6-astra", "GPT-6-Astra")]],
    ]);
  });

  it("with the catalog loaded, a pattern that matches ONLY the failed model does not count as a destination - the hint shows", () => {
    // "*astra*" matches "gpt-6-astra" and nothing else in this catalog, so
    // `patternNamesOnlyBlockedModel` excludes the only candidate and
    // `tierGroupsNameDestinationFor` returns false.
    //
    // Falsification: revert `catalog: catalog.catalogFor(lastRun.harnessId)`
    // to the old `catalog: null` in `TierStepHint`
    // (fallback-settings-panel.tsx). With `catalog: null`,
    // `patternNamesOnlyBlockedModel` falls back to `!pattern.includes("*")`,
    // which is false for "*astra*" - so the row would count as a destination
    // and this hint would wrongly stay hidden.
    catalogForFixture.value = new Map([
      [
        "codex",
        [
          { slug: "gpt-6-astra", label: "GPT-6-Astra" },
          { slug: "gpt-6-sol", label: "GPT-6-Sol" },
        ],
      ],
    ]);
    queryDataHolder.value = respond(draftWithAstraRow());
    renderPanel();
    expect(
      screen.getByText(/No other model is set up for Codex/),
    ).toBeDefined();
  });

  it("with no catalog loaded (`null`), the same wildcard row counts as covering the failure - no hint", () => {
    // `catalog: null` falls back to the syntactic rule: a pattern containing
    // `*` is never provably exact, so it counts as a destination and the
    // hint is withheld.
    catalogForFixture.value = new Map();
    queryDataHolder.value = respond(draftWithAstraRow());
    renderPanel();
    expect(screen.queryByText(/No other model is set up for Codex/)).toBeNull();
  });
});

describe("TierStepHint - last-run tuples that this host does not own", () => {
  it("shows the raw slug and issues no listModels query when only the unattributed legacy tuple is populated", () => {
    useComposerRunSettingsStore.setState({
      globalLastRunSettingsByHostId: {},
      legacyGlobalLastRunSettings: LAST_RUN,
    });
    renderPanel();

    // Falsification: enable the catalogue read whenever `lastRun !== null`
    // (the pre-fix gate). The hint then resolves the legacy slug against
    // THIS host's listModels and prints "Claude Fable" - a name that may
    // belong to another machine.
    expect(
      screen.getByText(
        /No other model is set up for Claude Code · claude-fable-5-1\[1m\]/,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Claude Fable/)).toBeNull();
    expect(hostQueriesCalls.requests).toHaveLength(0);
    // The same ownership fact the resolution gate turns on, applied to the
    // COPY. A legacy record may have been written on any machine, so the
    // sentence must not attribute it to this one. Falsification: restore the
    // unconditional "on this host" suffix and this goes red.
    expect(screen.queryByText(/on this host/)).toBeNull();
    expect(
      screen.getByText(/— the model you last started a chat with\./),
    ).toBeDefined();
  });

  it("resolves a host-owned tuple to its catalogue label and issues listModels for that harness", () => {
    useComposerRunSettingsStore.setState({
      globalLastRunSettingsByHostId: { [HOST_ID]: LAST_RUN },
      // Populated on purpose: if the hint still consulted the legacy slot
      // for resolution, this control would not distinguish ownership.
      legacyGlobalLastRunSettings: LAST_RUN,
    });
    renderPanel();

    expect(
      screen.getByText(
        /No other model is set up for Claude Code · Claude Fable/,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/claude-fable-5-1/)).toBeNull();
    expect(hostQueriesCalls.requests.map((r) => r.params.harnessId)).toEqual([
      "claude",
    ]);
    // The other arm of the copy matrix: this host DOES own the record, so the
    // host clause is earned. Asserted as the pair to the case above, because a
    // fix that dropped the clause unconditionally would satisfy that one alone
    // and lose a true statement here.
    expect(
      screen.getByText(
        /— the model you last started a chat with on this host\./,
      ),
    ).toBeDefined();
  });
});

describe("TierStepHint - R4: a get@1.0 host reads tier rows as family words", () => {
  // A get@1.0 host's OWN routing rule (not `modelMatchesPattern`): a row
  // matches when `needle === slug || haystackHasFamilyWord(slug, needle)`,
  // SLUG only, never the catalog label; the LONGEST matching family wins
  // across groups, ties go to the earlier group; no match falls to
  // `defaultTierGroupId`. `TierStepHint` currently calls
  // `tierGroupsNameDestinationFor` (the 1.1 pattern rule) unconditionally, so
  // every test below that sets `patterns: false` exercises a host the
  // production code does not yet special-case.
  function legacyCandidate(
    harnessId: HarnessId,
    modelFamily: string,
  ): TierCandidate {
    return { harnessId, modelFamily, reasoningEffort: null };
  }

  function legacyTierGroup(
    id: string,
    candidates: readonly TierCandidate[],
  ): TierGroup {
    return { id, candidates: [...candidates] };
  }

  /** frontier: [claude `opus`, codex `gpt`]; standard: [claude `sonnet`, codex `spark`]. */
  function legacySeedGroups(): readonly TierGroup[] {
    return [
      legacyTierGroup("frontier", [
        legacyCandidate("claude", "opus"),
        legacyCandidate("codex", "gpt"),
      ]),
      legacyTierGroup("standard", [
        legacyCandidate("claude", "sonnet"),
        legacyCandidate("codex", "spark"),
      ]),
    ];
  }

  function policyWithGroups(groups: readonly TierGroup[]): FallbackPolicy {
    return {
      ...createDefaultFallbackPolicy(),
      enabled: true,
      defaultTierGroupId: null,
      tierGroups: [...groups],
    };
  }

  function runSettings(harnessId: HarnessId, model: string): ChatRunSettings {
    return {
      harnessId,
      model,
      permissionMode: "supervised",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    };
  }

  function setLastRun(tuple: ChatRunSettings): void {
    useComposerRunSettingsStore.setState({
      globalLastRunSettingsByHostId: { [HOST_ID]: tuple },
      legacyGlobalLastRunSettings: tuple,
    });
  }

  it("RED 1: 'gpt' is a whole word in the failed slug, so the tuple routes to frontier, which has a real destination (claude opus) - no hint", () => {
    patternLinesHolder.patterns = false;
    setLastRun(runSettings("codex", "gpt-6-sol"));
    catalogForFixture.value = new Map([
      [
        "codex",
        [
          { slug: "gpt-6-sol", label: "GPT-6-Sol" },
          { slug: "gpt-6-astra", label: "GPT-6-Astra" },
        ],
      ],
    ]);
    queryDataHolder.value = respond(policyWithGroups(legacySeedGroups()));
    renderPanel();
    // Falsification: this is RED on the unmodified `TierStepHint`, which
    // always calls `tierGroupsNameDestinationFor` - the 1.1 pattern rule.
    // Under that rule codex's exact (non-wildcard) pattern "gpt" must equal
    // the whole slug "gpt-6-sol" and does not, so neither group matches, no
    // default is set, and the component wrongly shows the hint. The fix
    // (consulting a 1.0-style family-word rule when `patterns` is false)
    // must route "gpt-6-sol" to "frontier" via the whole-word family "gpt"
    // and withhold the hint, since frontier's claude `opus` row is a real
    // destination.
    expect(screen.queryByText(/No other model is set up/)).toBeNull();
  });

  it("RED 2: the same family-word routing holds with no catalog loaded (`catalog: null`) - no hint", () => {
    patternLinesHolder.patterns = false;
    setLastRun(runSettings("codex", "gpt-6-sol"));
    // Default from `beforeEach`: `catalogForFixture.value` is an empty map,
    // so `catalog.catalogFor("codex")` answers `null`.
    queryDataHolder.value = respond(policyWithGroups(legacySeedGroups()));
    renderPanel();
    // Falsification: same as RED 1 - the unmodified `tierGroupsNameDestinationFor`
    // path requires "gpt" to equal the whole slug "gpt-6-sol" and, with no
    // catalog to supply a label either, finds no matching group at all. The
    // 1.0 family-word rule does not need a catalog to see the whole word.
    expect(screen.queryByText(/No other model is set up/)).toBeNull();
  });

  it("GUARD A: the LONGEST matching family wins - 'spark' (5) over 'gpt' (3), so the tuple routes to standard, whose only row is its own failed family - hint shown", () => {
    patternLinesHolder.patterns = false;
    setLastRun(runSettings("codex", "gpt-5.3-codex-spark"));
    queryDataHolder.value = respond(
      policyWithGroups([
        legacyTierGroup("frontier", [
          legacyCandidate("codex", "gpt"),
          legacyCandidate("claude", "opus"),
        ]),
        legacyTierGroup("standard", [legacyCandidate("codex", "spark")]),
      ]),
    );
    renderPanel();
    // A first-match rule (frontier listed first, "gpt" also a whole word in
    // the slug) would route here and hide the hint via frontier's claude
    // `opus` row - this guard is what tells "longest wins" apart from
    // "first-listed wins". Passes on both the unmodified pattern-based code
    // (neither "gpt" nor "spark" equals the whole slug, so no group matches
    // and the hint shows for that reason) and the fixed family-word code
    // (routes to standard, whose one row is the failed model's own family, so
    // the hint shows for the routing reason this guard names).
    expect(
      screen.getByText(/No other model is set up for Codex/),
    ).toBeDefined();
  });

  it("GUARD B: the family word is matched against the SLUG only, never the catalog label - hint shown", () => {
    patternLinesHolder.patterns = false;
    setLastRun(runSettings("claude", "default"));
    catalogForFixture.value = new Map([
      ["claude", [{ slug: "default", label: "Default (Opus 5.5)" }]],
    ]);
    queryDataHolder.value = respond(
      policyWithGroups([
        legacyTierGroup("frontier", [
          legacyCandidate("claude", "opus"),
          legacyCandidate("codex", "gpt"),
        ]),
      ]),
    );
    renderPanel();
    // "opus" is a whole word in the catalog LABEL "Default (Opus 5.5)" but
    // not in the SLUG "default" - a 1.0 host never sees the label, so no
    // group matches. Passes on both the unmodified pattern-based code
    // (`modelMatchesPattern` also requires a whole match, and "opus" equals
    // neither the whole slug nor the whole label here) and the fixed
    // family-word code (slug-only, so the label match a wrong
    // label-inclusive implementation would find is never reached).
    expect(
      screen.getByText(/No other model is set up for Claude Code/),
    ).toBeDefined();
  });

  it("GUARD C: patterns supported (1.1) - exact 'gpt' is not 'gpt-6-sol' - hint shown", () => {
    patternLinesHolder.patterns = true;
    setLastRun(runSettings("codex", "gpt-6-sol"));
    queryDataHolder.value = respond(policyWithGroups(legacySeedGroups()));
    renderPanel();
    // Falsification: drop the `patterns` gate the fix adds to `TierStepHint`
    // (always use the family-word rule). "gpt" is a whole word in
    // "gpt-6-sol", so a family-word reading would route to frontier and hide
    // the hint - this guard is what would catch a fix that stopped
    // respecting `patterns: true`.
    expect(
      screen.getByText(/No other model is set up for Codex/),
    ).toBeDefined();
  });

  it("GUARD D: patterns supported (1.1), frontier's codex row is '*gpt*' - the wildcard matches 'gpt-6-sol' - no hint", () => {
    patternLinesHolder.patterns = true;
    setLastRun(runSettings("codex", "gpt-6-sol"));
    queryDataHolder.value = respond(
      policyWithGroups([
        legacyTierGroup("frontier", [
          legacyCandidate("codex", "*gpt*"),
          legacyCandidate("claude", "opus"),
        ]),
        legacyTierGroup("standard", [
          legacyCandidate("claude", "sonnet"),
          legacyCandidate("codex", "spark"),
        ]),
      ]),
    );
    renderPanel();
    // The pair to GUARD C: on a 1.1 host the SAME tuple, with a wildcard
    // pattern instead of an exact one, does match - frontier routes and its
    // claude `opus` row is a real destination, so the hint is withheld.
    expect(screen.queryByText(/No other model is set up/)).toBeNull();
  });
});
