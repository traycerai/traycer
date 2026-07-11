import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";

/**
 * D2 + D3 (durability audit):
 *
 * D2 - "Rate-limit banner offers profile B; B becomes hard-limited/removed/
 * signed-out BEFORE the user clicks: click must re-validate, not
 * blind-commit."
 *
 * D3 - "ALL profiles of the provider hard-limited: banner/send behavior sane
 * (no infinite prompt loop, no auto-anything)."
 *
 * `useProfileRateLimitSwitchPrompt` + `ProfileRateLimitSwitchBanner` +
 * `onSwitchProfile` (chat-composer.tsx) are exercised together with the real
 * `useProviderReauthGate`, mirroring exactly how `chat-composer.tsx` wires
 * them: the reauth gate takes priority over the rate-limit banner, and a
 * profile commit routes through the SAME `profileId` state both hooks read.
 */

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  refresh: vi.fn(() => Promise.resolve()),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  // Mirrors the production hook's `activity.enabled` gate; reads
  // `mocks.providers` fresh on every render (a live pointer, not a snapshot),
  // so committing a profile switch and re-rendering picks up whatever the
  // test has mutated `mocks.providers` to in the meantime - exactly like a
  // real TanStack Query cache update would.
  useTabProvidersList: (activity: { enabled: boolean }) =>
    activity.enabled
      ? { data: { providers: mocks.providers } }
      : { data: undefined },
}));
vi.mock("@/hooks/providers/use-tab-refresh-providers", () => ({
  useTabRefreshProviders: () => mocks.refresh,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { useProviderReauthGate } from "../use-provider-reauth-gate";
import { useProfileRateLimitSwitchPrompt } from "../use-profile-rate-limit-switch-prompt";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";
import { resolveComposerTopBannerKind } from "../chat-composer-top-banner";

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  rateLimitStatus: ProviderProfileRateLimitStatus,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function unauthenticated(candidate: ProviderProfile): ProviderProfile {
  return {
    ...candidate,
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
  };
}

function driftedAmbient(
  rateLimitStatus: ProviderProfileRateLimitStatus,
): ProviderProfile {
  const ambient = profile(
    "ambient",
    "ambient",
    "Terminal account",
    rateLimitStatus,
  );
  return {
    ...ambient,
    identity: {
      email: "new-terminal@example.test",
      tier: null,
      accountUuid: null,
    },
    ambientDriftNotice: {
      previousEmail: "old-terminal@example.test",
      changedAt: 1735689600000,
    },
  };
}

function claudeState(profiles: ProviderProfile[]): ProviderCliState {
  const providerId: ProviderId = "claude-code";
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles,
  };
}

/**
 * Minimal stand-in for the relevant slice of `chat-composer.tsx`: a
 * `profileId` bit of state that a switch commits into (mirrors
 * `commitSelection` writing into the toolbar store), the real reauth gate,
 * and the real rate-limit prompt + banner - wired with the exact same
 * priority order chat-composer.tsx uses (reauth banner wins, rate-limit
 * banner only shows when NOT signed out).
 */
function ComposerProfileSwitchHarness() {
  const [profileId, setProfileId] = useState<string | null>(null);
  // `authoritative: true` - this harness models a committed selection (a
  // real user-driven switch), not a fallback seed, so the banner-flash gate
  // (a different mechanism than what D2/D3 test) never suppresses it here.
  const reauthGate = useProviderReauthGate(
    "claude",
    profileId,
    true,
    "authoritative",
  );
  const rateLimitPrompt = useProfileRateLimitSwitchPrompt(
    "claude",
    profileId,
    true,
  );
  const onSwitchProfile = useCallback((next: string | null) => {
    setProfileId(next);
  }, []);

  return (
    <div>
      <div data-testid="profile-id">{profileId ?? "ambient"}</div>
      <div data-testid="send-blocked">{String(reauthGate.signedOut)}</div>
      <div data-testid="reauth-reason">{reauthGate.reason ?? "none"}</div>
      <div data-testid="banner-visible">
        {String(!reauthGate.signedOut && rateLimitPrompt.limited)}
      </div>
      {!reauthGate.signedOut && rateLimitPrompt.limited ? (
        <ProfileRateLimitSwitchBanner
          harnessId="claude"
          hardLimited={rateLimitPrompt.hardLimited}
          current={rateLimitPrompt.current}
          alternatives={rateLimitPrompt.alternatives}
          onSwitchProfile={onSwitchProfile}
          onDismiss={rateLimitPrompt.dismiss}
        />
      ) : null}
    </div>
  );
}

function ComposerBannerPrecedenceHarness({
  onSubmit,
}: {
  readonly onSubmit: () => void;
}) {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [pendingAmbientDrift, setPendingAmbientDrift] = useState(false);
  const [acknowledgedAmbientDrift, setAcknowledgedAmbientDrift] =
    useState(false);
  const reauthGate = useProviderReauthGate(
    "claude",
    profileId,
    true,
    "authoritative",
  );
  const rateLimitPrompt = useProfileRateLimitSwitchPrompt(
    "claude",
    profileId,
    true,
  );
  const driftVisible = pendingAmbientDrift && !acknowledgedAmbientDrift;
  const topBannerKind = resolveComposerTopBannerKind({
    reauthVisible: reauthGate.signedOut,
    ambientDriftVisible: driftVisible,
    rateLimitVisible: !reauthGate.signedOut && rateLimitPrompt.limited,
  });

  const submit = (): void => {
    if (!acknowledgedAmbientDrift) {
      setPendingAmbientDrift(true);
      return;
    }
    if (rateLimitPrompt.limited) return;
    onSubmit();
  };

  const acknowledgeDrift = (): void => {
    setAcknowledgedAmbientDrift(true);
    setPendingAmbientDrift(false);
    if (rateLimitPrompt.limited) return;
    onSubmit();
  };

  return (
    <div>
      <button type="button" onClick={submit}>
        Send
      </button>
      <div data-testid="top-banner-kind">{topBannerKind}</div>
      {topBannerKind === "ambient-drift" ? (
        <div role="alert">
          <span>Terminal account changed</span>
          <button type="button" onClick={acknowledgeDrift}>
            Continue with Terminal account
          </button>
        </div>
      ) : null}
      {topBannerKind === "rate-limit" ? (
        <ProfileRateLimitSwitchBanner
          harnessId="claude"
          hardLimited={rateLimitPrompt.hardLimited}
          current={rateLimitPrompt.current}
          alternatives={rateLimitPrompt.alternatives}
          onSwitchProfile={setProfileId}
          onDismiss={rateLimitPrompt.dismiss}
        />
      ) : null}
    </div>
  );
}

describe("D2: rate-limit switch prompt race (stale click vs. live re-validation)", () => {
  beforeEach(() => {
    mocks.providers = [];
    mocks.refresh.mockClear();
    mocks.toastSuccess.mockClear();
    mocks.toastError.mockClear();
  });

  it("shows ambient drift before rate-limit and moves to rate-limit after acknowledging drift without submitting", () => {
    const submit = vi.fn();
    mocks.providers = [
      claudeState([
        driftedAmbient("hard_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];

    render(<ComposerBannerPrecedenceHarness onSubmit={submit} />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByTestId("top-banner-kind").textContent).toBe(
      "ambient-drift",
    );
    expect(screen.getByText("Terminal account changed")).toBeDefined();
    expect(
      screen.queryByRole("button", {
        name: "Continue this session on Work",
      }),
    ).toBeNull();
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Continue with Terminal account",
      }),
    );

    expect(screen.getByTestId("top-banner-kind").textContent).toBe(
      "rate-limit",
    );
    expect(screen.queryByText("Terminal account changed")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Continue this session on Work",
      }),
    ).toBeDefined();
    expect(submit).not.toHaveBeenCalled();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("dismisses the current suggestion without switching profiles and shows a new severity", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "near_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    const { rerender } = render(<ComposerProfileSwitchHarness />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Dismiss rate limit suggestion",
      }),
    );

    expect(screen.getByTestId("banner-visible").textContent).toBe("false");
    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
    expect(
      screen.queryByRole("button", { name: /Continue this session on/ }),
    ).toBeNull();

    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    rerender(<ComposerProfileSwitchHarness />);

    expect(screen.getByTestId("banner-visible").textContent).toBe("true");
    expect(
      screen.getByRole("button", { name: "Continue this session on Work" }),
    ).toBeDefined();
  });

  it("REMOVED between render and click: the click still blindly commits (no click-time re-validation), but the downstream reauth gate catches it on the very next render and blocks send", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    render(<ComposerProfileSwitchHarness />);

    expect(screen.getByTestId("banner-visible").textContent).toBe("true");
    const switchButton = screen.getByRole("button", {
      name: "Continue this session on Work",
    });

    // Profile B ("work-uuid") is removed entirely BEFORE the click fires -
    // simulating it being torn down concurrently (host-side removal, or
    // another tab/window's action) between the banner rendering and the
    // user's click landing. The mock hook re-reads `mocks.providers` on every
    // render, but nothing re-renders this component until the click's own
    // state update - so the button the user clicks is still bound to the
    // stale `alternative.profileId` captured at the last render.
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
      ]),
    ];

    fireEvent.click(switchButton);

    // The commit is blind: `onSwitchProfile` (mirroring chat-composer.tsx's
    // real callback, which only calls `commitSelection`) unconditionally
    // writes "work-uuid" with no re-check against live provider state.
    expect(screen.getByTestId("profile-id").textContent).toBe("work-uuid");

    // But the SAME render that committed the switch also re-evaluates
    // `useProviderReauthGate` with the new profileId against the (now
    // mutated) live provider list - "work-uuid" no longer exists, so it
    // reports profile_missing and blocks send. The composer never actually
    // lands a doomed turn on a dead profile without a gate catching it.
    expect(screen.getByTestId("send-blocked").textContent).toBe("true");
    expect(screen.getByTestId("reauth-reason").textContent).toBe(
      "profile_missing",
    );
  });

  it("UNAUTHENTICATED between render and click: same blind-commit-then-caught pattern", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    render(<ComposerProfileSwitchHarness />);
    const switchButton = screen.getByRole("button", {
      name: "Continue this session on Work",
    });

    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        unauthenticated(profile("work-uuid", "managed", "Work", "ok")),
      ]),
    ];
    fireEvent.click(switchButton);

    expect(screen.getByTestId("profile-id").textContent).toBe("work-uuid");
    expect(screen.getByTestId("send-blocked").textContent).toBe("true");
    expect(screen.getByTestId("reauth-reason").textContent).toBe(
      "profile_unauthenticated",
    );
  });

  it("documents the residual gap: a target that merely goes HARD-LIMITED (not removed/unauthenticated) between render and click is committed AND stays unblocked - rate limits are informational-only by design, never a send gate", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    render(<ComposerProfileSwitchHarness />);
    const switchButton = screen.getByRole("button", {
      name: "Continue this session on Work",
    });

    // Work becomes hard-limited (but stays authenticated) before the click.
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "hard_limit"),
      ]),
    ];
    fireEvent.click(switchButton);

    expect(screen.getByTestId("profile-id").textContent).toBe("work-uuid");
    // Not blocked - `useProviderReauthGate` only inspects auth status, never
    // rate-limit status, matching the documented design ("purely
    // informational + user-confirmed, so it never blocks send the way the
    // reauth gate does"). The re-render's OWN rate-limit prompt would now
    // offer switching again (since "work-uuid" itself is limited), but
    // nothing sends automatically and nothing crashes.
    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
  });
});

describe("D3: every profile of the provider is hard-limited", () => {
  beforeEach(() => {
    mocks.providers = [];
  });
  afterEach(() => {
    cleanup();
  });

  it("renders no switch banner at all when there is no viable alternative (progressive disclosure gate: limited requires >=1 non-limited alternative)", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "hard_limit"),
        profile("personal-uuid", "managed", "Personal", "hard_limit"),
      ]),
    ];
    render(<ComposerProfileSwitchHarness />);

    expect(screen.getByTestId("banner-visible").textContent).toBe("false");
    expect(
      screen.queryByRole("button", { name: /Continue this session on/ }),
    ).toBeNull();
  });

  it("does not get stuck re-rendering or auto-switching across repeated re-renders with an all-limited provider", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "hard_limit"),
      ]),
    ];
    const { rerender } = render(<ComposerProfileSwitchHarness />);
    for (let i = 0; i < 20; i++) {
      act(() => {
        rerender(<ComposerProfileSwitchHarness />);
      });
    }
    expect(screen.getByTestId("banner-visible").textContent).toBe("false");
    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
  });
});
