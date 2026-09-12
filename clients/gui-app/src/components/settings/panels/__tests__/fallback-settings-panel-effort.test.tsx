import { cleanup, fireEvent, screen } from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
  type ProvidersFallbackPolicySetResponse,
} from "@traycer/protocol/host/fallback-policy";
import type { AgentReasoningEffortOption } from "@traycer/protocol/host/index";

/**
 * F20 - the Effort control. Every collaborator this panel reaches through is
 * mocked at the same seams `fallback-settings-panel.test.tsx` uses, EXCEPT
 * `useFallbackCatalogOptions`, which this file is exempt from stubbing to
 * `{ modelsFor: () => [], effortsFor: () => [] }` for: rendering what the
 * Select offers - and whether it is enabled - for a real set of advertised
 * efforts is the whole point.
 */
const fallbackMocks = vi.hoisted(
  (): {
    queryData: ProvidersFallbackPolicyGetResponse | undefined;
    setMutateAsync: Mock<
      (input: {
        readonly policy: FallbackPolicy;
      }) => Promise<ProvidersFallbackPolicySetResponse>
    >;
    optionsByHarness: Map<string, readonly AgentReasoningEffortOption[]>;
  } => ({
    queryData: undefined,
    setMutateAsync: vi.fn(),
    optionsByHarness: new Map(),
  }),
);

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

vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: false,
    data: fallbackMocks.queryData,
    refetch: vi.fn(() => Promise.resolve({ data: fallbackMocks.queryData })),
  }),
}));

// The in-flight-count poll calls `useHostClient()` too, unreachable outside a
// `<HostRuntimeProvider>`. `data: undefined` leaves the panel on the count
// `queryData` above carries - this suite is about Effort, not the poll, which
// `fallback-settings-panel-in-flight-count.test.tsx` covers on its own.
vi.mock("@/hooks/providers/use-fallback-in-flight-count-query", () => ({
  useFallbackInFlightCountQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-set-mutation", () => ({
  useFallbackPolicySetMutation: () => ({
    mutateAsync: fallbackMocks.setMutateAsync,
  }),
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
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));

// The one seam this suite is exempt from stubbing to
// `{ modelsFor: () => [], effortsFor: () => [] }` - it exercises exactly the
// control that stub keeps latent. `modelsFor` stays empty throughout: this
// suite is about the Effort cell, and an empty model catalog does not change
// what `effortsFor` offers for a given harness.
vi.mock(
  "@/components/settings/panels/fallback/fallback-catalog-options",
  async (importOriginal) => {
    // `importOriginal` rather than a bare object literal: the card also
    // imports this module's `catalogModelForFamily` directly (for the
    // Model cell and the removal toast's display name), and a full mock
    // that omitted it would leave that import `undefined` at every call
    // site, not just the hook under test here.
    const actual =
      await importOriginal<
        typeof import("@/components/settings/panels/fallback/fallback-catalog-options")
      >();
    return {
      ...actual,
      useFallbackCatalogOptions: () => ({
        modelsFor: () => [],
        effortsFor: (harnessId: string) =>
          fallbackMocks.optionsByHarness.get(harnessId) ?? [],
      }),
    };
  },
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessModelsQuery: () => ({ data: undefined }),
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";
import {
  openFallbackTab,
  renderWithFallbackQueryClient,
} from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), enabled: true, ...overrides };
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

function renderPanel() {
  return renderWithFallbackQueryClient(
    <StrictMode>
      <FallbackSettingsPanel />
    </StrictMode>,
  );
}

function openCombobox(name: string): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), {
    key: "ArrowDown",
  });
}

