import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProfileRateLimitSwitchPrompt } from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { ChatComposerBannerPortalProvider } from "@/components/chat/composer/chat-composer-banner-portal";
import { ChatComposerFallbackBanners } from "@/components/chat/fallback/chat-composer-fallback-banners";
import {
  composerRateLimitAdvisory,
  returnBannerLowUsage,
  type ComposerRateLimitAdvisory,
} from "@/components/chat/fallback/fallback-return-low-usage";
import {
  FAILED_CLAUDE_TUPLE,
  PREFERRED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  chatRunSettings,
  pendingFallback,
  pendingReturn,
  providerProfile,
} from "./fallback-fixtures";

// The banners fill both cards' `menu` slots, so the real destination menu
// mounts here even while closed - and its list query reaches for a QueryClient
// this suite has no reason to stand up. Faked at the same seam the menu and
// manual-rung suites use. Nothing moves: what THIS suite pins is which CARD
// renders for a given state, and the menu's own behaviour has its own file.
vi.mock("@/components/chat/fallback/use-fallback-targets", () => ({
  useFallbackListTargets: () => ({
    data: undefined,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

function pendingAt(
  state: "retrying" | "hold" | "choosing" | "switching" | "waiting",
) {
  return pendingFallback({
    state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: Date.now() + 30_000,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: "traversal-composer",
    revision: 1,
  });
}

function renderBanners(input: {
  readonly topBannerKind: "fallback" | "fallback-return" | "none";
  readonly pending: PendingFallback | undefined;
  readonly pendingReturn: PendingReturn | undefined;
  readonly rateLimitAdvisory: ComposerRateLimitAdvisory | null;
}) {
  return render(
    <ChatComposerBannerPortalProvider>
      <ChatComposerFallbackBanners
        topBannerKind={input.topBannerKind}
        fallback={{
          pending: input.pending,
          pendingReturn: input.pendingReturn,
        }}
        rateLimitAdvisory={input.rateLimitAdvisory}
        client={null}
        chatId="chat-composer"
        epicId="epic-composer"
        hostId="tab-host-b"
        canAct
      />
    </ChatComposerBannerPortalProvider>,
  );
}

function visiblePrompt(input: {
  readonly providerId: "claude-code" | "codex";
  readonly severity: "near_limit" | "hard_limit";
  readonly limitedFamilies: ReadonlyArray<string>;
  readonly current: ProviderProfile;
}): Extract<ProfileRateLimitSwitchPrompt, { kind: "visible" }> {
  return {
    kind: "visible",
    warningKey: "warning-key",
    providerId: input.providerId,
    severity: input.severity,
    limitedFamilies: input.limitedFamilies,
    current: input.current,
    profiles: [input.current],
    destinations: [],
    primaryTarget: null,
    probeTarget: null,
    dismiss: () => undefined,
  };
}

describe("ChatComposerFallbackBanners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the grace card for hold and the waiting card for waiting", () => {
    const { unmount } = renderBanners({
      topBannerKind: "fallback",
      pending: pendingAt("hold"),
      pendingReturn: undefined,
      rateLimitAdvisory: null,
    });
    expect(screen.getByTestId("fallback-grace-card")).toBeDefined();
    expect(screen.queryByTestId("fallback-waiting-card")).toBeNull();
    unmount();

    renderBanners({
      topBannerKind: "fallback",
      pending: pendingAt("waiting"),
      pendingReturn: undefined,
      rateLimitAdvisory: null,
    });
    expect(screen.getByTestId("fallback-waiting-card")).toBeDefined();
    expect(screen.queryByTestId("fallback-grace-card")).toBeNull();
  });

  it("renders neither card for retrying even when the fallback slot is claimed", () => {
    renderBanners({
      topBannerKind: "fallback",
      pending: pendingAt("retrying"),
      pendingReturn: undefined,
      rateLimitAdvisory: null,
    });
    // Falsification: replace the two independent checks with a ternary else-branch and THIS assertion must go red.
    expect(screen.queryByTestId("fallback-grace-card")).toBeNull();
    expect(screen.queryByTestId("fallback-waiting-card")).toBeNull();
  });

  it("renders the return banner only in the fallback-return slot", () => {
    const offer = pendingReturn({
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      fallbackTuple: TARGET_CODEX_TUPLE,
      queuedItemsMoving: 0,
      traversalId: "traversal-return",
      revision: 1,
    });
    const { unmount } = renderBanners({
      topBannerKind: "fallback-return",
      pending: undefined,
      pendingReturn: offer,
      rateLimitAdvisory: null,
    });
    expect(screen.getByTestId("fallback-return-banner")).toBeDefined();
    unmount();

    renderBanners({
      topBannerKind: "none",
      pending: undefined,
      pendingReturn: offer,
      rateLimitAdvisory: null,
    });
    expect(screen.queryByTestId("fallback-return-banner")).toBeNull();
  });
});

describe("composerRateLimitAdvisory", () => {
  const current = providerProfile({
    profileId: "target01-profile",
    kind: "managed",
    label: "target01",
    authenticated: true,
  });

  it("is null when signed out, even for a visible prompt", () => {
    // Falsification: drop the signedOut check from composerRateLimitAdvisory and THIS assertion must go red.
    const prompt = visiblePrompt({
      providerId: "codex",
      severity: "near_limit",
      limitedFamilies: [],
      current,
    });
    expect(composerRateLimitAdvisory(prompt, true)).toBeNull();
  });

  it("is null for a hidden prompt", () => {
    const hidden: ProfileRateLimitSwitchPrompt = {
      kind: "hidden",
      dismiss: () => undefined,
    };
    expect(composerRateLimitAdvisory(hidden, false)).toBeNull();
  });

  it("reduces a visible prompt to providerId, profileId, severity, and limitedFamilies", () => {
    // Falsification: return the prompt's warningKey in place of profileCommitId(prompt.current) and THIS assertion must go red.
    const prompt = visiblePrompt({
      providerId: "codex",
      severity: "hard_limit",
      limitedFamilies: ["Fable"],
      current,
    });
    expect(composerRateLimitAdvisory(prompt, false)).toEqual({
      providerId: "codex",
      profileId: profileCommitId(current),
      severity: "hard_limit",
      limitedFamilies: ["Fable"],
    });
  });
});

describe("returnBannerLowUsage", () => {
  it("returns the reduced severity/limitedFamilies pair for a MATCHING advisory (same provider, same profile id)", () => {
    // Falsification: make returnBannerLowUsage return null unconditionally and THIS assertion must go red.
    const advisory: ComposerRateLimitAdvisory = {
      providerId: "codex",
      profileId: "target01-profile",
      severity: "near_limit",
      limitedFamilies: [],
    };
    expect(returnBannerLowUsage(advisory, TARGET_CODEX_TUPLE)).toEqual({
      severity: "near_limit",
      limitedFamilies: [],
    });
  });

  it("returns null on a MISMATCHED profile id, same provider", () => {
    // Falsification: compare only providerId (drop the profileId check) and THIS assertion must go red.
    const advisory: ComposerRateLimitAdvisory = {
      providerId: "codex",
      profileId: "some-other-profile",
      severity: "near_limit",
      limitedFamilies: [],
    };
    expect(returnBannerLowUsage(advisory, TARGET_CODEX_TUPLE)).toBeNull();
  });

  it("returns null on a MISMATCHED provider even though both profileIds are ambient (null) - the ambient trap", () => {
    // Falsification: compare only profileId (drop the provider check) and THIS assertion must go red, since both sides are null here.
    const ambientCodexFallback = chatRunSettings({
      harnessId: "codex",
      model: "gpt-5",
      profileId: null,
    });
    const advisory: ComposerRateLimitAdvisory = {
      providerId: "claude-code",
      profileId: null,
      severity: "hard_limit",
      limitedFamilies: [],
    };
    expect(returnBannerLowUsage(advisory, ambientCodexFallback)).toBeNull();
  });

  it("returns null for a null advisory", () => {
    expect(returnBannerLowUsage(null, TARGET_CODEX_TUPLE)).toBeNull();
  });
});

describe("ChatComposerFallbackBanners rate-limit advisory absorption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function returnOfferOn(fallbackTuple: ChatRunSettings) {
    return pendingReturn({
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      fallbackTuple,
      queuedItemsMoving: 0,
      traversalId: "traversal-return-advisory",
      revision: 1,
    });
  }

  it("folds a MATCHING advisory (same provider, same profile id) into the return banner's clause", () => {
    // Falsification: make returnBannerLowUsage return null unconditionally and THIS assertion must go red.
    renderBanners({
      topBannerKind: "fallback-return",
      pending: undefined,
      pendingReturn: returnOfferOn(TARGET_CODEX_TUPLE),
      rateLimitAdvisory: {
        providerId: "codex",
        profileId: "target01-profile",
        severity: "near_limit",
        limitedFamilies: [],
      },
    });
    expect(screen.getByTestId("fallback-return-banner").textContent).toMatch(
      /running low/,
    );
  });

  it("drops the clause on a MISMATCHED profile id, same provider", () => {
    // Falsification: compare only providerId in returnBannerLowUsage and THIS assertion must go red.
    renderBanners({
      topBannerKind: "fallback-return",
      pending: undefined,
      pendingReturn: returnOfferOn(TARGET_CODEX_TUPLE),
      rateLimitAdvisory: {
        providerId: "codex",
        profileId: "some-other-profile",
        severity: "near_limit",
        limitedFamilies: [],
      },
    });
    expect(
      screen.getByTestId("fallback-return-banner").textContent,
    ).not.toMatch(/running low|reached its/);
  });

  it("drops the clause on a MISMATCHED provider even though both profileIds are ambient (null) - the ambient trap", () => {
    // Falsification: compare only profileId in returnBannerLowUsage (drop the provider check) and THIS assertion must go red, since both sides are null here.
    const ambientCodexFallback = chatRunSettings({
      harnessId: "codex",
      model: "gpt-5",
      profileId: null,
    });
    renderBanners({
      topBannerKind: "fallback-return",
      pending: undefined,
      pendingReturn: returnOfferOn(ambientCodexFallback),
      rateLimitAdvisory: {
        providerId: "claude-code",
        profileId: null,
        severity: "hard_limit",
        limitedFamilies: [],
      },
    });
    expect(
      screen.getByTestId("fallback-return-banner").textContent,
    ).not.toMatch(/running low|reached its/);
  });

  it("shows no clause when rateLimitAdvisory is null", () => {
    renderBanners({
      topBannerKind: "fallback-return",
      pending: undefined,
      pendingReturn: returnOfferOn(TARGET_CODEX_TUPLE),
      rateLimitAdvisory: null,
    });
    expect(
      screen.getByTestId("fallback-return-banner").textContent,
    ).not.toMatch(/running low|reached its/);
  });
});
