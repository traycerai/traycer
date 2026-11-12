import { cleanup, render, screen, within } from "@testing-library/react";
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
    bound: boolean;
  } => ({ providers: [], plans: [], cards: [], bound: true }),
);
vi.mock("@/hooks/environment/team/use-team-viewing-host", () => ({
  useTeamViewingHost: () => ({
    viewingHost: reads.bound ? { hostId: "host-b", hostLabel: "Studio" } : null,
    client: reads.bound ? {} : null,
    hosts: {
      isError: false,
      isPending: false,
      data: { hosts: [] },
      refetch: () => Promise.resolve(),
    },
    selectHost: () => undefined,
    canSelectHost: () => false,
  }),
  canSwitchViewingHost: () => false,
}));
vi.mock("@/components/settings/environment/team-viewing-host-binding", () => ({
  TeamViewingHostBinding: (props: {
    readonly children: ReactNode;
    readonly unavailable: ReactNode;
  }) => (reads.bound ? props.children : props.unavailable),
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

const POOL: Extract<ConfigurationSource, { readonly kind: "pool" }> = {
  kind: "pool",
  configuration: "team",
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

function renderFacts(canEdit: boolean): void {
  render(
    <ConfigurationSourceContext.Provider
      value={{ ...POOL, effectiveRole: canEdit ? "admin" : null }}
    >
      <TeamProviderLiveFacts providerId="claude-code" />
    </ConfigurationSourceContext.Provider>,
  );
}

beforeEach(() => {
  reads.providers = [];
  reads.plans = [];
  reads.cards = [];
  reads.bound = true;
});

function rateCard(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "Rate limits" });
  const section = heading.closest("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("rate limits section missing");
  }
  return section;
}

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
    renderFacts(true);

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
    renderFacts(true);

    expect(reads.cards).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe(
      "Sign in on Providers to see Acme's rate limits.",
    );
  });

  it("asks a teammate to sign in when a non-editor has no linked team plan", () => {
    reads.providers = [
      claude([profile("ambient", "ambient", "authenticated")], "authenticated"),
    ];
    renderFacts(false);

    expect(screen.getByRole("status").textContent).toBe(
      "Ask a teammate to sign in on Providers.",
    );
    expect(
      screen.queryByText("Sign in on Providers to see Acme's rate limits."),
    ).toBe(null);
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
    renderFacts(true);

    expect(reads.cards).toEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(rateCard().textContent).not.toContain("uses:");
    expect(rateCard().textContent).not.toContain("Executable");
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("shows the binary the viewing host reported inside Rate limits", () => {
    reads.providers = [
      {
        ...claude(
          [profile("ambient", "ambient", "authenticated")],
          "authenticated",
        ),
        nextRunBinary: {
          kind: "path",
          path: "/usr/local/bin/claude",
          version: "1.2.3",
        },
      },
    ];
    renderFacts(true);

    expect(
      within(rateCard()).getByText(
        "Studio uses: /usr/local/bin/claude · 1.2.3.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("names the included agent and omits a null version", () => {
    reads.providers = [
      {
        ...claude([], "unknown"),
        nextRunBinary: { kind: "bundled", path: null, version: null },
      },
    ];
    renderFacts(true);

    expect(
      within(rateCard()).getByText("Studio uses: Included agent."),
    ).toBeTruthy();
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("omits the binary line when the host reported no binary", () => {
    reads.providers = [
      {
        ...claude([], "unknown"),
        nextRunBinary: null,
      },
    ];
    renderFacts(true);

    expect(screen.getByRole("heading", { name: "Rate limits" })).toBeTruthy();
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("omits the binary line when no viewing host is bound", () => {
    reads.bound = false;
    reads.providers = [
      {
        ...claude([], "unknown"),
        nextRunBinary: {
          kind: "path",
          path: "/usr/local/bin/claude",
          version: "1.2.3",
        },
      },
    ];
    renderFacts(true);

    expect(screen.getByRole("heading", { name: "Rate limits" })).toBeTruthy();
    expect(screen.queryByText("Details")).toBeNull();
    expect(screen.queryByText(/Studio uses:/)).toBeNull();
  });
});
