import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
 * `useFallbackEffortOptions`, which this file is exempt from stubbing to
 * `() => []` for: rendering the real combobox-vs-textbox distinction is the
 * whole point.
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

// The one seam this suite is exempt from stubbing to `() => []` - it exercises
// exactly the control that stub keeps latent.
vi.mock(
  "@/components/settings/panels/fallback/fallback-effort-options",
  () => ({
    useFallbackEffortOptions: () => (harnessId: string) =>
      fallbackMocks.optionsByHarness.get(harnessId) ?? [],
  }),
);

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";

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
  return render(
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
    openCombobox("Effort");
    const unsupported = screen.getByTestId("fallback-effort-unsupported");
    expect(unsupported.textContent).toContain("ultra-high");
    expect(unsupported.getAttribute("data-state")).toBe("checked");
  });

  it("negative half: with ZERO options the control stays a free-text input, not a combobox", () => {
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
    // Falsification: drop the `options.length === 0` branch in
    // `EffortControl` (`fallback-tier-group-card.tsx`) so it always renders
    // the `Select` - this would then find a combobox instead of a textbox.
    expect(screen.getByRole("textbox", { name: "Effort" })).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
  });
});
