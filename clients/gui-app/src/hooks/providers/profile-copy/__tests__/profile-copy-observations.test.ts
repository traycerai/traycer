import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import {
  clearProfileCopyObservations,
  observeProfileCopyOutcome,
} from "@/hooks/providers/profile-copy/profile-copy-observations";
import {
  ATTEMPT_TWO_ID,
  DEST_HOST_ID,
  profileCopyAttempt,
  recordedOutcome,
  SCOPED_HOST_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";

describe("observeProfileCopyOutcome", () => {
  beforeEach(() => {
    clearProfileCopyObservations();
  });
  afterEach(() => {
    clearProfileCopyObservations();
    vi.restoreAllMocks();
  });

  it("reports a settled attempt exactly once per window", () => {
    const queryClient = createAppQueryClient();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const outcome = recordedOutcome({ state: "signed-in", reason: null });

    observeProfileCopyOutcome(queryClient, outcome);
    observeProfileCopyOutcome(queryClient, outcome);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      AnalyticsEvent.ProfileCopyAttemptSettled,
      {
        provider: "claude-code",
        state: "signed-in",
        reason: "none",
      },
    );
  });

  it("invalidates the destination's provider queries exactly once on first promotion", () => {
    const queryClient = createAppQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const outcome = recordedOutcome({
      state: "signed-in",
      attempt: profileCopyAttempt({ destinationHostId: DEST_HOST_ID }),
    });

    observeProfileCopyOutcome(queryClient, outcome);
    observeProfileCopyOutcome(queryClient, {
      ...outcome,
      revision: outcome.revision + 1,
    });

    const destinationScopes = PROVIDER_INVALIDATIONS.map((method) =>
      hostQueryKeys.methodScope(DEST_HOST_ID, method),
    );
    const destinationCalls = invalidate.mock.calls.filter((call) =>
      destinationScopes.some(
        (scope) => JSON.stringify(call[0]?.queryKey) === JSON.stringify(scope),
      ),
    );
    expect(destinationCalls).toHaveLength(PROVIDER_INVALIDATIONS.length);
    expect(
      invalidate.mock.calls.some((call) => {
        const queryKey = call[0]?.queryKey;
        return Array.isArray(queryKey) && queryKey.includes(SCOPED_HOST_ID);
      }),
    ).toBe(false);
  });

  it("does not treat a second attempt as the first", () => {
    const queryClient = createAppQueryClient();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    observeProfileCopyOutcome(
      queryClient,
      recordedOutcome({ state: "signed-in" }),
    );
    observeProfileCopyOutcome(
      queryClient,
      recordedOutcome({
        state: "signed-in",
        attempt: profileCopyAttempt({ attemptId: ATTEMPT_TWO_ID }),
      }),
    );
    expect(track).toHaveBeenCalledTimes(2);
  });
});
