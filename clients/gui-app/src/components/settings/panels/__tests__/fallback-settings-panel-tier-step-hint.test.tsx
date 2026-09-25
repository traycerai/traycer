import { cleanup, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
} from "@traycer/protocol/host/fallback-policy";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";

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