function chooseOption(name: string): void {
  const item = screen.getByRole("option", { name });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

beforeEach(() => {
  fallbackMocks.setMutateAsync.mockReset();
  fallbackMocks.setMutateAsync.mockResolvedValue({ policy: policy({}) });
  fallbackMocks.optionsByHarness = new Map();
});

afterEach(() => {
  cleanup();
});

describe("FallbackSettingsPanel - F20 the Effort control", () => {
  it("is a combobox listing the harness's advertised efforts plus 'Any effort' when the catalog answered", () => {
    fallbackMocks.optionsByHarness.set("claude", [
      { id: "high", label: "High", description: null },
    ]);
    fallbackMocks.queryData = respond(
      policy({
        tierGroups: [
          {
            id: "fast",
            candidates: [
              {
                harnessId: "claude",
                modelFamily: "opus",
                reasoningEffort: null,
              },
            ],
          },
        ],
      }),
    );
    renderPanel();
    openFallbackTab("equivalentModels");
    expect(screen.getByRole("combobox", { name: "Effort" })).not.toBeNull();
    openCombobox("Effort");
    expect(screen.getByRole("option", { name: "Any effort" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "High" })).not.toBeNull();
  });

  it("picking an option commits reasoningEffort as the option's ID, not its label", () => {
    fallbackMocks.optionsByHarness.set("claude", [
      { id: "high", label: "High effort", description: null },
    ]);
    fallbackMocks.queryData = respond(
      policy({
        tierGroups: [
          {
            id: "fast",
            candidates: [
              {
                harnessId: "claude",
                modelFamily: "opus",
                reasoningEffort: null,
              },
            ],
          },
        ],
      }),
    );
    renderPanel();
    openFallbackTab("equivalentModels");
    openCombobox("Effort");
    chooseOption("High effort");
    // Falsification: commit `option.label` instead of `option.id` in
    // `EffortControl`'s `onValueChange` (`fallback-tier-group-card.tsx`) -
    // this would then send "High effort" instead of "high".
    expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    const call = fallbackMocks.setMutateAsync.mock.calls[0][0];
    expect(call.policy.tierGroups[0].candidates[0].reasoningEffort).toBe(
      "high",
    );
  });

  it("a stored value the catalog does not offer gets its own option and stays selected", () => {
    fallbackMocks.optionsByHarness.set("claude", [
      { id: "high", label: "High", description: null },
    ]);
    fallbackMocks.queryData = respond(
      policy({
        tierGroups: [
          {
            id: "fast",
            candidates: [
              {
                harnessId: "claude",
                modelFamily: "opus",
                reasoningEffort: "ultra-high",
              },
            ],
          },
        ],
      }),
    );
    renderPanel();
    openFallbackTab("equivalentModels");
    openCombobox("Effort");
    const unsupported = screen.getByTestId("fallback-effort-unsupported");
    expect(unsupported.textContent).toContain("ultra-high");
    expect(unsupported.getAttribute("data-state")).toBe("checked");
  });

  it("with ZERO options and no stored value, the Effort control is a disabled Select showing 'Any effort'", () => {
    // No entry in `optionsByHarness` for "claude" - the documented "no
    // answer" state.
    fallbackMocks.queryData = respond(
      policy({
        tierGroups: [
          {
            id: "fast",
            candidates: [
              {
                harnessId: "claude",
                modelFamily: "opus",
                reasoningEffort: null,
              },
            ],
          },
        ],
      }),
    );
    renderPanel();
    openFallbackTab("equivalentModels");
    const trigger = screen.getByRole("combobox", { name: "Effort" });
    // Falsification: drop the `options.length === 0 && stored === null` guard
    // in `EffortControl` (`fallback-tier-group-card.tsx`) so the control is
    // always enabled - this assertion would then find an enabled control.
    expect(trigger.hasAttribute("disabled")).toBe(true);
    // Falsification: select a value other than `ANY_EFFORT_VALUE` when
    // `stored` is `null` - the trigger's rendered text would then be
    // something other than the "Any effort" item's own label.
    expect(trigger.textContent).toBe("Any effort");
  });

  it("with ZERO options but a value already stored, the Effort control stays enabled", () => {
    // No entry in `optionsByHarness` for "claude" - same "no answer" state as
    // the disabled case above - but this row's own effort IS stored, which is
    // the other half of `EffortControl`'s `disabled` condition
    // (`options.length === 0 && stored === null`).
    fallbackMocks.queryData = respond(
      policy({
        tierGroups: [
          {
            id: "fast",
            candidates: [
              {
                harnessId: "claude",
                modelFamily: "opus",
                reasoningEffort: "ultra-high",
              },
            ],
          },
        ],
      }),
    );
    renderPanel();
    openFallbackTab("equivalentModels");
    // Falsification: drop `stored === null` from the `disabled` ternary,
    // leaving `options.length === 0` alone - this control would then be
    // disabled even though a value is stored, and clearing it would become
    // impossible.
    expect(
      screen.getByRole("combobox", { name: "Effort" }).hasAttribute("disabled"),
    ).toBe(false);
  });
});
