import { cleanup, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
} from "@traycer/protocol/host/fallback-policy";

/**
 * Settings ▸ Host ▸ Model routing on a team computer (A13): routing there is
 * the team's, one setting for everyone who works on that machine, so the page
 * reads it out and offers nothing to change - no editor, no master toggle, no
 * Danger Zone and no action. Covers the panel's `source` branch both ways:
 * {@link FallbackTeamRoutingInEffect} on `"team"`, the real editor on
 * `"own"`. The host's own refusal of the three writes is proven at the
 * resolvers (`provider-fallback-policy-resolvers-team-host.test.ts`), which
 * is where a client too old to read `source` meets it.
 *
 * Mocking follows `fallback-settings-panel-host-scope.test.tsx`:
 * `useFallbackPolicyQuery` is a static double, not the real `QueryClient`
 * cache, so each case sets `scopeMocks.queryData` and mounts. Everything from
 * `HostScopeGate` inward is the real panel.
 */
const scopeMocks = vi.hoisted(
  (): {
    hostId: string;
    hostName: string;
    queryData: ProvidersFallbackPolicyGetResponse | undefined;
  } => ({
    hostId: "host-a",
    hostName: "Studio",
    queryData: undefined,
  }),
);

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
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
        catalogFor: () => null,
        catalogsByHarness: new Map(),
        effortsFor: () => [],
      }),
    };
  },
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessModelsQuery: () => ({ data: undefined }),
}));
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

vi.mock("@/hooks/providers/use-fallback-policy-pattern-lines", () => ({
  useFallbackPolicyPatternLines: (): {
    patterns: boolean;
    blankPreviewRows: boolean;
  } => ({ patterns: false, blankPreviewRows: false }),
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { renderWithFallbackQueryClient } from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";

/** Distinct values for every setting asserted below - the ladder, both
 * durations, the return mode and the tier group - so each reading off the
 * screen comes from this policy and not from the default the panel falls back
 * to. (`enabled` is true in the default too, and is not one of them.) */
function teamPolicy(): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    enabled: true,
    ladder: ["tier", "profile", "notify"],
    graceWindowSeconds: 77,
    maxWaitMinutes: 222,
    returnToPreferred: "auto",
    // One tier, with the two effort cases a candidate can hold: a level the
    // team chose, and `null` - no effort constraint, which the editor's own
    // control calls "Any effort".
    tierGroups: [
      {
        id: "team-flagship",
        candidates: [
          {
            harnessId: "codex",
            modelFamily: "gpt-team",
            reasoningEffort: "high",
          },
          {
            harnessId: "claude",
            modelFamily: "opus-team",
            reasoningEffort: null,
          },
        ],
      },
    ],
    defaultTierGroupId: "team-flagship",
  };
}

function ownResponse(): ProvidersFallbackPolicyGetResponse {
  return {
    policy: { ...createDefaultFallbackPolicy(), enabled: true },
    storedPolicyUnreadable: false,
    inFlightCount: 0,
    source: "own",
  };
}

function teamResponse(): ProvidersFallbackPolicyGetResponse {
  return {
    policy: teamPolicy(),
    storedPolicyUnreadable: false,
    inFlightCount: 0,
    source: "team",
  };
}

/**
 * What the host actually serves when the team's stored row could not be read:
 * `createRoutingOffFallbackPolicy()`, the product defaults with routing off
 * (`profile-store.ts`). Carrying the real answer rather than a policy of our
 * own is what lets the case assert the LINE's wording - "default settings,
 * with automatic routing off" is a claim about these values, and a fixture
 * holding an enabled custom policy would render that sentence beside values
 * contradicting it and still pass.
 */
function unreadableTeamResponse(): ProvidersFallbackPolicyGetResponse {
  return {
    policy: { ...createDefaultFallbackPolicy(), enabled: false },
    storedPolicyUnreadable: true,
    inFlightCount: 0,
    source: "team",
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
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: "host-a", hostName: "Studio" },
  });
  scopeMocks.hostId = "host-a";
  scopeMocks.hostName = "Studio";
  scopeMocks.queryData = undefined;
});

afterEach(() => {
  cleanup();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("FallbackSettingsPanel - source: own", () => {
  it("mounts the editor with no team read-out", () => {
    scopeMocks.queryData = ownResponse();
    renderPanel();

    expect(
      screen.getByRole("switch", { name: "Route automatically" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("fallback-team-routing-in-effect")).toBeNull();
    expect(screen.queryByText(/Your team's routing/)).toBeNull();
  });
});

describe("FallbackSettingsPanel - source: team", () => {
  it("reads the team's policy out, with nothing on screen to change it", () => {
    scopeMocks.queryData = teamResponse();
    renderPanel();

    const readOut = screen.getByTestId("fallback-team-routing-in-effect");
    expect(screen.getByText("Your team's routing")).toBeTruthy();
    expect(
      screen.getByText(
        "Model routing on this computer is set for the whole team, on the team's page.",
      ),
    ).toBeTruthy();
    // Values that differ from every default, so this cannot pass against a
    // policy the panel invented on its own.
    expect(
      screen.getByText(/Try these in order: tier → profile → notify/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Time to cancel: 77 seconds\. Maximum wait: 222 minutes\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Return to preferred: auto\./)).toBeTruthy();
    // The tiers, which are the whole of what the team actually routes to, and
    // the two effort spellings. A null effort reads as the setting it is, not
    // as a row trailing off after its separator.
    expect(screen.getByText("team-flagship")).toBeTruthy();
    expect(screen.getByText("codex · gpt-team · high")).toBeTruthy();
    expect(screen.getByText("claude · opus-team · Any effort")).toBeTruthy();
    expect(
      screen.getByText("For a model not in any tier: team-flagship"),
    ).toBeTruthy();

    // No editor and no action. The master switch and the Danger Zone are the
    // editor's; the third assertion is the whole of "no action", since a
    // member has no per-member routing to take over to and a save would be
    // refused by the host anyway.
    expect(
      screen.queryByRole("switch", { name: "Route automatically" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reset to default" }),
    ).toBeNull();
    expect(within(readOut).queryAllByRole("button")).toEqual([]);
    // Nothing claims the stored policy was unreadable when it was not.
    expect(screen.queryByTestId("fallback-team-policy-unreadable")).toBeNull();
  });

  it("with storedPolicyUnreadable: true says so in the read-out, over values that bear the claim out, and still mounts no editor", () => {
    scopeMocks.queryData = unreadableTeamResponse();
    renderPanel();

    // An unreadable row changes nothing about whose routing this is: there is
    // no own routing for this member to set instead, so the read-out stays
    // and says that the values below are defaults with routing off rather
    // than the team's decision.
    const readOut = screen.getByTestId("fallback-team-routing-in-effect");
    expect(screen.getByTestId("fallback-team-policy-unreadable")).toBeTruthy();
    expect(
      screen.getByText("Your team's saved routing couldn't be read"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This computer is running the default settings below, with automatic routing off. Saving the team's routing again replaces the settings we couldn't read.",
      ),
    ).toBeTruthy();
    // That sentence is a claim about the read-out beneath it, so the read-out
    // has to bear it out: routing off, and no tier of the team's.
    expect(screen.getByText("Route automatically: Off")).toBeTruthy();
    expect(screen.queryByText("team-flagship")).toBeNull();
    expect(
      screen.getByText("For a model not in any tier: None - skip this step"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Route automatically" }),
    ).toBeNull();
    expect(within(readOut).queryAllByRole("button")).toEqual([]);
  });
});
