import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProfileDropdownUsageEntry } from "@/components/providers/profile-dropdown-usage";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { TooltipProvider } from "@/components/ui/tooltip";

const usage = vi.hoisted(() => ({
  isHostReady: true,
  entries: new Map() as Map<string | null, ProfileDropdownUsageEntry>,
}));

vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => ({
    isHostReady: usage.isHostReady,
    entries: usage.entries,
  }),
}));

import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";
import type { ProfileRateLimitDestination } from "../use-profile-rate-limit-switch-prompt";

function profile(
  profileId: string,
  label: string,
  rateLimitStatus: ProviderProfile["rateLimitStatus"],
): ProviderProfile {
  return {
    profileId,
    kind: "managed",
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
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function destination(
  candidate: ProviderProfile,
  selectable: boolean,
): ProfileRateLimitDestination {
  return {
    profile: candidate,
    profileId: profileCommitId(candidate),
    selectable,
  };
}

function usageEntry(
  profileId: string | null,
  ensureFresh: () => Promise<void>,
  fetchEligible: boolean,
): ProfileDropdownUsageEntry {
  return {
    profileId,
    fetchEligible,
    refreshStatus: "idle",
    refresh: () => Promise.resolve(),
    ensureFresh,
    projection: {
      kind: "not_checked",
      severity: "unknown",
      compactWindow: null,
      windows: [],
      checkedAt: null,
    },
  };
}

const CURRENT = profile("limited-uuid", "Limited", "hard_limit");
const UNKNOWN = profile("unknown-uuid", "Unknown", "unknown");
const HEALTHY = profile("healthy-uuid", "Healthy", "ok");

function renderBanner(input: {
  readonly destinations: ReadonlyArray<ProfileRateLimitDestination>;
  readonly primaryTarget: ProfileRateLimitDestination | null;
  readonly probeTarget: ProfileRateLimitDestination | null;
}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ProfileRateLimitSwitchBanner
        harnessId="claude"
        providerId="claude-code"
        severity="hard_limit"
        limitedFamilies={[]}
        current={CURRENT}
        profiles={[CURRENT, ...input.destinations.map((d) => d.profile)]}
        destinations={input.destinations}
        primaryTarget={input.primaryTarget}
        probeTarget={input.probeTarget}
        runTargetHostId={null}
        onSwitchProfile={() => undefined}
        affectedChatCount={1}
        onSwitchProfileForTask={() => undefined}
        onDismiss={() => undefined}
      />
    </TooltipProvider>,
  );
}

describe("ProfileRateLimitSwitchBanner automatic unknown-destination check", () => {
  beforeEach(() => {
    usage.isHostReady = true;
    usage.entries = new Map();
  });
  afterEach(cleanup);

  it("spends exactly one ensureFresh on the probe target, surviving rerenders", () => {
    const ensureFresh = vi.fn(() => Promise.resolve());
    usage.entries.set(
      "unknown-uuid",
      usageEntry("unknown-uuid", ensureFresh, true),
    );
    const unknownDestination = destination(UNKNOWN, false);

    const { rerender } = renderBanner({
      destinations: [unknownDestination],
      primaryTarget: null,
      probeTarget: unknownDestination,
    });
    expect(ensureFresh).toHaveBeenCalledTimes(1);

    rerender(
      <TooltipProvider delayDuration={0}>
        <ProfileRateLimitSwitchBanner
          harnessId="claude"
          providerId="claude-code"
          severity="hard_limit"
          limitedFamilies={[]}
          current={CURRENT}
          profiles={[CURRENT, UNKNOWN]}
          destinations={[unknownDestination]}
          primaryTarget={null}
          probeTarget={unknownDestination}
          runTargetHostId={null}
          onSwitchProfile={() => undefined}
          affectedChatCount={1}
          onSwitchProfileForTask={() => undefined}
          onDismiss={() => undefined}
        />
      </TooltipProvider>,
    );
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it("makes no automatic check when a known primary target already exists", () => {
    const ensureFresh = vi.fn(() => Promise.resolve());
    usage.entries.set(
      "unknown-uuid",
      usageEntry("unknown-uuid", ensureFresh, true),
    );
    usage.entries.set(
      "healthy-uuid",
      usageEntry("healthy-uuid", () => Promise.resolve(), true),
    );
    const healthyDestination = destination(HEALTHY, true);

    renderBanner({
      destinations: [destination(UNKNOWN, false), healthyDestination],
      primaryTarget: healthyDestination,
      // The hook only nominates a probeTarget when no primary exists; the
      // banner also receives null here and must not check anything.
      probeTarget: null,
    });
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it("does not retry or cascade after a failed check", () => {
    const ensureFresh = vi.fn(() => Promise.reject(new Error("429")));
    usage.entries.set(
      "unknown-uuid",
      usageEntry("unknown-uuid", ensureFresh, true),
    );
    const unknownDestination = destination(UNKNOWN, false);

    const { rerender } = renderBanner({
      destinations: [unknownDestination],
      primaryTarget: null,
      probeTarget: unknownDestination,
    });
    expect(ensureFresh).toHaveBeenCalledTimes(1);

    rerender(
      <TooltipProvider delayDuration={0}>
        <ProfileRateLimitSwitchBanner
          harnessId="claude"
          providerId="claude-code"
          severity="hard_limit"
          limitedFamilies={[]}
          current={CURRENT}
          profiles={[CURRENT, UNKNOWN]}
          destinations={[unknownDestination]}
          primaryTarget={null}
          probeTarget={unknownDestination}
          runTargetHostId={null}
          onSwitchProfile={() => undefined}
          affectedChatCount={1}
          onSwitchProfileForTask={() => undefined}
          onDismiss={() => undefined}
        />
      </TooltipProvider>,
    );
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it("waits for the host to be ready instead of spending the check into the void", () => {
    const ensureFresh = vi.fn(() => Promise.resolve());
    usage.entries.set(
      "unknown-uuid",
      usageEntry("unknown-uuid", ensureFresh, true),
    );
    usage.isHostReady = false;
    const unknownDestination = destination(UNKNOWN, false);

    renderBanner({
      destinations: [unknownDestination],
      primaryTarget: null,
      probeTarget: unknownDestination,
    });
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it("defers the one automatic check until the probe target becomes fetch-eligible", () => {
    const ensureFresh = vi.fn(() => Promise.resolve());
    const unknownDestination = destination(UNKNOWN, false);
    usage.entries.set(
      "unknown-uuid",
      usageEntry("unknown-uuid", ensureFresh, false),
    );

    const { rerender } = renderBanner({
      destinations: [unknownDestination],
      primaryTarget: null,
      probeTarget: unknownDestination,
    });
    expect(ensureFresh).not.toHaveBeenCalled();

    usage.entries.set(
      "unknown-uuid",
      usageEntry("unknown-uuid", ensureFresh, true),
    );
    rerender(
      <TooltipProvider delayDuration={0}>
        <ProfileRateLimitSwitchBanner
          harnessId="claude"
          providerId="claude-code"
          severity="hard_limit"
          limitedFamilies={[]}
          current={CURRENT}
          profiles={[CURRENT, UNKNOWN]}
          destinations={[unknownDestination]}
          primaryTarget={null}
          probeTarget={unknownDestination}
          runTargetHostId={null}
          onSwitchProfile={() => undefined}
          affectedChatCount={1}
          onSwitchProfileForTask={() => undefined}
          onDismiss={() => undefined}
        />
      </TooltipProvider>,
    );
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it("does not advertise the refresh shortcut for an ineligible usage row", () => {
    const ensureFresh = vi.fn(() => Promise.resolve());
    const unknownDestination = destination(UNKNOWN, false);
    usage.entries.set(
      "unknown-uuid",
      usageEntry("unknown-uuid", ensureFresh, false),
    );

    renderBanner({
      destinations: [unknownDestination],
      primaryTarget: null,
      probeTarget: unknownDestination,
    });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "View profile limits" }),
    );
    expect(
      screen
        .getByRole("menuitem", { name: /Unknown/ })
        .getAttribute("aria-keyshortcuts"),
    ).toBeNull();
  });
});
