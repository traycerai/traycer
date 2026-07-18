import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Real-hook coverage for `useAmbientDriftGate` (use-ambient-drift-gate.ts).
 *
 * `profile-durability-d2-d3-rate-limit-switch.test.tsx`'s
 * `ComposerBannerPrecedenceHarness` fakes the ambient-drift gate inline (its
 * own local `useState` pair) rather than exercising the real hook - this file
 * drives the real implementation directly, including the durable-ack mutation
 * it now fires on Continue/Dismiss.
 */

const mocks = vi.hoisted(() => ({
  acknowledgeMutate: vi.fn(),
}));

vi.mock("@/hooks/providers/use-acknowledge-ambient-drift-mutation", () => ({
  useAcknowledgeAmbientDriftForClient: () => ({
    mutate: mocks.acknowledgeMutate,
  }),
}));

import { useAmbientDriftGate } from "../use-ambient-drift-gate";

function ambientProfile(
  driftNotice: ProviderProfile["ambientDriftNotice"],
): ProviderProfile {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: "new-terminal@example.test",
      tier: null,
      accountUuid: null,
    },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: driftNotice,
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

const NOTICE_A = { previousEmail: "old-terminal@example.test", changedAt: 100 };
const NOTICE_B = { previousEmail: "new-terminal@example.test", changedAt: 200 };

describe("useAmbientDriftGate", () => {
  beforeEach(() => {
    mocks.acknowledgeMutate.mockClear();
  });

  it("Continue: fires the acknowledge mutation and submits immediately, without awaiting the RPC", () => {
    const state = claudeState([ambientProfile(NOTICE_A)]);
    const { result } = renderHook(() => useAmbientDriftGate(null, state, null));

    const submit = vi.fn();
    act(() => {
      result.current.guardSubmit(submit);
    });
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.pendingNotice).not.toBeNull();

    act(() => {
      result.current.acknowledge(submit);
    });

    // Submit ran synchronously - Continue does not wait on the mutation.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeMutate).toHaveBeenCalledWith({
      providerId: "claude-code",
    });
    expect(result.current.pendingNotice).toBeNull();
  });

  it("Dismiss: fires the acknowledge mutation without submitting", () => {
    const state = claudeState([ambientProfile(NOTICE_A)]);
    const { result } = renderHook(() => useAmbientDriftGate(null, state, null));

    const submit = vi.fn();
    act(() => {
      result.current.guardSubmit(submit);
    });
    expect(result.current.pendingNotice).not.toBeNull();

    act(() => {
      result.current.dismiss();
    });

    expect(submit).not.toHaveBeenCalled();
    expect(mocks.acknowledgeMutate).toHaveBeenCalledWith({
      providerId: "claude-code",
    });
    expect(result.current.pendingNotice).toBeNull();
  });

  it("acknowledged banner stays hidden across a providers.list refetch that returns the SAME notice", () => {
    const state = claudeState([ambientProfile(NOTICE_A)]);
    const { result, rerender } = renderHook(
      ({ providerState }) => useAmbientDriftGate(null, providerState, null),
      { initialProps: { providerState: state } },
    );

    act(() => {
      result.current.guardSubmit(vi.fn());
    });
    act(() => {
      result.current.acknowledge(() => {});
    });
    expect(result.current.pendingNotice).toBeNull();

    // A `providers.list` refetch that lands a freshly-constructed but
    // identity-equal state object (same `changedAt`) - the dead-ack-wiring
    // bug this hardens against reset acknowledgment on ANY re-render, not
    // just a remount.
    const refetchedSameNotice = claudeState([ambientProfile(NOTICE_A)]);
    rerender({ providerState: refetchedSameNotice });

    const submitAfterRefetch = vi.fn();
    act(() => {
      result.current.guardSubmit(submitAfterRefetch);
    });

    expect(submitAfterRefetch).toHaveBeenCalledTimes(1);
    expect(result.current.pendingNotice).toBeNull();
  });

  it("banner re-shows for a genuinely new changedAt after a prior notice was acknowledged", () => {
    const state = claudeState([ambientProfile(NOTICE_A)]);
    const { result, rerender } = renderHook(
      ({ providerState }) => useAmbientDriftGate(null, providerState, null),
      { initialProps: { providerState: state } },
    );

    act(() => {
      result.current.guardSubmit(vi.fn());
    });
    act(() => {
      result.current.acknowledge(() => {});
    });
    expect(result.current.pendingNotice).toBeNull();

    const driftedAgain = claudeState([ambientProfile(NOTICE_B)]);
    rerender({ providerState: driftedAgain });

    const submitAfterNewDrift = vi.fn();
    act(() => {
      result.current.guardSubmit(submitAfterNewDrift);
    });

    expect(submitAfterNewDrift).not.toHaveBeenCalled();
    expect(result.current.pendingNotice?.previousEmail).toBe(
      NOTICE_B.previousEmail,
    );
  });
});
