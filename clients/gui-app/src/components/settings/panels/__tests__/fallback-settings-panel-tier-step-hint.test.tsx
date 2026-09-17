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
  useComposerRunSettingsStore.getState().resetForTests();
});

afterEach(() => {
  useComposerRunSettingsStore.getState().resetForTests();
  cleanup();
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
