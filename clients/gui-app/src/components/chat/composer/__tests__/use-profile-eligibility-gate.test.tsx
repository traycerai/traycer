import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileEligibilityGate } from "../use-profile-eligibility-gate";

const mocks = vi.hoisted(() => ({
  pendingProfileId: null as string | null,
  enableProfile: vi.fn(),
  providers: [
    {
      providerId: "claude-code",
      profiles: [
        {
          profileId: "work-profile",
          label: "Work",
          enabled: true,
        },
      ],
    },
  ],
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: { providers: mocks.providers },
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-profile-enabled-mutation", () => ({
  useProvidersSetProfileEnabledForClient: () => ({
    mutate: mocks.enableProfile,
  }),
  useProviderProfileEnablementPending: () => (profileId: string | null) =>
    profileId === mocks.pendingProfileId,
}));

describe("useProfileEligibilityGate", () => {
  beforeEach(() => {
    mocks.pendingProfileId = null;
    mocks.enableProfile.mockClear();
  });

  afterEach(() => cleanup());

  it("keeps composer send disabled while the selected profile settles, even with optimistic enabled data", () => {
    const rendered = renderHook(() =>
      useProfileEligibilityGate(null, "claude", "work-profile", true),
    );

    expect(rendered.result.current.disabled).toBe(false);

    act(() => {
      mocks.pendingProfileId = "work-profile";
      rendered.rerender();
    });
    expect(rendered.result.current.enablePending).toBe(true);
    expect(rendered.result.current.disabled).toBe(true);
    expect(rendered.result.current.profileLabel).toBe("Work");

    act(() => {
      rendered.result.current.enableProfile();
    });
    expect(mocks.enableProfile).not.toHaveBeenCalled();

    act(() => {
      // The host has settled and the refetched catalog still reports the
      // profile enabled; only now may the composer reopen Send.
      mocks.pendingProfileId = null;
      rendered.rerender();
    });
    expect(rendered.result.current.enablePending).toBe(false);
    expect(rendered.result.current.disabled).toBe(false);
  });
});
