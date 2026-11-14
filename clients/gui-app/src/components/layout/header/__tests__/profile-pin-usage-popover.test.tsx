import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ProviderId,
  ProviderProfile,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  pinProfile,
  providerState,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import { NO_EPISODE } from "@/lib/rate-limits/rate-limit-envelope";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";

/**
 * A cached usage reading the popover's profile card paints. `errorUpdateCount`
 * is what the status-bar segment hook reads off the same query double.
 */
interface UsageQueryDouble {
  readonly data: ProviderRateLimitEnvelope | undefined;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly errorUpdateCount: number;
  readonly dataUpdatedAt: number;
  readonly refetch: () => Promise<unknown>;
}

interface ProviderUsageParams {
  readonly providerId: string;
  readonly profileId: string | null;
}

const USAGE_UPDATED_AT = Date.now();

const usageByTarget = vi.hoisted(() => new Map<string, UsageQueryDouble>());

const providersHolder = vi.hoisted(() => ({
  providers: [] as ProvidersListResponse["providers"],
}));

function isProviderUsageParams(params: object): params is ProviderUsageParams {
  return (
    "providerId" in params &&
    typeof params.providerId === "string" &&
    "profileId" in params &&
    (params.profileId === null || typeof params.profileId === "string")
  );
}

function usageTargetKey(providerId: string, profileId: string | null): string {
  return profileId === null ? providerId : `${providerId}:${profileId}`;
}

function idleUsageQuery(): UsageQueryDouble {
  return {
    data: undefined,
    isPending: false,
    isFetching: false,
    isError: false,
    errorUpdateCount: 0,
    dataUpdatedAt: 0,
    refetch: () => Promise.resolve({}),
  };
}

function usageQueryFor(params: object): UsageQueryDouble {
  if (!isProviderUsageParams(params)) return idleUsageQuery();
  return (
    usageByTarget.get(usageTargetKey(params.providerId, params.profileId)) ??
    idleUsageQuery()
  );
}

function queriesFor(args: {
  readonly requests: ReadonlyArray<{ readonly params: object }>;
}): UsageQueryDouble[] {
  return args.requests.map((request) => usageQueryFor(request.params));
}

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: {
      providers: providersHolder.providers,
      native: null,
    },
  }),
  useProvidersListForClient: () => ({
    data: {
      providers: providersHolder.providers,
      native: null,
    },
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: queriesFor,
  useHostQueriesWithResponseMap: queriesFor,
}));

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    isPending: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: () => Promise.resolve({}),
  }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: (args: {
      readonly select: (state: {
        readonly location: { readonly pathname: string };
      }) => unknown;
    }) => args.select({ location: { pathname: "/" } }),
  };
});

vi.mock(
  "@/lib/rate-limits/provider-rate-limit-fetch",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/rate-limits/provider-rate-limit-fetch")
      >();
    return {
      ...actual,
      fetchProviderRateLimits: () => Promise.resolve(),
    };
  },
);

import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";

const CODEX_PROFILE_ID = "work-row";
const QWEN_PROFILE_ID = "home-row";

function namedProfile(input: {
  readonly profileId: string;
  readonly label: string;
  readonly otherNames: readonly string[];
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases: [],
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: input.otherNames,
  });
}

function listedProvider(input: {
  readonly providerId: ProviderId;
  readonly profiles: readonly ProviderProfile[];
}): ProvidersListResponse["providers"][number] {
  return {
    ...providerState({
      providerId: input.providerId,
      authStatus: "authenticated",
      profiles: input.profiles,
    }),
    usageReporting: true,
  };
}

providersHolder.providers = [
  listedProvider({
    providerId: "codex",
    profiles: [
      namedProfile({
        profileId: CODEX_PROFILE_ID,
        label: "Work",
        otherNames: ["Side desk"],
      }),
    ],
  }),
  listedProvider({
    providerId: "qwen",
    profiles: [
      namedProfile({
        profileId: QWEN_PROFILE_ID,
        label: "Home",
        otherNames: ["Night desk"],
      }),
    ],
  }),
];

function codexUsage(): Extract<ProviderRateLimits, { available: true }> {
  return {
    provider: "codex",
    available: true,
    planType: "pro_5x",
    limitId: null,
    limitName: null,
    primary: {
      usedPercent: 4,
      resetsAt: USAGE_UPDATED_AT + 60 * 60 * 1000,
      durationMinutes: 300,
    },
    secondary: null,
    extraWindows: [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: null,
  };
}

function readyUsage(
  limits: Extract<ProviderRateLimits, { available: true }>,
): UsageQueryDouble {
  return {
    data: {
      latest: limits,
      lastGood: limits,
      lastGoodAt: USAGE_UPDATED_AT,
      lastFailureAt: null,
      credentialGeneration: null,
      episode: NO_EPISODE,
    },
    isPending: false,
    isFetching: false,
    isError: false,
    errorUpdateCount: 0,
    dataUpdatedAt: USAGE_UPDATED_AT,
    refetch: () => Promise.resolve({}),
  };
}

const PROFILE_SELECTION: RateLimitProfileSelection = {
  shownProfiles: {},
  lastProfileByHarness: {},
};

function sectionOf(card: HTMLElement): HTMLElement {
  let node: HTMLElement | null = card.parentElement;
  while (node !== null) {
    if (
      node.className.includes("flex-col") &&
      node.className.includes("gap-4")
    ) {
      return node;
    }
    node = node.parentElement;
  }
  throw new Error("profile card is not inside a usage section");
}

function renderPopover(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Popover open>
          <PopoverTrigger>trigger</PopoverTrigger>
          <RateLimitPopover
            side="bottom"
            align="end"
            onClose={() => undefined}
            profileSelection={PROFILE_SELECTION}
            scope={hostScopeFixture({})}
            hasExplicitPick={false}
          />
        </Popover>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("RateLimitPopover other names", () => {
  afterEach(() => {
    cleanup();
    usageByTarget.clear();
    useRateLimitPopoverStore.setState({ activeTab: "overview" });
  });

  it("draws an other-name chip on the card with usage and on the card that is not reporting", async () => {
    usageByTarget.set(
      usageTargetKey("codex", CODEX_PROFILE_ID),
      readyUsage(codexUsage()),
    );
    useRateLimitPopoverStore.setState({ activeTab: "overview" });

    renderPopover();

    const usageCard = await screen.findByTestId(
      `rate-limit-profile-card-codex-${CODEX_PROFILE_ID}`,
    );
    const quietCard = screen.getByTestId(
      `rate-limit-profile-card-qwen-${QWEN_PROFILE_ID}`,
    );
    await waitFor(() => {
      expect(sectionOf(usageCard).className).not.toContain("hidden");
      expect(sectionOf(quietCard).className).not.toContain("hidden");
    });

    expect(within(usageCard).getByText("Work")).toBeTruthy();
    expect(within(usageCard).getByText("Side desk")).toBeTruthy();
    expect(within(usageCard).getByText("4% used")).toBeTruthy();
    expect(
      within(usageCard).queryByText("Not reporting usage yet."),
    ).toBeNull();

    expect(within(quietCard).getByText("Home")).toBeTruthy();
    expect(within(quietCard).getByText("Night desk")).toBeTruthy();
    expect(
      within(quietCard).getByText("Not reporting usage yet."),
    ).toBeTruthy();
    expect(within(quietCard).queryByText("4% used")).toBeNull();
  });
});
