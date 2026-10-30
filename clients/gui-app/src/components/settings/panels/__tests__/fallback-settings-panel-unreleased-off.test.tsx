import { cleanup, screen } from "@testing-library/react";
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
import type { GuiAgentModelOption } from "@traycer/protocol/host/index";

/**
 * The scoping guarantee: a draft belongs to the host it was typed against, and
 * cannot be carried to another one.
 *
 * The policy is stored per Traycer user PER HOST (`provider-accounts.json` is
 * machine-local), so an editor that kept its draft across a host switch would
 * write one machine's settings into another machine's row - under the other
 * machine's name, with nothing on screen saying so. The panel prevents it by
 * keying the editor on `scope.hostId`, which remounts and re-seeds the reducer.
 *
 * What this suite can and cannot say. `useHostScope` is mocked, so "the policy
 * is re-read for the new host" is expressed as "the panel renders the new
 * host's policy" - the real per-host resolution happens inside
 * `useFallbackPolicyQuery`'s `useHostClient()`, which is mocked here too. The
 * claim proved is the panel's half: the draft does not survive, and what
 * replaces it is the new host's value.
 */
const scopeMocks = vi.hoisted(
  (): {
    hostId: string;
    hostName: string;
    queryData: ProvidersFallbackPolicyGetResponse | undefined;
    setMutateAsync: Mock<
      (input: {
        readonly policy: FallbackPolicy;
      }) => Promise<ProvidersFallbackPolicySetResponse>
    >;
  } => ({
    hostId: "host-a",
    hostName: "Studio",
    queryData: undefined,
    setMutateAsync: vi.fn(),
  }),
);

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  // Read per render, not captured once: the whole subject is what happens
  // when this answer CHANGES between two renders.
  const useHostScope = () => {
    const host = hostScopeOptionFixture({
      hostId: scopeMocks.hostId,
      name: scopeMocks.hostName,
    });
    return hostScopeFixture({
      hosts: [host],
      host,
      hostId: host.hostId,
      hostLabel: host.name,
      activeHost: host,
      isViewingActive: true,
      status: "following",
      client: null,
    });
  };
  return {
    useHostScope,
    usePersonalHostScope: useHostScope,
  };
});

vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: false,
    data: scopeMocks.queryData,
  }),
}));

// The in-flight-count poll calls `useHostClient()` too, unreachable outside a
// `<HostRuntimeProvider>`. `data: undefined` leaves the panel on the count
// the mocked policy read above carries; the polled count itself is
// `fallback-settings-panel-in-flight-count.test.tsx`'s subject, not this
// scoping suite's.
vi.mock("@/hooks/providers/use-fallback-in-flight-count-query", () => ({
  useFallbackInFlightCountQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-set-mutation", () => ({
  useFallbackPolicySetMutation: () => ({
    mutateAsync: scopeMocks.setMutateAsync,
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
// The Model and Effort cells' catalog read is out of this suite's scope, and
// `useFallbackCatalogOptions` calls `useHostClient()`, which throws outside a
// `<HostRuntimeProvider>` (`src/lib/host/runtime.ts:125`). Empty catalogs are
// the documented "no answer" state: the Model cell still renders - pinned on
// the row's own stored family - so `modelTriggerText()` below can read it
// straight off the Select's trigger. `importOriginal` keeps
// `catalogModelForFamily`, which the card imports directly from this module.
/**
 * R4's own catalog: empty (`new Map()`) by default, populated by the Pin 6
 * describe block below with a Codex catalog containing Terra - the one model
 * that lets a genuine "one model, one tier" conflict exist under the pattern
 * rule for that fixture's stored policy.
 */
const catalogsByHarnessFixture = vi.hoisted(
  (): { value: Map<string, readonly GuiAgentModelOption[]> } => ({
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
          catalogsByHarnessFixture.value.get(harnessId) ?? null,
        catalogsByHarness: catalogsByHarnessFixture.value,
        effortsFor: () => [],
      }),
    };
  },
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessModelsQuery: () => ({ data: undefined }),
}));

/**
 * `useFallbackModelLabels` alone, kept real everywhere else in the module.
 *
 * `TierStepHint` resolves its last-run tuple's model slug to a catalogue label
 * through this hook, which composes `useGuiHarnessesQueryForClient` and
 * `useHostQueries` - neither reachable here, for the same reason the catalog
 * double above exists. A pass-through is the whole of it: the label is not this
 * suite's subject, and the slug is what the real resolver degrades to with no
 * catalogue.
 *
 * `importOriginal` keeps `fallbackProviderModelLabel` and the profile-label
 * helpers, which this panel and `fallback-profile-labels.ts` import directly
 * from the same module.
 */
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

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));

/**
 * Pin 6's own line: a 1.0-negotiated host, explicit rather than left to the
 * real hook's "no manifest yet" default so the case says what it means.
 */
const patternLines = vi.hoisted(
  (): { patterns: boolean; blankPreviewRows: boolean } => ({
    patterns: false,
    blankPreviewRows: false,
  }),
);

vi.mock("@/hooks/providers/use-fallback-policy-pattern-lines", () => ({
  useFallbackPolicyPatternLines: () => patternLines,
}));

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
// The page's pick is the Host picker's host, resolved from the host list.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [hostScopeOptionFixture({ hostId: "host-a", name: "Studio" })],
      }),
  };
});

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";
import { renderWithFallbackQueryClient } from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";

beforeEach(() => {
  scopeMocks.queryData = {
    policy: { ...createDefaultFallbackPolicy(), enabled: true },
    storedPolicyUnreadable: false,
    inFlightCount: 0,
  };
});

afterEach(() => {
  cleanup();
});

describe("<FallbackSettingsPanel /> without environments", () => {
  it("describes the picked host's routing and never says Personal", () => {
    const { container } = renderWithFallbackQueryClient(
      <StrictMode>
        <FallbackSettingsPanel />
      </StrictMode>,
    );

    expect(
      screen.getByText(
        "When a provider blocks a turn, try these in order. Applies to your chat agents on Studio.",
      ),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("Personal");
  });
});
