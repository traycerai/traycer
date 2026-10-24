import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentPlan } from "@traycer/protocol/host/environment/configuration-contracts";
import type {
  ProviderAuthStatus,
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { TeamProviderLiveFacts } from "@/components/settings/environment/team-provider-live-facts";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";

// The viewing host, its providers, the team's plans and the usage card are
// the boundaries: the card reads `host.getRateLimitUsage` for the profile
// it is handed, so what it is handed is what this suite observes.
const reads = vi.hoisted(
  (): {
    providers: ProviderCliState[];
    plans: EnvironmentPlan[];
    cards: Array<{
      readonly profileId: string | null;
      readonly fetchEligible: boolean;
      readonly usageUpdatedAt: number | null;
    }>;
  } => ({ providers: [], plans: [], cards: [] }),
);
vi.mock("@/hooks/environment/team/use-team-viewing-host", () => ({
  useTeamViewingHost: () => ({
    viewingHost: { hostId: "host-b", hostLabel: "Studio" },
    client: {},
  }),
}));
vi.mock("@/components/settings/environment/team-viewing-host-binding", () => ({
  TeamViewingHostBinding: (props: { readonly children: ReactNode }) =>
    props.children,
}));
vi.mock("@/components/settings/environment/team-viewing-host-picker", () => ({
  TeamViewingHostPicker: () => null,
}));
vi.mock("@/components/settings/environment/team-pick-label", () => ({
  usePickedTeamLabel: () => "Acme",
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: { providers: reads.providers },
    isError: false,
  }),
}));
vi.mock("@/hooks/environment/team/use-plans-query", () => ({
  useConfigurationPlansQuery: () => ({
    data: { plans: reads.plans },
    isError: false,
  }),
}));
vi.mock("@/components/settings/panels/provider-rate-limit-section", () => ({
  ProviderRateLimitForProvider: (props: {
    readonly profileId: string | null;
    readonly fetchEligible: boolean;
    readonly usageUpdatedAt: number | null;
  }): ReactNode => {
    reads.cards.push({
      profileId: props.profileId,
      fetchEligible: props.fetchEligible,
      usageUpdatedAt: props.usageUpdatedAt,
    });
    return <div data-testid={`limits-${props.profileId ?? "ambient"}`} />;
  },
}));

const POOL: ConfigurationSource = {
  kind: "pool",
  environmentId: "env-a",
  roomId: "room-a",
  providerHandle: "handle-a",
  effectiveRole: "admin",
};

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
  status: ProviderAuthStatus,
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label: profileId,
    auth: { status, badgeText: null, label: null, detail: null },
    identity: null,
    usageUpdatedAt: kind === "managed" ? 1_700 : null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

function claude(
  profiles: ProviderProfile[],
  status: ProviderAuthStatus,
): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles,
    auth: { status, badgeText: null, label: null, detail: null },
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
  };
}

const linkedPlan: EnvironmentPlan = {
  profileId: "team-plan",
  harness: "claude",
  status: "linked",
  linkedBy: { name: "Ada", you: false },
};

function renderFacts(): void {
  render(
    <ConfigurationSourceContext.Provider value={POOL}>
      <TeamProviderLiveFacts providerId="claude-code" />
    </ConfigurationSourceContext.Provider>,
  );
}

beforeEach(() => {
  reads.providers = [];
  reads.plans = [];
  reads.cards = [];
});

afterEach(() => {
  cleanup();
});

describe("TeamProviderLiveFacts", () => {
  it("reads the linked plan's own profile on a host with no ambient login", () => {
    reads.plans = [linkedPlan];
    reads.providers = [
      claude(
        [
          profile("ambient", "ambient", "unauthenticated"),
          profile("team-plan", "managed", "authenticated"),
        ],
        "unauthenticated",
      ),
    ];
    renderFacts();

    expect(screen.getByTestId("limits-team-plan")).not.toBeNull();
    expect(reads.cards.at(-1)).toEqual({
      profileId: "team-plan",
      fetchEligible: true,
      usageUpdatedAt: 1_700,
    });
    expect(reads.cards.some((card) => card.profileId === null)).toBe(false);
  });

  it("never shows a host's ambient login as the team's limits when the team has no linked plan", () => {
    reads.providers = [
      claude([profile("ambient", "ambient", "authenticated")], "authenticated"),
    ];
    renderFacts();

    expect(reads.cards).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe(
      "Link a plan to Acme to see its rate limits.",
    );
  });

  it("draws nothing for a linked plan with no profile of the same id on the host", () => {
    // A copy the host received through profile sync has its own local id,
    // and `providers.list` names only that one, so no claim about the plan
    // can be made from here.
    reads.plans = [linkedPlan];
    reads.providers = [
      claude(
        [
          profile("ambient", "ambient", "authenticated"),
          profile("synced-copy", "managed", "authenticated"),
        ],
        "authenticated",
      ),
    ];
    renderFacts();

    expect(reads.cards).toEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
