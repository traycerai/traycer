import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
  type ProvidersFallbackPolicyPreviewTierGroupsResponse,
  type TierCandidatePreview,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import type { GuiAgentModelOption } from "@traycer/protocol/host/index";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import type { FallbackPolicyTestTierGroupsRequest } from "@/hooks/providers/use-fallback-policy-preview-tier-groups-query";

/**
 * Ticket 05, clause 6: the REAL wiring in `fallback-settings-panel.tsx` -
 * `simulates={patternLines.blankPreviewRows}` and
 * `unsimulatedPreview={previewQuery.data?.candidates ?? null}` - through the
 * whole `FallbackSettingsPanel`, not through `FallbackTestModelPanel`
 * rendered directly (that suite passes `simulates` straight in as a prop, so
 * it cannot see whether the panel's OWN wiring reads the right bit).
 *
 * Both `useFallbackPolicyPreviewTierGroupsQuery` (the editor's own preview)
 * and `useFallbackPolicyTestTierGroupsQuery` (the Test panel's dry run) live
 * in the same module and are mocked together here.
 */

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const host = hostScopeOptionFixture({ hostId: "host-a", name: "Test Host" });
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

const fallbackMocks = vi.hoisted(
  (): { queryData: ProvidersFallbackPolicyGetResponse | undefined } => ({
    queryData: undefined,
  }),
);

vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: false,
    data: fallbackMocks.queryData,
    refetch: () =>
      Promise.resolve({ isSuccess: true, data: fallbackMocks.queryData }),
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
        catalogFor: () => null,
        catalogsByHarness: new Map(),
        effortsFor: () => [],
      }),
    };
  },
);

vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >();
    return {
      ...actual,
      useFallbackModelLabels: () => (_harnessId: string, model: string) =>
        model,
    };
  },
);

const CODEX_MODELS: readonly GuiAgentModelOption[] = [
  {
    harnessId: "codex",
    slug: "gpt-6-sol",
    label: "GPT-6-Sol",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  },
];

const MODELS_BY_HARNESS: ReadonlyMap<
  GuiHarnessId,
  readonly GuiAgentModelOption[]
> = new Map([["codex", CODEX_MODELS]]);

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: {
      harnesses: [
        {
          id: "codex",
          available: true,
          enabled: true,
          supportedPermissionModes: [
            "supervised",
            "auto_accept_edits",
            "auto",
            "full_access",
          ],
        },
      ],
    },
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
            {
              profileId: "profile-2",
              enabled: true,
              kind: "managed",
              authType: "oauth",
              label: "Personal 2",
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
            },
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
          readonly globalLastRunSettingsByHostId: Record<string, unknown>;
          readonly legacyGlobalLastRunSettings: null;
        }) => unknown,
      ) =>
        selector({
          globalLastRunSettingsByHostId: {
            "host-a": {
              harnessId: "codex",
              model: "gpt-6-sol",
              profileId: "profile-2",
              agentMode: "regular",
              permissionMode: "full_access",
              serviceTier: null,
              fastMode: false,
              workingDirectory: null,
              reasoningEffort: null,
              worktreeId: null,
            },
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
  ) => selector({ defaultPermission: "full_access", defaultServiceTier: "" }),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));

const patternLines = vi.hoisted(
  (): { patterns: boolean; blankPreviewRows: boolean } => ({
    patterns: true,
    blankPreviewRows: false,
  }),
);

vi.mock("@/hooks/providers/use-fallback-policy-pattern-lines", () => ({
  useFallbackPolicyPatternLines: () => patternLines,
}));

const previewGroupsMocks = vi.hoisted(
  (): {
    previewData: ProvidersFallbackPolicyPreviewTierGroupsResponse | undefined;
    testQuerySpy: (request: FallbackPolicyTestTierGroupsRequest | null) => void;
    testQueryData: TierCandidatePreview[] | null;
  } => ({
    previewData: undefined,
    testQuerySpy: () => {},
    testQueryData: null,
  }),
);

vi.mock(
  "@/hooks/providers/use-fallback-policy-preview-tier-groups-query",
  () => ({
    // The editor's OWN preview - what feeds the panel's `unsimulatedPreview`.
    useFallbackPolicyPreviewTierGroupsQuery: () => ({
      data: previewGroupsMocks.previewData,
      isFetching: false,
    }),
    // The Test panel's dry run.
    useFallbackPolicyTestTierGroupsQuery: (
      request: FallbackPolicyTestTierGroupsRequest | null,
    ) => {
      previewGroupsMocks.testQuerySpy(request);
      return {
        data:
          previewGroupsMocks.testQueryData === null
            ? undefined
            : { candidates: previewGroupsMocks.testQueryData },
        isFetching: false,
        isError: false,
        refetch: () => {},
      };
    },
  }),
);

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";
import {
  openFallbackTab,
  renderWithFallbackQueryClient,
} from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";

const FLAGSHIP: TierGroup = {
  id: "flagship",
  candidates: [
    { harnessId: "codex", modelFamily: "*sol*", reasoningEffort: "high" },
  ],
};
const FRONTIER: TierGroup = {
  id: "frontier",
  candidates: [
    { harnessId: "codex", modelFamily: "*astra*", reasoningEffort: "high" },
  ],
};
const STANDARD: TierGroup = {
  id: "standard",
  candidates: [
    { harnessId: "codex", modelFamily: "*terra*", reasoningEffort: "medium" },
  ],
};

/** Codex GPT-6-Sol routes into `flagship` through its `*sol*` row. */
function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    enabled: true,
    tierGroups: [FRONTIER, FLAGSHIP, STANDARD],
    defaultTierGroupId: "flagship",
    ...overrides,
  };
}

function respond(
  policyValue: FallbackPolicy,
): ProvidersFallbackPolicyGetResponse {
  return {
    policy: policyValue,
    storedPolicyUnreadable: false,
    inFlightCount: 0,
  };
}

function flagshipPreviewCandidates(): readonly TierCandidatePreview[] {
  return [
    {
      groupId: "flagship",
      candidateIndex: 0,
      harnessId: "codex",
      modelFamily: "*sol*",
      reasoningEffort: "high",
      resolvedModel: "gpt-6-sol",
      profileId: "profile-2",
      skipReason: null,
      skipLabel: null,
      warnings: [],
      matches: [
        {
          model: "gpt-6-sol",
          profileId: "profile-2",
          skipReason: null,
          skipLabel: null,
        },
      ],
    },
  ];
}

function renderPanel() {
  return renderWithFallbackQueryClient(
    <StrictMode>
      <FallbackSettingsPanel />
    </StrictMode>,
  );
}

function openTestPanel(): void {
  openFallbackTab("equivalentModels");
  fireEvent.click(screen.getByTestId("fallback-test-model-button"));
  screen.getByTestId("fallback-test-model-panel");
}

beforeEach(() => {
  fallbackMocks.queryData = respond(policy({}));
  patternLines.patterns = true;
  patternLines.blankPreviewRows = false;
  previewGroupsMocks.previewData = undefined;
  previewGroupsMocks.testQuerySpy = () => {};
  previewGroupsMocks.testQueryData = null;
});

afterEach(() => {
  cleanup();
});

describe("FallbackSettingsPanel - Test a model panel's simulates/unsimulatedPreview wiring", () => {
  it("blankPreviewRows: false - the panel never asks the host, and falls back to the EDITOR's own preview", () => {
    previewGroupsMocks.previewData = {
      candidates: [...flagshipPreviewCandidates()],
    };
    const captured: Array<FallbackPolicyTestTierGroupsRequest | null> = [];
    previewGroupsMocks.testQuerySpy = (request) => {
      captured.push(request);
    };
    renderPanel();
    openTestPanel();

    // `simulates={patternLines.blankPreviewRows}` reading `false`: the panel
    // shows the older-host fallback line rather than a live walk.
    screen.getByTestId("fallback-test-model-unsimulated");
    // Falsification: length check first - `.every` over an empty array is
    // vacuously true, so without it this would pass even if the panel's dry
    // run were never called at all.
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((request) => request === null)).toBe(true);

    // `unsimulatedPreview={previewQuery.data?.candidates ?? null}` reading
    // the EDITOR's own preview mock: the row's first match renders with
    // status "listed" straight off `previewGroupsMocks.previewData`.
    const row = screen.getByTestId("fallback-test-model-row");
    const match = within(row).getByTestId("fallback-test-model-match");
    expect(match.dataset.status).toBe("listed");
  });

  it("blankPreviewRows: true - no unsimulated line, and the dry run carries the draft's own defaultTierGroupId", () => {
    patternLines.blankPreviewRows = true;
    const captured: Array<FallbackPolicyTestTierGroupsRequest | null> = [];
    previewGroupsMocks.testQuerySpy = (request) => {
      captured.push(request);
    };
    renderPanel();
    openTestPanel();

    expect(screen.queryByTestId("fallback-test-model-unsimulated")).toBeNull();
    const nonNull = captured.filter(
      (request): request is FallbackPolicyTestTierGroupsRequest =>
        request !== null,
    );
    expect(nonNull.length).toBeGreaterThan(0);
    expect(nonNull[nonNull.length - 1].defaultTierGroupId).toBe("flagship");
  });
});
